import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { state } from '../src/state.mjs';
import { advance, cycle } from '../src/operator.mjs';
import { contentPlan, planAppleAds } from '../src/campaigns.mjs';
import { confirmRelease, liveRelease } from '../src/release-record.mjs';
import { prepareBrief } from '../src/creative.mjs';
import { schemas, schemaFor } from '../src/schemas.mjs';
import { inputRequired, buildInvocation, failureDetail } from '../src/host-tools.mjs';
import { run } from '../src/io.mjs';

const DAY = 86_400_000;
const at = (day) => new Date(Date.UTC(2026, 10, day, 14)).toISOString();
const date = (time) => new Date(time).toISOString().slice(0, 10);
const SHA = 'a'.repeat(40);
const config = { loop: { hourlyRate: 30, apps: { '123': { channels: ['tiktok', 'youtube', 'instagram', 'apple-ads'], market: 'CA',
  currency: 'CAD', cashCap: 100, maxActivePromotions: 4, minimumDownloads: 10 } } } };

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'campaigns-'));
  const db = state(dir);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, db };
}
const fixture = (time, extra = {}) => ({
  app: { id: '123', name: 'Rep Count' }, capturedAt: time, inventorySource: 'App Store Connect API',
  periods: { current: { end: date(time) } }, store: { status: 'ok', data: { live: { version: '1.0', buildNumber: '42' } } },
  source: { status: 'matched', development: { repo: 'owner/app', folder: '', sha: SHA, ref: 'HEAD' } },
  compliance: { status: 'scanned' }, decision: { recommendation: { finding: 'x' } }, ...extra,
});
const publish = (channel, token, time) => ({ action: 'published', publishedAt: time, expectedCashCost: 0, currency: 'CAD',
  publishedUrl: channel === 'tiktok' ? 'https://www.tiktok.com/@a/video/' + token : 'https://www.youtube.com/shorts/' + token,
  campaignLink: 'https://apps.apple.com/ca/app/a/id123?pt=1&ct=' + token, format: 'demo' });

test('cycle runs one campaign per channel concurrently, including a capped paid test', (t) => {
  const { db } = setup(t);
  const scan = fixture(at(1));
  const result = cycle(db, [scan], config, at(1));
  const tasks = result.apps[0].created.map((id) => db.operation(id));
  assert.deepEqual(tasks.map((x) => x.channel).sort(), ['apple-ads', 'instagram', 'tiktok', 'youtube']);
  assert.equal(tasks.find((x) => x.channel === 'apple-ads').basis.scope, 'paid-test');
  const limited = structuredClone(config);
  limited.loop.apps['123'].maxActivePromotions = 2;
  const { db: other } = setup(t);
  assert.equal(cycle(other, [scan], limited, at(1)).apps[0].created.length, 2);
  assert.match(JSON.stringify(cycle(other, [scan], limited, at(1)).apps[0].due), /Active promotion limit/);
});

