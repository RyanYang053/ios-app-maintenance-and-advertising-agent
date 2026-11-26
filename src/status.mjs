// Per-app workflow checklist built from local config and the ledger: what is done, what is
// blocked and the exact next runner command. Reads nothing remote and changes nothing.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { liveRelease } from './release-record.mjs';

const H72 = 72 * 3_600_000;
const r = 'node scripts/operator.mjs ';

export function workflowStatus(db, config, dir, now) {
  const scans = new Map(db.latestScans().map((s) => [s.app.id, s]));
  const ids = [...new Set([...Object.keys(config.loop?.apps ?? {}).filter((x) => /^\d+$/.test(x)), ...scans.keys()])].sort();
  const apps = ids.map((id) => {
    const scan = scans.get(id);
    const steps = [];
    const step = (name, ok, detail, command) => steps.push({ name, status: ok === null ? 'INFO' : ok ? 'DONE' : 'TODO', detail, ...(ok === false && command ? { command } : {}) });
    const policy = config.loop?.apps?.[id];
    step('promotion-policy', Boolean(policy?.market && policy?.channels?.length), policy?.market ? 'market ' + policy.market + ', channels ' + (policy.channels ?? []).join(', ') :
      'Owner: add loop.apps.' + id + ' with market and channels in agent.config.json');
    const fresh = scan && Date.parse(now) - Date.parse(scan.capturedAt) <= H72;
    step('fresh-scan', Boolean(fresh), scan ? 'last scan ' + scan.capturedAt : 'never scanned', r + 'scan --app ' + id);
    const bundleId = scan?.app?.bundleId;
    const configBound = bundleId && config.bindings?.[bundleId];
    const ledgerBound = db.opsEvidence(id, 'source-binding')[0];
    const discovery = db.opsEvidence(id, 'source-discovery')[0];
    const matched = scan?.source?.status === 'matched';
    step('source', matched, matched ? scan.source.development.repo + (scan.source.development.folder ? '/' + scan.source.development.folder : '') + ' @ ' + scan.source.development.sha.slice(0, 12) +
      (configBound ? ' (config binding)' : ledgerBound ? ' (confirmed ' + ledgerBound.confirmedAt.slice(0, 10) + ')' : '') :
      scan?.source?.status === 'ambiguous' ? 'several sources match; confirm one' : discovery?.candidates?.length ? discovery.candidates.length + ' candidate(s) found; confirm one' : 'no source matched yet',
    discovery?.candidates?.length ? r + 'source-confirm --app ' + id + ' --input source.json' : r + 'discover-sources');
    const live = scan?.store?.data?.live;
    const candidate = scan?.store?.data?.candidate;
    step('store-state', null, (live ? 'live ' + live.version + ' (build ' + (live.buildNumber ?? '?') + ')' : 'no live version') +
      (candidate ? '; next ' + candidate.version + ' ' + candidate.state : ''));
    if (live) {
      const shipped = liveRelease(scan, db.opsEvidence(id, 'release-record'));
      step('shipped-commit', Boolean(shipped), shipped ? shipped.provenance + ' ' + shipped.sha.slice(0, 12) : 'needed before any promotion claim',
        r + 'release-confirm --app ' + id + ' --input release.json');
    }
    let media = 0;
    const assets = join(dir, 'assets', id);
    if (existsSync(assets)) media = readdirSync(assets).filter((f) => /\.(png|jpe?g|webp|mp4|mov|webm)$/i.test(f)).length;
    if (live) step('creative-assets', media > 0, media + ' capture(s) in assets/' + id, r + 'capture --app ' + id);
    const open = db.operations(id).filter((t) => !['closed', 'cancelled'].includes(t.status));
    for (const task of open) {
      const due = task.status === 'live' && task.dueAt <= now.slice(0, 10);
      step('task-' + task.id, false, task.kind + (task.channel ? ' ' + task.channel : '') + ' is ' + task.status + (due ? ', measurement due' : ''),
        r + 'task --app ' + id + ' --task ' + task.id);
    }
    const todo = steps.filter((s) => s.status === 'TODO');
    return { appId: id, appName: scan?.app?.name ?? null, steps, next: todo[0]?.command ?? todo[0]?.detail ?? 'Up to date: run cycle for new work' };
  });
  return { checkedAt: now, apps, global: [
    !config.sourceDiscovery?.roots?.length && 'Owner: set sourceDiscovery.roots to enable discover-sources',
    !ids.length && 'No apps known yet: run apps, then scan one app',
  ].filter(Boolean), notice: 'Local checklist from the ledger. Run doctor --live for account readiness.' };
}
