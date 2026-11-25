import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { state } from '../src/state.mjs';
import { advance, cycle, feedbackDigest, handoff, memory, observe } from '../src/operator.mjs';
import { run, readJson, writeJson } from '../src/io.mjs';

const DAY = 86_400_000;
const at = (day) => new Date(Date.UTC(2026, 10, day, 14)).toISOString();
const date = (time) => new Date(time).toISOString().slice(0, 10);
const SHA = 'a'.repeat(40);
const config = { loop: { hourlyRate: 30, apps: {
  '123': { channels: ['youtube'], audienceGroup: 'fitness', market: 'CA', minimumDownloads: 10, maxCpa: 5 },
  '456': { channels: ['youtube'], audienceGroup: 'fitness', market: 'CA' },
  '789': { channels: ['youtube'], audienceGroup: 'fitness', market: 'US' },
} } };

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ios-loop-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixture(appId, time, extra = {}) {
  const target = { repo: 'owner/app', folder: '', sha: SHA, ref: 'HEAD' };
  return {
    app: { id: appId, name: 'App ' + appId }, capturedAt: time, inventorySource: 'App Store Connect API',
    periods: { current: { end: date(time) } },
    store: { status: 'ok', data: { live: { version: '1.0', buildNumber: '42' } } },
    source: { status: 'matched', development: target },
    compliance: { status: 'scanned' }, decision: { recommendation: { finding: 'Test one channel' } },
    ...extra,
  };
}

test('cycle queues one organic test per app, persists measurement, and seeds the next cost decision', (t) => {
  const dir = workspace(t);
  let db = state(dir);
  const latest = fixture('123', at(1));
  db.saveScan('123', at(1), latest);
  const [id] = cycle(db, [latest], config, at(1)).apps[0].created;
  assert.ok(id);
  assert.deepEqual(cycle(db, [latest], config, at(1)).apps[0].created, []);
  const publication = (token, publishedAt) => ({
    action: 'published', publishedUrl: 'https://www.youtube.com/shorts/' + token,
    campaignLink: 'https://apps.apple.com/ca/app/a/id123?pt=123&ct=' + token,
    publishedAt, expectedCashCost: 0, currency: 'CAD',
  });
  advance(db, db.operation(id), publication('one', at(1)), latest, at(1));
  const measure = (token, start, end) => ({
    action: 'measure', start, end, source: 'App Store Connect Campaign Links',
    evidence: 'verified campaign segment export', reportComplete: true,
    campaignToken: token, currency: 'CAD', downloads: 15, cash: 0, hours: 1,
  });
  assert.throws(() => advance(db, db.operation(id), measure('different', date(at(2)), date(at(8))), latest, at(9)), /matching Apple campaign token/);
  assert.throws(() => advance(db, db.operation(id), { ...measure('one', date(at(2)), date(at(8))), reportComplete: false },
    latest, at(9)), /complete/);
  const closed = advance(db, db.operation(id), measure('one', date(at(2)), date(at(8))), latest, at(9));
  assert.equal(closed.outcome.costPerDownload, 2);
  db.close();

  db = state(dir);
  t.after(() => db.close());
  assert.equal(db.operation(id).status, 'closed');
  const fresh = fixture('123', at(27));
  const roundTwo = cycle(db, [fresh], config, at(27));
  const second = db.operation(roundTwo.apps[0].created[0]);
  assert.equal(second.basis.scope, 'replication');
  advance(db, second, publication('two', at(27)), fresh, at(27));
  advance(db, db.operation(second.id), measure('two', date(at(28)), date(at(34))), fresh, at(35));
  assert.equal(memory(db, config, '123')[0].promotionEvidence[0].costPerDownload, 2);
  assert.equal(memory(db, config, '123')[0].promotionEvidence[0].observations, 2);
});

test('transfer requires multiple apps with comparable market, currency and labor cost', (t) => {
  const db = state(workspace(t));
  t.after(() => db.close());
  for (const [idx, appId] of ['101', '101', '202'].entries()) {
    db.enqueue({ appId, key: 'test:' + idx, kind: 'promotion', status: 'closed', channel: 'youtube',
      publication: { mode: 'organic' },
      policy: { currency: 'CAD', hourlyRate: 30, measurementDays: 7, market: 'CA', audienceGroup: 'fitness' },
      outcome: { learningEligible: true, totalCost: 10, downloads: 10 } }, at(1));
  }
  const ca = fixture('456', at(2));
  const us = fixture('789', at(2));
  db.saveScan('456', at(2), ca);
  db.saveScan('789', at(2), us);
  assert.equal(memory(db, config, '456')[0].promotionEvidence[0].scope, 'matched-apps');
  assert.deepEqual(memory(db, config, '789')[0].promotionEvidence, []);
});