test('a campaign holds several posts and signals, and a suppressed window is retested, not dropped', (t) => {
  const { db } = setup(t);
  const scan = fixture(at(1));
  const solo = { loop: { hourlyRate: 30, apps: { '123': { channels: ['tiktok'], market: 'CA', currency: 'CAD' } } } };
  const [id] = cycle(db, [scan], solo, at(1)).apps[0].created;
  advance(db, db.operation(id), publish('tiktok', 'w1', at(1)), scan, at(1));
  const second = { action: 'post', publishedUrl: 'https://www.tiktok.com/@a/video/w1b', publishedAt: at(3), format: 'user-problem' };
  assert.equal(advance(db, db.operation(id), second, scan, at(3)).posts.length, 1);
  assert.throws(() => advance(db, db.operation(id), second, scan, at(3)), /already recorded/);
  assert.throws(() => advance(db, db.operation(id), { ...second, publishedUrl: 'https://www.tiktok.com/@a/video/late', publishedAt: at(12) }, scan, at(12)), /measurement window/);
  advance(db, db.operation(id), { action: 'signals', observedAt: at(5), source: 'TikTok Studio', scope: 'both posts', metrics: { views: 3000, linkClicks: 20 } }, scan, at(5));
  const closed = advance(db, db.operation(id), { action: 'measure', start: date(at(2)), end: date(at(8)), source: 'App Store Connect Campaign Links',
    evidence: 'export', reportComplete: true, campaignToken: 'w1', currency: 'CAD', downloads: null, suppressed: true, cash: 0, hours: 2,
    storeTrend: { metric: 'search downloads', source: 'App Analytics', scope: 'CA', before: 40, after: 52, beforeStart: date(at(-6)), beforeEnd: date(at(0)) } }, scan, at(9));
  assert.equal(closed.outcome.verdict, 'attribution suppressed');
  assert.equal(closed.outcome.downloads, null);
  assert.equal(closed.outcome.learningEligible, false);
  assert.equal(closed.outcome.signals.posts, 2);
  assert.equal(closed.outcome.signals.proxies[0].metrics.views, 3000);
  const later = fixture(at(20));
  const [retest] = cycle(db, [later], solo, at(20)).apps[0].created;
  assert.equal(db.operation(retest).basis.scope, 'retest');
});

test('Apple Ads needs budget approval, an exact plan preview and a verified receipt before measurement', (t) => {
  const { db } = setup(t);
  const scan = fixture(at(1));
  const paid = { loop: { apps: { '123': { channels: ['apple-ads'], market: 'CA', currency: 'CAD', cashCap: 100 } } } };
  const [id] = cycle(db, [scan], paid, at(1)).apps[0].created;
  const plan = { appId: '123', taskId: id, accountId: '555', campaignName: 'CA search test', countries: ['CA'], currency: 'CAD',
    dailyBudget: 10, totalBudget: 70, billingPeriod: 'campaign-lifetime', startDate: date(at(2)), endDate: date(at(8)),
    keywords: [{ text: 'rep counter', matchType: 'exact' }] };
  assert.throws(() => planAppleAds(db, scan, '123', paid, plan, at(1)), /authorize-cost/);
  assert.throws(() => advance(db, db.operation(id), { action: 'authorize-cost', amount: 150, currency: 'CAD', approvalReference: 'x' }, scan, at(1)), /cash cap/);
  advance(db, db.operation(id), { action: 'authorize-cost', amount: 70, currency: 'CAD', approvalReference: 'owner ok' }, scan, at(1));
  assert.throws(() => planAppleAds(db, scan, '123', paid, { ...plan, totalBudget: 120 }, at(1)), /cashCap/);
  const preview = planAppleAds(db, scan, '123', paid, plan, at(1));
  for (const part of ['555', 'CAD 10/day', 'CAD 70 total', 'campaign-lifetime', date(at(8)), preview.fingerprint]) assert.ok(preview.approvalStatement.includes(part), part);
  assert.throws(() => advance(db, db.operation(id), publish('tiktok', 'z', at(2)), scan, at(2)), /ads-plan/);
  assert.throws(() => advance(db, db.operation(id), { action: 'ads-launched', fingerprint: 'wrong', approvalReference: 'ok', campaignId: '9', receiptEvidence: 'r', launchedAt: at(2) }, scan, at(2)), /fingerprint/);
  const live = advance(db, db.operation(id), { action: 'ads-launched', fingerprint: preview.fingerprint, approvalReference: 'owner approved preview',
    campaignId: '9', receiptEvidence: 'Running, CAD 70 total', launchedAt: at(2) }, scan, at(2));
  assert.equal(live.status, 'live');
  assert.equal(live.publication.mode, 'paid');
  const outcome = advance(db, db.operation(id), { action: 'measure', start: date(at(3)), end: date(at(9)), source: 'Apple Ads Platform API',
    evidence: 'report', reportComplete: true, campaignId: '9', currency: 'CAD', downloads: 14, cash: 64.5, hours: 1 }, scan, at(10)).outcome;
  assert.equal(outcome.downloads, 14);
  assert.equal(outcome.budgetBreach, false);
});

