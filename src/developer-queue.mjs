import { createHash } from 'node:crypto';
import { jsonCommand, run } from './io.mjs';
import { canHandoff } from './operator.mjs';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function compact(value) {
  return String(value).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
}

function receipt(value, repository) {
  const prefix = 'https://github.com/' + repository + '/issues/';
  if (!value.toLowerCase().startsWith(prefix.toLowerCase()) || !/^\d+$/.test(value.slice(prefix.length))) {
    throw new Error('GitHub did not return a matching issue URL');
  }
  return value;
}

export function developerPreview(task, config) {
  if (!canHandoff(task) || !['queued', 'delegated'].includes(task.status)) {
    throw new Error('Only verified development tasks can enter the developer issue queue');
  }
  const destination = config.loop?.apps?.[task.appId]?.developmentQueue;
  const repository = destination?.repository ?? '';
  if (!REPO.test(repository) || repository.toLowerCase() !== task.target?.repo?.toLowerCase()) {
    throw new Error('Configure a development queue for the exact verified GitHub repository');
  }
  const assignee = destination.assignee;
  if (!/^[A-Za-z\d](?:[A-Za-z\d-]{0,38})$/.test(assignee ?? '')) {
    throw new Error('Set the named human or bot account that receives development tasks');
  }
  const key = createHash('sha256').update(JSON.stringify([repository, task.appId, task.key, task.createdAt]))
    .digest('hex').slice(0, 20);
  const marker = '<!-- ios-ops:' + key + ' -->';
  const title = ('[iOS feedback] ' + compact(task.problem)).slice(0, 180);
  const evidence = (task.signals ?? []).map(({ kind, ref, date }) =>
    '- ' + compact(kind) + ' · ' + compact(date ?? 'undated') + ' · ref ' + compact(ref));
  const body = [
    marker, '## User problem', compact(task.problem),
    '## Requested behavior', compact(task.proposedChange), compact(task.userFlow),
    '## Target', 'App Store ID ' + task.appId, 'Git folder ' + compact(task.target.folder || '/'),
    'Base commit ' + task.target.sha, '## References', ...evidence,
    '## Acceptance', ...task.acceptance.map(({ id, criterion }) => '- ' + compact(id) + ' · ' + compact(criterion)),
    ...(task.impact ? ['## Follow-up metric', compact(task.impact.metric), compact(task.impact.scope)] : []),
    'Return the changed commit and proposed iOS version/build. Provide PASS, FAIL, or BLOCKED for every acceptance item with evidence. Release and promotion stay with the app operator.',
  ].join('\n\n');
  const fingerprint = createHash('sha256').update(JSON.stringify([repository, assignee, title, body])).digest('hex');
  return { repository, assignee, title, body, fingerprint, marker };
}

export function dispatchDevelopment(db, task, config, input, now) {
  if (task.dispatch?.url) return { status: 'sent', ...task.dispatch };
  const preview = developerPreview(task, config);
  if (input.fingerprint !== preview.fingerprint || typeof input.approvalReference !== 'string' ||
    !input.approvalReference.trim()) throw new Error('Review and approve the exact issue preview and destination before dispatch');
  if (task.assignee && task.assignee.toLowerCase() !== preview.assignee.toLowerCase()) {
    throw new Error('The existing development assignee differs from the GitHub queue');
  }
  let claimed = task;
  let url;
  if (task.dispatch?.status === 'pending') {
    if (task.dispatch.fingerprint !== preview.fingerprint || !/^https:\/\/github\.com\//.test(input.recoverIssue ?? '')) {
      throw new Error('Previous GitHub result is uncertain. Check the repository and provide the observed issue URL for recovery.');
    }
    const issueUrl = receipt(input.recoverIssue, preview.repository);
    url = issueUrl;
  } else {
    // Record the outbound attempt before any write. A timeout never re-creates the issue.
    const repository = jsonCommand('gh', ['repo', 'view', preview.repository, '--json', 'nameWithOwner,hasIssuesEnabled']);
    if (repository.nameWithOwner?.toLowerCase() !== preview.repository.toLowerCase() || !repository.hasIssuesEnabled) {
      throw new Error('Verify that this exact repository accepts issues');
    }
    claimed = db.updateOperation(task, { dispatch: {
      status: 'pending', fingerprint: preview.fingerprint, approvalReference: input.approvalReference,
    } }, 'dispatch-started', now);
    url = receipt(run('gh', ['issue', 'create', '--repo', preview.repository, '--assignee', preview.assignee,
      '--title', preview.title, '--body-file', '-'], { input: preview.body }).trim(), preview.repository);
  }
  const found = jsonCommand('gh', ['issue', 'view', url, '--json', 'url,body,assignees']);
  if (found.url !== url || !found.body?.includes(preview.marker) ||
    !found.assignees?.some(({ login }) => login.toLowerCase() === preview.assignee.toLowerCase())) {
    throw new Error('Confirm the created issue and named assignee before recording the dispatch');
  }
  const dispatch = { status: 'sent', url, repository: preview.repository, assignee: preview.assignee,
    approvalReference: claimed.dispatch.approvalReference, fingerprint: preview.fingerprint };
  db.updateOperation(claimed, { status: 'delegated', assignee: preview.assignee, dispatch }, 'dispatched-development', now);
  return dispatch;
}
