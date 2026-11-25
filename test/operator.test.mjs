import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readJson, run, writeJson } from '../src/io.mjs';
import { reportingPeriods, normalizeAnalytics, summarizeAds } from '../src/growth.mjs';
import { findSources } from '../src/source.mjs';

const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ios-operator-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

function setupRepo(dir, name) {
  const repo = join(dir, name);
  mkdirSync(join(repo, 'App.xcodeproj'), { recursive: true });
  writeFileSync(join(repo, 'App.xcodeproj', 'project.pbxproj'), 'PRODUCT_BUNDLE_IDENTIFIER = com.example.app;\nMARKETING_VERSION = 1.2;\n');
  writeFileSync(join(repo, 'README.md'), '# App\nA rep counter for iPhone.\n');
  const git = (...args) => run('git', ['-C', repo, ...args]).trim();
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'release');
  git('tag', 'v1.2');
  writeFileSync(join(repo, 'README.md'), '# App\nA rep counter for iPhone.\nUpcoming developer feature.\n');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'dev');
  return { path: repo, label: name, folder: '', head: git('rev-parse', 'HEAD'), release: git('rev-parse', 'v1.2') };
}

test('selects exact bundle, distinguishes source HEAD from deployed tag, flags multiple repositories', (t) => {
  const dir = tempDir(t);
  const first = setupRepo(dir, 'first');
  const sameBundle = setupRepo(dir, 'fork');
  const app = { bundleId: 'com.example.app' };
  const releases = { live: { version: '1.2' } };
  const single = findSources(app, releases, [first]);
  assert.equal(single.status, 'matched');
  assert.equal(single.development.sha, first.head);
  assert.equal(single.release.sha, first.release);
  assert.equal(findSources(app, releases, [first, sameBundle]).status, 'ambiguous');
  assert.equal(findSources(app, releases, [first, sameBundle], { repo: 'first' }).status, 'matched');
  assert.equal(findSources({ bundleId: 'com.example.ap' }, releases, [first]).status, 'unmatched');
});

test('only compares matching dates and traffic scope, preserving missing versus zero', () => {
  const periods = reportingPeriods(7, new Date('2026-11-25T14:00:00Z'));
  assert.deepEqual(periods.current, { start: '2026-11-16', end: '2026-11-22' });
  const current = { ...periods.current, source: 'App Analytics', scope: 'CA', firstTimeDownloads: 0, paidConversions: null };
  const previous = { ...periods.previous, source: 'App Analytics', scope: 'US', firstTimeDownloads: 25 };
  const data = normalizeAnalytics({ current, previous }, periods);
  assert.equal(data.current.firstTimeDownloads, 0);
  assert.equal(data.current.paidConversions, undefined);
  assert.equal(data.previous, undefined);
});

test('sums Apple Ads spend by promoted App Store ID without mixing currencies', () => {
  const row = (id, currency, amount) => ({ metadata: { promotedObjectId: id }, totalMetrics: { localSpend: { amount, currency } } });
  const data = [{ account: '1', current: [row('123', 'USD', '0.15'), row('123', 'USD', '1.11'), row('456', 'USD', '100')], previous: [] },
    { account: '2', current: [row('123', 'CAD', '17')], previous: [] }];
  const raw = { status: 'ok', data };
  assert.deepEqual(summarizeAds(raw, '123', {}).current, { USD: 1.26, CAD: 17 });
  data[0].current.push({ metadata: { id: '7' }, totalMetrics: { localSpend: { amount: '2', currency: 'EUR' } } });
  assert.equal(summarizeAds(raw, '123', {}).status, 'partial');
  assert.equal(summarizeAds(raw, '123', {}, undefined, { '1': { '7': '123' } }).current.EUR, 2);
});

