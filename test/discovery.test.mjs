import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { bundleIds, discoverSources, discoveryRoots } from '../src/discovery.mjs';
import { run, writeJson } from '../src/io.mjs';

const pbx = (id) => 'buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = ' + id + '; MARKETING_VERSION = 1.2; };\n';
function project(dir, id, extra = {}) {
  mkdirSync(join(dir, 'ios', 'RepCount.xcodeproj'), { recursive: true });
  writeFileSync(join(dir, 'ios', 'RepCount.xcodeproj', 'project.pbxproj'), pbx(id));
  mkdirSync(join(dir, 'ios', 'RepCount'), { recursive: true });
  writeFileSync(join(dir, 'ios', 'RepCount', 'RepCounter.swift'), 'struct RepCounter {\n  func countReps() -> Int { 0 }\n  let apiKey = "do-not-leak"\n}\n');
  writeFileSync(join(dir, 'README.md'), '# Rep Count\nCounts reps automatically.\n');
  for (const [file, body] of Object.entries(extra)) writeFileSync(join(dir, file), body);
}
const git = (dir, ...args) => run('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args]).trim();

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'discover-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const roots = join(base, 'Developer');
  const main = join(roots, 'RepCount');
  project(main, 'com.example.repcount');
  run('git', ['init', '-q', main]);
  git(main, 'add', '.'); git(main, 'commit', '-qm', 'ship'); git(main, 'tag', 'v1.2.0');
  git(main, 'remote', 'add', 'origin', 'https://user:secret@github.com/owner/RepCount.git');
  const copy = join(roots, 'codex-work', 'RepCount-copy');
  run('git', ['clone', '-q', main, copy]);
  writeFileSync(join(copy, 'note.txt'), 'later');
  git(copy, 'add', '.'); git(copy, 'commit', '-qm', 'newer experiment');
  project(join(roots, 'loose-folder'), 'com.example.repcount');
  project(join(roots, 'node_modules', 'pkg'), 'com.example.repcount');
  project(join(roots, '.codex', 'session'), 'com.example.repcount');
  project(join(roots, 'Other'), 'com.example.other');
  return { base, roots, main: realpathSync(main), copy: realpathSync(copy) };
}

test('discovery stays inside owner roots, skips dependencies and hidden agent folders, and ranks copies', (t) => {
  const { roots, main, copy } = fixture(t);
  assert.throws(() => discoveryRoots({}), /sourceDiscovery.roots/);
  for (const root of ['~', '~/', homedir(), '/']) assert.throws(() => discoveryRoots({ sourceDiscovery: { roots: [root] } }), /not the home or root/);
  const result = discoverSources([{ id: '123', name: 'Rep Count', bundleId: 'com.example.repcount' }],
    { sourceDiscovery: { roots: [roots] } }, { liveVersions: { '123': '1.2.0' } });
  const [app] = result.apps;
  assert.deepEqual(app.candidates.filter((c) => c.isGit).map((c) => c.path), [main, copy], 'live-version tag ranks first');
  assert.deepEqual(app.recommended.liveVersionTags, ['v1.2.0']);
  assert.equal(app.recommended.folder, 'ios');
});

test('discover, confirm, scan, read code and status work end to end through the CLI', (t) => {
  const { base, roots, main, copy } = fixture(t);
  const cli = join(base, 'fake-asc');
  writeFileSync(cli, `#!/usr/bin/env node
const a=process.argv.slice(2);let r;
if(a[0]==='apps')r={data:[{id:'123',attributes:{name:'Rep Count',bundleId:'com.example.repcount',sku:'RC'}},{id:'456',attributes:{name:'Missing',bundleId:'com.example.none',sku:'M'}}]};
else if(a[0]==='versions')r={data:[{id:'v2',attributes:{versionString:'1.3.0',appVersionState:'WAITING_FOR_REVIEW',createdDate:'2026-11-24'}},
 {id:'v1',attributes:{versionString:'1.2.0',appVersionState:'READY_FOR_DISTRIBUTION',createdDate:'2026-11-01'},relationships:{build:{data:{id:'b'}}}}],included:[{id:'b',type:'builds',attributes:{version:'42'}}]};
else if(a[0]==='builds')r={data:[]};else if(a[0]==='validate')r={summary:{blocking:0},checks:[]};else if(a[0]==='reviews')r={data:[]};
if(!r)process.exit(2);console.log(JSON.stringify(r));`, { mode: 0o700 });
  const state = join(base, 'state');
  const conf = join(base, 'config.json');
  writeJson(conf, { stateDir: state, asc: { cli }, sourceDiscovery: { roots: [roots] }, loop: { apps: { '123': { market: 'US', channels: ['tiktok'] } } } });
  const agent = (...args) => JSON.parse(run(process.execPath, ['--disable-warning=ExperimentalWarning', resolve('src/cli.mjs'), ...args, '--config', conf]));

  const found = agent('discover-sources');
  const rep = found.apps.find((a) => a.appId === '123');
  assert.equal(rep.status, 'multiple');
  const paths = rep.candidates.map((c) => c.path);
  assert.ok(paths.includes(main) && paths.includes(copy));
  assert.equal(rep.candidates.filter((c) => !c.isGit).length, 1);
  assert.equal(paths.some((p) => p && /node_modules|\.codex/.test(p)), false);
  assert.equal(rep.candidates.find((c) => c.path === main).githubRepo, 'owner/RepCount');
  assert.equal(JSON.stringify(found).includes('secret'), false);
  assert.equal(found.apps.find((a) => a.appId === '456').status, 'none');

  const input = join(base, 'source.json');
  writeJson(input, { appId: '123', path: '/elsewhere', folder: 'ios', evidence: 'x' });
  assert.throws(() => agent('source-confirm', '--app', '123', '--input', input));
  writeJson(input, { appId: '123', path: main, folder: 'ios', evidence: 'Owner confirmed; origin owner/RepCount; tag v1.2.0' });
  assert.equal(agent('source-confirm', '--app', '123', '--input', input).binding.repo, 'owner/RepCount');

  const [scan] = agent('scan', '--app', '123');
  assert.equal(scan.source.status, 'matched');
  assert.equal(scan.source.development.folder, 'ios');
  assert.equal(scan.source.releaseStatus, 'tag-match');
  const index = agent('inspect', '--app', '123', '--release');
  assert.ok(index.index.files.some((f) => f.file === 'ios/RepCount/RepCounter.swift'));
  const code = agent('inspect', '--app', '123', '--release', '--file', 'ios/RepCount/RepCounter.swift');
  assert.match(code.text, /2: +func countReps/);
  assert.equal(code.text.includes('do-not-leak'), false);
  assert.equal(agent('inspect', '--app', '123', '--query', 'countReps').hits[0].line, 2);

  const status = agent('status').apps.find((a) => a.appId === '123');
  const by = Object.fromEntries(status.steps.map((s) => [s.name, s]));
  assert.equal(by.source.status, 'DONE');
  assert.equal(by['shipped-commit'].status, 'DONE');
  assert.match(by['store-state'].detail, /live 1.2.0.*next 1.3.0 WAITING_FOR_REVIEW/);
  assert.equal(by['creative-assets'].status, 'TODO');
});

test('bundle IDs are read from quoted pbxproj keys (generated projects)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quoted-'));
  try {
    const file = join(dir, 'project.pbxproj');
    writeFileSync(file, '"buildSettings" = { "PRODUCT_BUNDLE_IDENTIFIER" = "me.example.inbox"; };');
    assert.deepEqual(bundleIds(file), ['me.example.inbox']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
