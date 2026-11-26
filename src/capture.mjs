// Simulator captures for creative assets. Reuses an existing simulator build of the app (or builds the
// confirmed source into the configured DerivedData root), runs it on a booted or existing simulator and
// saves a screenshot and optional recording into assets/<ID>. Never creates simulators or edits app source.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { jsonCommand, run } from './io.mjs';

const BUILD_ROOT = '/Volumes/BuildScratch/DerivedData';
const MIN_FREE_GB = 5;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const plist = (app, key) => {
  try { return run('/usr/libexec/PlistBuddy', ['-c', 'Print ' + key, join(app, 'Info.plist')]).trim(); } catch { return null; }
};
const list = (dir) => { try { return readdirSync(dir); } catch { return []; } };

export function findBuild(roots, bundleId) {
  const hits = [];
  for (const root of roots) for (const project of list(root)) {
    const products = join(root, project, 'Build', 'Products');
    for (const config of list(products).filter((d) => d.endsWith('-iphonesimulator'))) {
      for (const name of list(join(products, config)).filter((f) => f.endsWith('.app'))) {
        const app = join(products, config, name);
        const executable = plist(app, 'CFBundleExecutable');
        if (plist(app, 'CFBundleIdentifier') === bundleId && executable && existsSync(join(app, executable))) hits.push({ app, mtime: statSync(app).mtimeMs });
      }
    }
  }
  return hits.sort((a, b) => b.mtime - a.mtime)[0]?.app ?? null;
}

function freeGb(path) {
  const line = run('df', ['-k', path]).trim().split('\n').pop().split(/\s+/);
  return Number(line[3]) / 1024 / 1024;
}

function build(source, derivedRoot, bundleId, developerDir, extraEnv = {}) {
  const dir = join(source.path, source.folder ?? '');
  const entries = list(dir).filter((f) => !f.startsWith('.')); // skip AppleDouble ._ files on external drives
  const project = entries.find((f) => f.endsWith('.xcodeproj'));
  const workspace = entries.find((f) => f.endsWith('.xcworkspace')); // CocoaPods projects only build from the workspace
  if (!project) throw new Error('No .xcodeproj in the confirmed source folder ' + dir + '; build it once in Xcode, then retry capture');
  if (!existsSync(derivedRoot)) throw new Error('Build root ' + derivedRoot + ' is not mounted (run disk-guard mount)');
  const free = freeGb(derivedRoot);
  if (free < MIN_FREE_GB) throw new Error('Only ' + free.toFixed(1) + ' GB free in ' + derivedRoot + '; free at least ' + MIN_FREE_GB + ' GB before building');
  const name = project.replace(/\.xcodeproj$/, '');
  const container = workspace ? ['-workspace', join(dir, workspace)] : ['-project', join(dir, project)];
  const env = { ...process.env, ...(developerDir ? { DEVELOPER_DIR: developerDir } : {}), ...extraEnv };
  const listed = jsonCommand('xcodebuild', ['-list', '-json', ...container], { cwd: dir, env, timeout: 120_000 });
  const schemes = (listed.workspace ?? listed.project)?.schemes ?? [];
  const scheme = schemes.includes(name) ? name : schemes.find((s) => !/^Pods/.test(s));
  if (!scheme) throw new Error('No shared scheme in ' + (workspace ?? project));
  try {
    run('xcodebuild', [...container, '-scheme', scheme, '-configuration', 'Release', '-sdk', 'iphonesimulator',
      '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', join(derivedRoot, name), 'CODE_SIGNING_ALLOWED=NO', 'build'],
    { cwd: dir, env, timeout: 3_600_000, killSignal: 'SIGINT', maxBuffer: 256 * 1024 * 1024 });
  } catch (error) {
    const lines = String(error.stdout ?? '') + String(error.stderr ?? '');
    const errors = [...new Set(lines.split('\n').filter((l) => /error:/.test(l)))].slice(0, 8).join('\n');
    throw new Error('xcodebuild ' + (error.signal ? 'timed out after 60 min' : 'failed') + ' for scheme ' + scheme + (errors ? ':\n' + errors : ''));
  }
  const app = findBuild([derivedRoot], bundleId);
  if (!app) throw new Error('Build finished but produced no simulator app with bundle ID ' + bundleId);
  return app;
}

