import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { state } from '../src/state.mjs';
import { advance, cycle, handoff } from '../src/operator.mjs';
import { developerPreview, dispatchDevelopment } from '../src/developer-queue.mjs';

const time = '2026-11-25T16:00:00Z';
const later = '2026-11-25T17:00:00Z';
const metadata = { id: 'metadata.required.description', severity: 'error', locale: 'en-CA' };
const source = { status: 'matched', development: { repo: 'owner/app', sha: 'a'.repeat(40), folder: 'ios', ref: 'HEAD' } };

function fixture(checks, candidateState = 'PREPARE_FOR_SUBMISSION') {
  return {
    app: { id: '123', name: 'Example' }, capturedAt: time, source, periods: { current: { end: time.slice(0, 10) } },
    store: { status: 'ok', data: { live: { id: 'old', version: '1.0' },
      candidate: { id: 'new', version: '1.1', state: candidateState } } },
    review: { status: 'ok', data: { versionId: 'new', summary: { blocking: checks.length }, checks } },
    decision: { recommendation: { finding: 'Open ASC' } },
  };
}

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ops-routing-'));
  const db = state(dir);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, db };
}

test('listing blockers stay with the operator and close only after matching ASC verification', (t) => {
  const { dir, db } = workspace(t);
  const before = fixture([metadata]);
  const config = { loop: { apps: { '123': { channels: ['youtube'] } } } };
  const result = cycle(db, [before], config, time);
  assert.deepEqual(result.queue.map((task) => task.kind), ['store-maintenance', 'promotion']);
  const task = db.operation(result.queue[0].id);
  assert.throws(() => handoff(db, task, dir, time), /development operations/);
  assert.throws(() => developerPreview(task, config), /verified development tasks/);
  const receipt = { action: 'store-resolved', versionId: 'new', field: 'description',
    before: '', after: 'Verified description', approvalReference: 'owner approval', evidence: 'Apple verification run',
    observedAt: '2026-11-25T16:30:00Z' };
  assert.throws(() => advance(db, task, receipt, { ...before, capturedAt: later }, later), /original checks passed/);
  const passed = advance(db, task, receipt, { ...fixture([]), capturedAt: later }, later);
  assert.equal(passed.status, 'closed');
  assert.equal(passed.outcome.versionId, 'new');
});

test('ambiguous review needs verified routing and developer tickets omit raw review text', (t) => {
  const { dir, db } = workspace(t);
  const scan = fixture([{ id: 'build.invalid.processing_state', severity: 'error' }], 'REJECTED');
  const result = cycle(db, [scan], {}, time);
  const initial = db.operation(result.queue[0].id);
  assert.equal(initial.kind, 'review-triage');
  assert.throws(() => handoff(db, initial, dir, time), /development operations/);
  const routed = advance(db, initial, {
    action: 'route-review', versionId: 'new', destination: 'developer', problem: 'Sync fails from cold start',
    proposedChange: 'Allow the signed-in data to load', userFlow: 'Open app offline, then reconnect',
    evidence: 'Private email and review evidence kept local', acceptance: ['Data is present after reconnect', 'No duplicate records'],
  }, scan, time);
  assert.equal(routed.owner, 'external-development');
  const preview = developerPreview(routed, { loop: { apps: { '123': {
    developmentQueue: { repository: 'owner/app', assignee: 'release-bot' },
  } } } });
  assert.match(preview.body, /No duplicate records/);
  assert.doesNotMatch(preview.body, /Private email/);
});

test('GitHub dispatch requires the exact preview and never retries an unconfirmed issue creation', (t) => {
  const { dir, db } = workspace(t);
  const config = { loop: { apps: { '123': { developmentQueue: { repository: 'owner/app', assignee: 'ios-bot' } } } } };
  const task = db.enqueue({ key: 'feature:test', kind: 'feature', status: 'queued', appId: '123', appName: 'Test',
    createdAt: time, target: source.development, problem: 'User cannot restore settings',
    proposedChange: 'Restore settings after relaunch', userFlow: 'Relaunch', acceptance: [{ id: 'REQ-1', criterion: 'Settings remain' }],
  }, time);
  const gh = join(dir, 'gh');
  writeFileSync(gh, `#!/usr/bin/env node
const args=process.argv.slice(2);
if (args[0]==='repo') console.log(JSON.stringify({nameWithOwner:'owner/app',hasIssuesEnabled:true}));
else if (args[1]==='create') {
  require('node:fs').appendFileSync(${JSON.stringify(join(dir, 'calls'))}, 'create\\n');
  if (!args.includes('ios-bot')) process.exit(3);
  const fs=require('node:fs');
  fs.writeFileSync(${JSON.stringify(join(dir, 'body'))}, fs.readFileSync(0,'utf8'));
  console.log('https://github.com/owner/app/issues/7');
} else if (args[1]==='view') {
  const body=require('node:fs').readFileSync(${JSON.stringify(join(dir, 'body'))},'utf8');
  console.log(JSON.stringify({url:args[2],body,assignees:[{login:'ios-bot'}]}));
}
`, { mode: 0o700 });
  const oldPath = process.env.PATH;
  t.after(() => { process.env.PATH = oldPath; });
  process.env.PATH = dir + ':' + oldPath;
  assert.throws(() => dispatchDevelopment(db, task, config, {}, time), /exact issue preview/);
  const preview = developerPreview(task, config);
  const approval = { fingerprint: preview.fingerprint, approvalReference: 'approved-preview' };
  assert.equal(dispatchDevelopment(db, task, config, approval, time).url, 'https://github.com/owner/app/issues/7');
  const sent = db.operation(task.id);
  assert.equal(sent.status, 'delegated');
  assert.equal(dispatchDevelopment(db, sent, config, approval, time).status, 'sent');
  assert.equal(db.operationEvents(task.id).filter((row) => row.event === 'dispatch-started').length, 1);
  const second = db.enqueue({ ...task, key: 'feature:second' }, time);
  const pendingPreview = developerPreview(second, config);
  const pending = db.updateOperation(second, { dispatch: { status: 'pending', fingerprint: pendingPreview.fingerprint } }, 'dispatch-started', time);
  assert.throws(() => dispatchDevelopment(db, pending, config, { ...approval, fingerprint: pendingPreview.fingerprint }, time), /uncertain/);
});