test('content plan stays inside configured social channels and active same-channel tasks', (t) => {
  const { db } = setup(t);
  const scan = fixture(at(1));
  const [id] = cycle(db, [scan], { loop: { apps: { '123': { channels: ['tiktok'], market: 'CA' } } } }, at(1)).apps[0].created;
  const cfg = { loop: { apps: { '123': { channels: ['tiktok', 'apple-ads'], market: 'CA' } } } };
  const entry = { date: date(at(2)), channel: 'tiktok', format: 'demo', angle: 'Hands-free', hook: 'Lost count?', taskId: id };
  const plan = contentPlan(db, '123', cfg, { appId: '123', weekStart: date(at(2)), entries: [entry, { ...entry, date: date(at(4)), taskId: undefined }] }, at(1));
  assert.equal(plan.coverage[0].planned, 2);
  assert.throws(() => contentPlan(db, '123', cfg, { appId: '123', weekStart: date(at(2)), entries: [{ ...entry, channel: 'apple-ads' }] }, at(1)), /social channel/);
  assert.throws(() => contentPlan(db, '123', cfg, { appId: '123', weekStart: date(at(2)), entries: [{ ...entry, date: date(at(12)) }] }, at(1)), /inside the week/);
});

test('release-confirm pins promotion to a commit in matched history; otherwise development HEAD stands in', (t) => {
  const { dir, db } = setup(t);
  const repo = join(dir, 'repo');
  run('git', ['init', '-q', repo]);
  const git = (...args) => run('git', ['-C', repo, ...args]).trim();
  git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'ship');
  const shipped = git('rev-parse', 'HEAD');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'dev');
  const head = git('rev-parse', 'HEAD');
  const scan = fixture(at(1), { source: { status: 'matched', releaseStatus: 'unmatched', development: { repo: 'repo', folder: '', sha: head, ref: 'HEAD', path: repo } } });
  const brief = { verifiedVersion: '1.0', listingSha: shipped, audience: 'a', hook: 'h', proof: 'p', cta: 'c', platforms: ['tiktok'] };
  assert.throws(() => prepareBrief(scan, brief, join(dir, 'b1')), /release-confirm/);
  assert.equal(liveRelease(scan).sha, head, 'without a record the matched development HEAD stands in');
  const input = { appId: '123', version: '1.0', build: '42', commit: shipped, basis: 'ci-build-record', evidence: 'CI build 42', confirmedBy: 'owner' };
  assert.throws(() => confirmRelease(db, scan, '123', { ...input, commit: 'b'.repeat(40) }, at(1)), /not part of the matched development history/);
  assert.throws(() => confirmRelease(db, scan, '123', { ...input, version: '0.9' }, at(1)), /current live App Store version/);
  confirmRelease(db, scan, '123', input, at(1));
  const records = db.opsEvidence('123', 'release-record');
  assert.equal(liveRelease(scan, records).sha, shipped);
  assert.equal(prepareBrief(scan, brief, join(dir, 'b2'), records).provenance, 'release record (ci-build-record)');
});

test('every JSON input action has a schema whose example targets an app, and runner errors are relayed', () => {
  for (const action of inputRequired) assert.ok(Object.hasOwn(schemas, action) || action === 'advance', 'schema for ' + action);
  assert.ok(schemaFor('advance').variants.length >= 9);
  assert.throws(() => schemaFor('nope'), /available/);
  assert.equal(failureDetail('(node:1) ExperimentalWarning: SQLite\nStoryboard needs revision:\n- scene x'), 'Operator command failed: Storyboard needs revision:\n- scene x');
  assert.match(failureDetail(''), /without a message/);
  assert.throws(() => buildInvocation('/tmp', 'video', { app: '123', storyboard: 'a.json', brief: 'b.json' }), /storyboard alone/);
  assert.deepEqual(buildInvocation('/tmp', 'release-confirm', { app: '123', inputJson: '{"appId":"123"}' }).argv.slice(1), ['release-confirm', '--app', '123', '--input', '-']);
});