function pickDevice(preferred) {
  const devices = Object.entries(jsonCommand('xcrun', ['simctl', 'list', 'devices', 'available', '-j']).devices)
    .filter(([runtime]) => runtime.includes('iOS')).flatMap(([, rows]) => rows);
  const named = preferred && devices.find((d) => d.name === preferred || d.udid === preferred);
  if (preferred && !named) throw new Error('Simulator ' + preferred + ' not found; capture never creates simulators');
  const device = named ?? devices.find((d) => d.state === 'Booted' && /iPhone/.test(d.name)) ?? devices.find((d) => /^iPhone \d+ Pro$/.test(d.name)) ??
    devices.find((d) => /iPhone/.test(d.name));
  if (!device) throw new Error('No existing iPhone simulator; create one in Xcode first');
  if (device.state !== 'Booted') run('xcrun', ['simctl', 'bootstatus', device.udid, '-b'], { timeout: 300_000 });
  return device;
}

async function record(udid, file, seconds) {
  const child = spawn('xcrun', ['simctl', 'io', udid, 'recordVideo', '--codec=h264', '--force', file], { stdio: 'ignore' });
  await sleep(seconds * 1000);
  const exited = new Promise((done) => child.once('exit', done));
  child.kill('SIGINT');
  await Promise.race([exited, sleep(15_000)]);
  if (!existsSync(file)) throw new Error('Recording did not produce a file');
}

// options: { current: keep the running app as the agent left it, seconds: record length, build: rebuild the confirmed source first }
export async function capture(scan, policy, config, assetsDir, options = {}) {
  const bundleId = policy?.captureBundleId ?? scan.app.bundleId;
  const roots = config.capture?.derivedDataRoots ?? [BUILD_ROOT, join(homedir(), 'Library/Developer/Xcode/DerivedData')];
  let app = options.build ? null : findBuild(roots, bundleId);
  if (options.build) {
    if (scan.source?.status !== 'matched') throw new Error('Confirm the app source before building for capture');
    app = build(scan.source.development, roots[0], bundleId, config.capture?.developerDir, config.capture?.env?.[scan.app.id]);
  }
  if (!app) throw new Error('No simulator build of ' + bundleId + ' found under ' + roots.join(', ') + '; rerun with --build');
  const device = pickDevice(config.capture?.device);
  if (!options.current) {
    try { run('xcrun', ['simctl', 'install', device.udid, app], { timeout: 300_000 }); } catch (error) {
      throw new Error('Simulator install of ' + app + ' failed: ' + String(error.stderr ?? '').split('\n').find((l) => /is missing|Unable|invalid/i.test(l)));
    }
    try { run('xcrun', ['simctl', 'terminate', device.udid, bundleId]); } catch { /* not running */ }
    run('xcrun', ['simctl', 'launch', device.udid, bundleId], { timeout: 60_000 });
    await sleep(5000);
  }
  mkdirSync(assetsDir, { recursive: true, mode: 0o700 });
  const version = plist(app, 'CFBundleShortVersionString');
  const buildNumber = plist(app, 'CFBundleVersion');
  const stem = join(assetsDir, 'sim-' + version + '-' + new Date().toISOString().replace(/[:.]/g, '-'));
  const files = [];
  if (options.seconds) { await record(device.udid, stem + '.mp4', options.seconds); files.push(stem + '.mp4'); }
  run('xcrun', ['simctl', 'io', device.udid, 'screenshot', stem + '.png'], { timeout: 60_000 });
  files.push(stem + '.png');
  const live = scan.store?.data?.live?.version ?? null;
  return { appId: scan.app.id, files, app, bundleId, version, build: buildNumber, liveVersion: live, matchesLive: version === live,
    device: device.name + ' (' + device.udid + ')',
    evidence: 'Simulator capture of ' + bundleId + ' ' + version + ' (' + buildNumber + ') on ' + device.name + ' at ' + new Date().toISOString(),
    next: 'Drive the app with the host simulator tools, then capture --app ' + scan.app.id + ' --current to save that screen.' };
}
