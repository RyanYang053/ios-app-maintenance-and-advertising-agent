// Local source discovery. Walks only owner-configured roots, reads only Xcode/XcodeGen project
// files for bundle identifiers, and uses read-only Git plumbing. It never opens agent
// transcripts, home-directory dotfolders or code bodies. Matches are proposals until the owner
// confirms one with source-confirm; the confirmation is kept in the ledger and used by scan.
import { readdirSync, readFileSync, statSync, existsSync, realpathSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { run } from './io.mjs';
import { assertEvidenceApp } from './app-context.mjs';

const SKIP = new Set(['node_modules', 'Pods', 'Carthage', 'DerivedData', 'build', 'dist', 'vendor', 'Library', 'Applications',
  'Music', 'Movies', 'Pictures', 'SourcePackages', 'checkouts', 'xcuserdata']);
const BUNDLE = /(?:PRODUCT_BUNDLE_IDENTIFIER["']?\s*=\s*["']?|\bbundleId\s*:\s*["']?)([A-Za-z0-9][\w.-]+)/g;
const LIMITS = { depth: 7, dirs: 60_000, projects: 2_000, bytes: 8_000_000 };

export function discoveryRoots(config) {
  const roots = config.sourceDiscovery?.roots;
  if (!Array.isArray(roots) || !roots.length || roots.length > 10 || roots.some((r) => typeof r !== 'string' || !r.trim())) {
    throw new Error('Owner: set sourceDiscovery.roots in agent.config.json, e.g. ["~/Developer", "~/Projects"]. Discovery never scans outside these folders.');
  }
  return roots.map((root) => {
    const path = resolve(root.replace(/^~(?=$|[\\/])/, homedir()));
    if (path === resolve(homedir()) || path === resolve('/')) throw new Error('Use specific project folders, not the home or root directory: ' + root);
    if (!existsSync(path)) throw new Error('Discovery root does not exist: ' + root);
    return realpathSync(path);
  });
}

// Yields Xcode project files (pbxproj) and XcodeGen specs under the roots.
export function projectFiles(roots, limits = LIMITS) {
  const found = [];
  let dirs = 0;
  const walk = (dir, depth) => {
    if (depth > limits.depth || dirs++ > limits.dirs || found.length >= limits.projects) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.endsWith('.xcodeproj')) {
          const file = join(path, 'project.pbxproj');
          if (existsSync(file)) found.push({ file, projectDir: dir });
          continue;
        }
        if (entry.name.startsWith('.') || SKIP.has(entry.name) || entry.name.endsWith('.xcworkspace') || entry.name.endsWith('.app')) continue;
        walk(path, depth + 1);
      } else if (entry.isFile() && /^project\.ya?ml$/.test(entry.name)) found.push({ file: path, projectDir: dir });
    }
  };
  for (const root of roots) walk(root, 0);
  return { files: found, truncated: dirs > limits.dirs || found.length >= limits.projects };
}

export function bundleIds(file) {
  try {
    if (statSync(file).size > LIMITS.bytes) return [];
    return [...new Set([...readFileSync(file, 'utf8').matchAll(BUNDLE)].map((m) => m[1]).filter((id) => !id.includes('$')))];
  } catch { return []; }
}

const git = (dir, args) => run('git', ['-c', 'core.fsmonitor=false', '-C', dir, ...args], { timeout: 20_000 }).trim();