test('feature handoff survives failed acceptance and checks deployment before measuring a released build', (t) => {
  const dir = workspace(t);
  const db = state(join(dir, 'db'));
  t.after(() => db.close());
  run('git', ['init', '-q', dir]);
  const git = (...args) => run('git', ['-C', dir, ...args]).trim();
  const commit = (message) => {
    git('add', 'app.txt');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  run('sh', ['-c', 'echo old > "$1/app.txt"', 'test', dir]);
  const base = commit('base');
  run('sh', ['-c', 'echo new > "$1/app.txt"', 'test', dir]);
  const changed = commit('feature');
  const latest = fixture('123', at(8));
  latest.source.development.sha = base;
  db.saveScan('123', at(8), latest);
  const ready = observe(db, latest, {
    key: 'remember-last-workout', problem: 'Workout routine resets after restart',
    proposedChange: 'Restore the last routine', userFlow: 'Select a routine then fully relaunch',
    signals: [{ kind: 'support', ref: 'a', observation: 'Reset after restart', date: date(at(6)) },
      { kind: 'device-test', ref: 'b', observation: 'Reproduced on an iPhone', date: date(at(7)) }],
    acceptance: ['Restore an explicitly saved routine', 'Unsaved changes stay unsaved'],
    impact: { metric: 'successful resume share', source: 'iOS events', scope: 'Canada',
      baseline: 0.3, target: 0.6, direction: 'higher', days: 7, minSample: 20, baselineSample: 40,
      baselineStart: date(at(1)), baselineEnd: date(at(7)) },
  }, at(8));
  const packet = handoff(db, ready, dir, at(8), { assignee: 'Builder' });
  assert.equal(readJson(packet.path).target.sha, base);
  const delivery = {
    action: 'implemented', commit: changed, version: '1.1', build: '43',
    verifier: 'Reviewer', evidence: 'Test and acceptance log',
    acceptance: packet.packet.acceptance.map(({ id }) => ({ id, status: 'PASS', evidence: 'Comparable test proof ' + id })),
  };
  assert.throws(() => advance(db, db.operation(ready.id), { ...delivery, verifier: 'Builder' }, latest, at(9)), /independent verifier/);
  const failed = structuredClone(delivery);
  failed.acceptance[0].status = 'FAIL';
  assert.equal(advance(db, db.operation(ready.id), failed, latest, at(9)).status, 'delegated');
  assert.equal(advance(db, db.operation(ready.id), delivery, latest, at(9)).status, 'implemented');

  const released = fixture('123', at(10));
  released.store.data.live = { version: '1.1', buildNumber: '43' };
  released.source.releaseStatus = 'tag-match';
  released.source.release = { repo: 'owner/app', folder: '', sha: base, path: dir };
  cycle(db, [released], {}, at(10));
  assert.equal(db.operation(ready.id).status, 'implemented');
  released.source.release.sha = changed;
  cycle(db, [released], {}, at(10));
  const task = db.operation(ready.id);
  assert.equal(task.status, 'live');
  const measured = advance(db, task, { action: 'measure', start: date(at(11)), end: date(at(17)),
    source: 'iOS events', evidence: 'Export and documented event query', reportComplete: true,
    metric: 'successful resume share', scope: 'Canada', sample: 51, value: 0.67 }, released, at(18));
  assert.equal(measured.outcome.verdict, 'met target');
  assert.deepEqual(db.operationEvents(ready.id).map((entry) => entry.event),
    ['queued', 'delegated', 'acceptance-open', 'acceptance-passed', 'release-verified', 'measured']);
});

test('cached CLI cycle reports stale scans and preserves review evidence without reviewer text', (t) => {
  const dir = workspace(t);
  const db = state(dir);
  db.saveScan('123', at(1), fixture('123', at(1)));
  db.close();
  const conf = join(dir, 'config.json');
  writeJson(conf, { stateDir: dir, ...config });
  const output = JSON.parse(run(process.execPath, [resolve('src/cli.mjs'), 'cycle', '--cached', '--config', conf]));
  assert.equal(output.apps[0].appId, '123');
  const reviews = [
    { id: '1', date: date(at(2)), body: 'App freezes when entering a session' },
    { id: '2', date: date(at(3)), body: 'Lost the session after a crash' },
  ];
  const result = feedbackDigest(reviews, at(4));
  assert.deepEqual(result.themes.map(({ theme }) => theme), ['crash']);
  assert.equal(JSON.stringify(result).includes('Lost the session'), false);
});
