import { dirname, join, resolve } from 'node:path';
import { run } from './io.mjs';
import { withSourceSnapshot } from './source.mjs';

export function scanCompliance(source, toolPath) {
  if (!source || !toolPath) return { status: 'unavailable', reason: 'Verified development source and optional guard required' };
  try {
    return withSourceSnapshot(source, (folder) => {
      const checkout = resolve(toolPath);
      const guard = join(checkout, 'agent-os', 'hooks', 'app-store-compliance-guard.sh');
      const revision = run('git', ['-C', dirname(guard), 'rev-parse', 'HEAD']).trim();
      let report;
      let exit = 0;
      try {
        report = run('bash', [guard, folder], {
          cwd: folder, timeout: 120_000, env: { ...process.env, APP_STORE_GUARD_OK: '0' },
        });
      } catch (error) {
        if (![1, 2].includes(error.status)) throw error;
        exit = error.status;
        report = error.stdout;
      }
      report = report.replaceAll(folder, '.').trim();
      const counts = report.match(/^Summary\. critical=(\d+) high=(\d+) medium=(\d+)$/m);
      const coverage = report.match(/^Coverage\. (complete|incomplete) ios=(\d+)/m);
      const stale = report.includes('Rule pack STALE.');
      const status = exit === 2 ? 'blocked' : exit || stale || coverage?.[1] !== 'complete' || coverage[2] !== '1' ?
        'incomplete' : counts && (Number(counts[2]) || Number(counts[3])) ? 'findings' : 'scanned';
      return { status, revision, sha: source.sha, stale,
        findings: counts ? { critical: Number(counts[1]), high: Number(counts[2]), medium: Number(counts[3]) } : undefined,
        report };
    });
  } catch {
    return { status: 'unavailable', reason: 'Guard or source snapshot could not run' };
  }
}