export function gitFacts(projectDir, liveVersion) {
  let root;
  try { root = realpathSync(git(projectDir, ['rev-parse', '--show-toplevel'])); } catch { return { isGit: false }; }
  const facts = { isGit: true, path: root, folder: relative(root, realpathSync(projectDir)).split(sep).join('/') };
  try {
    const [sha, committedAt] = git(root, ['log', '-1', '--format=%H%x09%cI']).split('\t');
    Object.assign(facts, { headSha: sha, lastCommitAt: committedAt });
  } catch { facts.headSha = null; }
  try { facts.branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']); } catch { facts.branch = null; }
  try {
    const url = new URL(git(root, ['remote', 'get-url', 'origin']).replace(/^git@github\.com:/, 'https://github.com/'));
    url.username = ''; url.password = '';
    facts.remote = url.href;
    const gh = url.hostname === 'github.com' && url.pathname.replace(/\.git$/, '').match(/^\/([\w.-]+\/[\w.-]+)$/);
    facts.githubRepo = gh ? gh[1] : null;
  } catch { facts.remote = null; facts.githubRepo = null; }
  if (liveVersion) {
    try {
      const pattern = new RegExp('(^|[^0-9.])v?' + liveVersion.replace(/\./g, '\\.') + '$', 'i');
      facts.liveVersionTags = git(root, ['tag', '--list']).split('\n').filter((tag) => pattern.test(tag)).slice(0, 5);
    } catch { facts.liveVersionTags = []; }
  }
  return facts;
}

export function discoverSources(apps, config, { liveVersions = {}, files } = {}) {
  const roots = discoveryRoots(config);
  const scanned = files ?? projectFiles(roots);
  const wanted = new Set(apps.map((a) => a.bundleId));
  const hits = new Map();
  for (const { file, projectDir } of scanned.files) {
    for (const id of bundleIds(file)) if (wanted.has(id)) {
      const list = hits.get(id) ?? [];
      if (!list.some((row) => row.projectDir === projectDir)) list.push({ projectDir, file });
      hits.set(id, list);
    }
  }
  return {
    roots, projectFilesRead: scanned.files.length, truncated: scanned.truncated,
    apps: apps.map((app) => {
      const candidates = (hits.get(app.bundleId) ?? []).map(({ projectDir, file }) => ({ projectFile: relative(projectDir, file) || basename(file),
        ...gitFacts(projectDir, liveVersions[app.id]) })).map((row) => row.isGit ? row : { ...row, path: null, note: 'Not inside a Git repository; commits cannot be verified' })
        .sort((a, b) => (b.liveVersionTags?.length ? 1 : 0) - (a.liveVersionTags?.length ? 1 : 0) || String(b.lastCommitAt ?? '').localeCompare(String(a.lastCommitAt ?? '')));
      const usable = candidates.filter((c) => c.isGit);
      const unique = new Map(usable.map((c) => [c.path + '|' + c.folder, c]));
      return { appId: app.id, appName: app.name, bundleId: app.bundleId,
        status: unique.size === 1 ? 'unique' : unique.size > 1 ? 'multiple' : candidates.length ? 'not-git' : 'none',
        recommended: unique.size ? [...unique.values()][0] : null, candidates };
    }),
    notice: 'Proposals only. Copies of one app (for example separate checkouts made by different coding agents) appear as multiple candidates: compare the remote, latest commit and live-version tags, then confirm one with source-confirm.',
  };
}

export function confirmSource(db, id, input, now) {
  assertEvidenceApp(id, input);
  const latest = db.opsEvidence(id, 'source-discovery')[0];
  const candidate = latest?.candidates?.find((c) => c.isGit && c.path === input.path && c.folder === (input.folder ?? ''));
  if (!candidate) throw new Error('Pick path and folder exactly from the latest discover-sources candidates for this app (run discover-sources first)');
  if (typeof input.evidence !== 'string' || !input.evidence.trim() || input.evidence.length > 1000) {
    throw new Error('Explain why this candidate is the shipping source (evidence), e.g. "owner confirmed; origin matches; newest commit"');
  }
  return db.saveOpsEvidence(id, 'source-binding', now, { appId: id, bundleId: latest.bundleId, path: candidate.path, folder: candidate.folder,
    repo: candidate.githubRepo ?? basename(candidate.path), remote: candidate.remote, headShaAtConfirm: candidate.headSha,
    evidence: input.evidence, confirmedAt: now });
}

// Ledger bindings become extra repositories and bindings for scan; config bindings win.
export function ledgerSources(db, config, apps) {
  const repos = [];
  const bindings = {};
  for (const app of apps) {
    if (config.bindings?.[app.bundleId]) continue;
    const row = db.opsEvidence(app.id, 'source-binding')[0];
    if (!row || row.bundleId !== app.bundleId || !existsSync(row.path)) continue;
    repos.push({ path: row.path, repo: row.repo, folder: row.folder || undefined });
    bindings[app.bundleId] = { repo: row.repo, folder: row.folder };
  }
  return { repos, bindings };
}
