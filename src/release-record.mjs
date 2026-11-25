// Release provenance for promotional claims. A matching Git tag is one source; an
// owner/CI release record whose commit is verified in the matched source history is another.
import { run } from './io.mjs';
import { assertEvidenceApp } from './app-context.mjs';

const SHA = /^[a-f0-9]{40}$/i;
const BASES = ['owner-confirmed', 'ci-build-record', 'xcode-archive'];
const text = (x, n = 1000) => typeof x === 'string' && x.trim().length > 0 && x.length <= n;

export function confirmRelease(db, scan, id, input, now) {
  assertEvidenceApp(id, input);
  const live = scan?.store?.data?.live;
  const age = Date.parse(now) - Date.parse(scan?.capturedAt);
  if (scan?.app?.id !== id || scan.store?.status !== 'ok' || !live || input.version !== live.version ||
    (input.build !== undefined && String(input.build) !== String(live.buildNumber ?? '')) ||
    !Number.isFinite(age) || age < 0 || age > 72 * 3_600_000) {
    throw new Error('Confirm the release for the current live App Store version (and build) from a scan under 72 hours old');
  }
  const dev = scan.source?.development;
  if (scan.source?.status !== 'matched' || !dev?.path || !SHA.test(dev.sha ?? '')) {
    throw new Error('Resolve the matched app source before confirming a release commit');
  }
  if (!SHA.test(input.commit ?? '') || !BASES.includes(input.basis) || !text(input.evidence) || !text(input.confirmedBy, 120)) {
    throw new Error('Provide a 40-character commit, basis (' + BASES.join(', ') + '), evidence and confirmedBy');
  }
  try {
    run('git', ['-C', dev.path, 'cat-file', '-e', input.commit + '^{commit}']);
    run('git', ['-C', dev.path, 'merge-base', '--is-ancestor', input.commit, dev.sha]);
  } catch {
    throw new Error('Commit is not part of the matched development history; check the repository, folder and ref');
  }
  return db.saveOpsEvidence(id, 'release-record', live.version + '|' + (live.buildNumber ?? ''), {
    appId: id, version: live.version, build: live.buildNumber ?? null, commit: input.commit.toLowerCase(),
    repo: dev.repo, folder: dev.folder, basis: input.basis, evidence: input.evidence,
    confirmedBy: input.confirmedBy, recordedAt: now,
    notice: 'Release record: Git ancestry verified; binary provenance relies on the stated basis.',
  });
}

// Returns {sha, provenance} for the live version, or null when shipped code is unverified.
export function liveRelease(scan, records = []) {
  const live = scan?.store?.data?.live;
  if (!live || scan.source?.status !== 'matched') return null;
  if (scan.source.releaseStatus === 'tag-match' && scan.source.release?.sha) {
    return { sha: scan.source.release.sha, provenance: 'git tag matching live version', release: scan.source.release };
  }
  const dev = scan.source.development;
  const record = records.find((row) => row.version === live.version &&
    (row.build == null || String(row.build) === String(live.buildNumber ?? '')) &&
    row.repo === dev?.repo && row.folder === dev?.folder);
  return record ? { sha: record.commit, provenance: 'release record (' + record.basis + ')',
    release: { ...dev, sha: record.commit, ref: 'release-record:' + record.version } } : null;
}
