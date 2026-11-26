// Owner-run setup: reads the authorized App Store Connect app list (read-only) and adds a
// promotion policy for every app missing from agent.config.json. Existing entries are kept.
// Usage: node scripts/configure-apps.mjs --market US --channels tiktok,instagram,youtube [--currency USD]
//        [--roots ~/Developer,~/Projects] [--dry-run]
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { appleClient } from '../src/apple.mjs';

const root = resolve(import.meta.dirname, '..');
const CHANNELS = ['tiktok', 'instagram', 'youtube', 'x', 'reddit', 'linkedin', 'xiaohongshu', 'apple-ads'];
const { values: v } = parseArgs({ options: { market: { type: 'string' }, channels: { type: 'string' }, currency: { type: 'string' },
  roots: { type: 'string' }, 'dry-run': { type: 'boolean' } } });
const file = resolve(root, 'agent.config.json');
if (!existsSync(file)) throw new Error('Run node scripts/setup-local.mjs first');
const config = JSON.parse(readFileSync(file, 'utf8'));
const market = v.market?.toUpperCase();
const channels = (v.channels ?? '').split(',').map((c) => c.trim()).filter(Boolean);
if (!/^[A-Z]{2}$/.test(market ?? '') || !channels.length || channels.some((c) => !CHANNELS.includes(c))) {
  throw new Error('Pass --market (ISO country, e.g. US) and --channels from ' + CHANNELS.join(','));
}
if (v.currency && !/^[A-Z]{3}$/.test(v.currency)) throw new Error('--currency must be an ISO code like USD');
const apps = appleClient(config.asc).apps();
config.loop ??= {};
config.loop.apps ??= {};
if (v.currency) config.loop.currency ??= v.currency;
const added = [];
for (const app of apps) {
  if (config.loop.apps[app.id]) continue;
  config.loop.apps[app.id] = { market, channels, cashCap: 0, minimumDownloads: 10, measurementDays: 7, cooldownDays: 7,
    maxActivePromotions: Math.min(3, channels.length), shareAggregateLearning: false, receiveAggregateLearning: false,
    aso: { keywords: [], storefronts: [market] } };
  added.push({ id: app.id, name: app.name, bundleId: app.bundleId });
}
if (v.roots) config.sourceDiscovery = { roots: v.roots.split(',').map((r) => r.trim()).filter(Boolean) };
const summary = { appsFound: apps.length, added, kept: apps.length - added.length, sourceDiscovery: config.sourceDiscovery ?? null,
  note: 'Paid ads stay off (cashCap 0). Review each app\'s market and channels, then run node scripts/operator.mjs status.' };
if (!v['dry-run']) {
  copyFileSync(file, file + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-'));
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  for (const { id } of added) for (const dir of ['imports', 'assets', 'drafts', 'handoffs', 'videos']) {
    mkdirSync(resolve(root, config.stateDir ?? '.agent-data', dir, id), { recursive: true, mode: 0o700 });
  }
}
console.log(JSON.stringify(summary, null, 2));