test('normal entry points run a full scan and save evidence, listing draft, promotion draft and experiment', (t) => {
  const dir = tempDir(t);
  const repo = setupRepo(dir, 'my-ios-app');
  const cli = join(dir, 'test-asc');
  writeFileSync(cli, `#!/usr/bin/env node
const args=process.argv.slice(2);
let result;
if (args[0]==='apps') result={data:[{id:'123',attributes:{name:'Rep Count',bundleId:'com.example.app',sku:'RC'}}]};
else if (args[0]==='versions') result={data:[
  {id:'d',attributes:{versionString:'1.3',appVersionState:'REJECTED',createdDate:'2026-11-23'}},
  {id:'l',attributes:{versionString:'1.2',appVersionState:'READY_FOR_DISTRIBUTION',createdDate:'2026-11-20'},
  relationships:{build:{data:{id:'b'}}}}],included:[{id:'b',type:'builds',attributes:{version:'12',processingState:'VALID'}}]};
else if (args[0]==='reviews') result={data:[
  {id:'r1',attributes:{createdDate:new Date().toISOString(),rating:2,body:'App crashed on open'}},
  {id:'r2',attributes:{createdDate:new Date().toISOString(),rating:2,body:'Freezes while saving'}}]};
else if (args[0]==='builds') result={data:[]};
else if (args[0]==='validate') { result={summary:{blocking:1}}; process.exitCode=1; }
else if (args[0]==='analytics') result={metrics:[{name:'download_units',baseline:35,comparison:15}]};
else if (args[0]==='ads') {
  const body=JSON.parse(require('node:fs').readFileSync(0,'utf8'));
  if (!body.timeRange.start || body.timeRange.granularity || !body.fields.includes('localSpend')) process.exit(3);
  result={result:{rows:[{metadata:{promotedObjectId:'123'},totalMetrics:{localSpend:{amount:'15',currency:'CAD'}}}]},pagination:{totalCount:1}};
}
if (!result) process.exit(2);
console.log(JSON.stringify(result));
`, { mode: 0o700 });
  const conf = join(dir, 'config.json');
  writeJson(conf, { stateDir: join(dir, 'private'), asc: { cli, vendor: '12345' },
    ads: { accounts: ['ab'] }, github: { repos: [{ path: repo.path }] } });
  const entry = resolve('src/cli.mjs');
  const agent = (...args) => JSON.parse(run(process.execPath, [entry, ...args, '--config', conf]));
  const [scan] = agent('scan', '--app', '123');
  assert.equal(scan.store.data.live.buildNumber, '12');
  assert.equal(scan.store.data.candidate.state, 'REJECTED');
  assert.equal(scan.review.data.summary.blocking, 1);
  assert.equal(scan.ads.current.CAD, 15);
  assert.equal(scan.decision.recommendation.priority, 1);
  assert.equal(scan.source.release.sha, repo.release);
  const realCycle = agent('cycle', '--app', '123');
  assert.equal(realCycle.queue[0].kind, 'maintenance');
  assert.equal(realCycle.apps[0].feedback.data.themes[0].theme, 'crash');
  assert.deepEqual(agent('cycle', '--app', '123').apps[0].created, []);
  assert.equal(agent('task', '--task', String(realCycle.queue[0].id)).events[0].event, 'queued');
  assert.match(agent('inspect', '--app', '123', '--release').excerpts.find((row) => row.file === 'README.md').excerpt, /rep counter/);

  const input = join(dir, 'input.json');
  writeJson(input, { verifiedVersion: '1.2', listingSha: repo.release, audience: 'Lifters',
    hook: 'Skip the manual count', proof: 'Watch the counter rise', cta: 'Try on iPhone',
    platforms: ['youtube'], campaignLinks: { youtube: 'https://apps.apple.com/ca/app/rep-count/id123?pt=9&ct=yt' } });
  const response = agent('brief', '--app', '123', '--input', input);
  assert.equal(readJson(response.path).channels[0].tracking, 'ready');
  writeJson(input, { versionId: 'l', version: '1.2', locale: 'en-CA', hypothesis: 'Clearer demo', metric: 'Apple conversion',
    changes: [{ field: 'subtitle', before: 'Rep Count', after: 'Count every rep', observedAt: '2026-11-25' }] });
  assert.equal(agent('store-draft', '--app', '123', '--input', input).draft.status, 'draft');
  writeJson(input, { hypothesis: 'Short video improves downloads', status: 'measured', outcome: '5 campaign downloads', source: 'App Analytics' });
  agent('record', '--app', '123', '--input', input);
  assert.equal(agent('history', '--app', '123').experiments.length, 1);
});
