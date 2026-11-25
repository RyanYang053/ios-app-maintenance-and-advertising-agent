import { existsSync, mkdirSync, mkdtempSync, rmSync, lstatSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { jsonCommand, run } from './io.mjs';

const REPO = /^[\w.-]+\/[\w.-]+$/;
const ID_FILE = /(?:^|\/)(?:project\.pbxproj|[^/]+\.xcconfig|Info\.plist|app\.json|eas\.json|tauri\.conf\.json|config\.xml|[^/]+\.xcodegen\.yml|project\.yml)$/i;
const DOCS = /^(?:readme(?:\.[\w-]+)?|package\.json|pubspec\.yaml|privacyinfo\.xcprivacy)$/i;
const IGNORE = /(?:^|\/)(?:\.git|\.agent-data|Pods|node_modules|Carthage|vendor|examples?|tests?|fixtures?|build|dist)(?:\/|$)/i;
const BUNDLES = /(?:PRODUCT_BUNDLE_IDENTIFIER\s*=\s*["']?|"bundleIdentifier"\s*:\s*"|<key>CFBundleIdentifier<\/key>\s*<string>|\bbundleId\s*:\s*["']?)([\w.-]+)/g;

const git = (path, args, options) => run('git', ['-C', path, ...args], options).trim();
const literal = (value) => value.replace(/[.*+?^$${}()|[\]\\]/g, '\\$&');

export function loadRepos(config, stateDir) {
  const specs = [...(config.github?.repos ?? [])];
  const issues = [];
  if (config.github?.owner) {
    const limit = config.github.limit ?? 30;
    if (!/^[\w-]+$/.test(config.github.owner) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Invalid GitHub owner or repo limit');
    }
    try {
      const repos = jsonCommand('gh', ['repo', 'list', config.github.owner, '--limit', String(limit),
        '--no-archived', '--source', '--json', 'nameWithOwner']);
      for (const repo of repos) specs.push({ repo: repo.nameWithOwner });
      if (repos.length === limit) issues.push('GitHub discovery reached its repository limit');
    } catch {
      issues.push('GitHub discovery requires an authenticated gh CLI');
    }
  }
  const loaded = [];
  const seen = new Set();
  for (const spec of specs) {
    const identity = JSON.stringify([spec.path ?? spec.repo, spec.folder, spec.ref]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    try {
      if (!spec.path && (!REPO.test(spec.repo ?? '') || spec.repo.split('/').some((part) => part === '.' || part === '..'))) {
        throw new Error('Expected owner/repo');
      }
      const path = spec.path ? resolve(spec.path) : join(stateDir, 'repos', spec.repo);
      if (!spec.path) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        if (!existsSync(path)) {
          run('git', ['clone', '--bare', '--filter=blob:limit=1m', '--', 'https://github.com/' + spec.repo + '.git', path],
            { timeout: 90_000 });
        } else {
          git(path, ['fetch', '--prune', '--tags', 'origin', '+refs/heads/*:refs/heads/*'], { timeout: 90_000 });
        }
      }
      git(path, ['rev-parse', '--git-dir']);
      const folder = (spec.folder ?? '').replace(/\/$/, '');
      if (folder && (folder.startsWith('/') || folder.split('/').some((part) => part === '.' || part === '..') || IGNORE.test(folder))) {
        throw new Error('Expected a source folder relative to the Git tree');
      }
      loaded.push({ ...spec, path, folder, label: spec.repo ?? basename(path) });
    } catch {
      issues.push('Unable to read configured repository ' + (spec.repo ?? spec.path ?? '(missing path)'));
    }
  }
  return { loaded, issues };
}

function tree(path, sha) {
  return git(path, ['ls-tree', '-rz', '-l', sha]).split('\0').filter(Boolean).map((entry) => {
    const tab = entry.indexOf('\t');
    const [mode, type, oid, size] = entry.slice(0, tab).split(/\s+/);
    return { mode, type, oid, size: Number(size), file: entry.slice(tab + 1) };
  }).filter((entry) => entry.type === 'blob' && ['100644', '100755'].includes(entry.mode) &&
    entry.size <= 350_000 && !IGNORE.test(entry.file));
}

function matchVersionTag(tag, version, folder, defaultFolder) {
  if (!version) return false;
  const names = folder ? [posix.basename(folder)] : [];
  if (defaultFolder) names.unshift(defaultFolder);
  const exact = new RegExp('^v?' + literal(version) + '$', 'i');
  return exact.test(tag) || names.some((name) => new RegExp('^' + literal(name) + '[-/@]v?' + literal(version) + '$', 'i').test(tag));
}

export function findSources(app, releases, repos, binding) {
  const matches = [];
  const issues = [];
  for (const repo of repos) {
    if (binding?.repo && binding.repo !== repo.label) continue;
    try {
      const headRef = binding?.ref ?? repo.ref ?? 'HEAD';
      const refs = [{ ref: headRef, kind: 'development' }];
      if (!binding?.ref && !repo.ref) {
        const liveVersion = releases?.live?.version;
        const tags = git(repo.path, ['tag', '--list']).split('\n').filter(Boolean);
        for (const tag of tags) {
          const tagRef = 'refs/tags/' + tag;
          if (matchVersionTag(tag, liveVersion, binding?.folder ?? repo.folder, app.name) ||
            tag.endsWith('/v' + liveVersion) || tag.endsWith('-v' + liveVersion)) {
            refs.push({ ref: tagRef, kind: 'release-tag' });
          }
        }
      }
      for (const { ref, kind } of refs) {
        const sha = git(repo.path, ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}']);
        const folder = binding?.folder ?? repo.folder;
        const files = tree(repo.path, sha).filter((entry) => !folder || entry.file.startsWith(folder + '/'));
        const verified = [];
        for (const entry of files.filter((candidate) => ID_FILE.test(candidate.file))) {
          const contents = git(repo.path, ['cat-file', 'blob', entry.oid]);
          const ids = [...contents.matchAll(BUNDLES)].map((match) => match[1]);
          if (!ids.includes(app.bundleId)) continue;
          const root = entry.file.replace(/\/?[^/]+\.xcodeproj\/project\.pbxproj$/i, '');
          verified.push({ file: entry.file, root: root === entry.file ?
            (posix.dirname(entry.file) === '.' ? '' : posix.dirname(entry.file)) : root });
        }
        // A matching Info.plist may sit inside a target already represented by its Xcode project.
        const projectRoots = verified.filter((row) => /\.xcodeproj\/project\.pbxproj$/i.test(row.file)).map((row) => row.root);
        const roots = folder && verified.length ? [folder] : [...new Set(verified.map((row) =>
          projectRoots.filter((root) => root === '' || row.root === root || row.root.startsWith(root + '/'))
            .sort((a, b) => b.length - a.length)[0] ?? row.root))];
        for (const root of roots) {
          if (kind === 'release-tag' && !matchVersionTag(ref.slice(10), releases?.live?.version, root, app.name)) continue;
          const evidence = verified.filter((row) => !root || row.file.startsWith(root + '/')).map((row) => row.file);
          const docs = files.filter((entry) => (root ? posix.dirname(entry.file) === root : !entry.file.includes('/')) &&
            DOCS.test(posix.basename(entry.file))).map((entry) => entry.file);
          matches.push({ repo: repo.label, path: repo.path, folder: root, ref, sha, kind, evidence, docs });
        }
      }
    } catch {
      issues.push('Unable to resolve all source refs for ' + repo.label);
    }
  }
  const unique = (kind) => [...new Map(matches.filter((row) => row.kind === kind)
    .map((row) => [JSON.stringify([row.repo, row.path, row.folder, row.sha]), row])).values()];
  const development = unique('development');
  const open = unique('release-tag');
  const complete = issues.length === 0 || Boolean(binding?.repo && development.length === 1);
  return {
    status: development.length > 1 ? 'ambiguous' : !complete ? 'incomplete' : development.length === 1 ? 'matched' : 'unmatched',
    development: development.length === 1 ? development[0] : null,
    release: open.length === 1 ? open[0] : null,
    releaseStatus: open.length > 1 ? 'ambiguous' : open.length === 1 ? 'tag-match' : 'unverified',
    candidates: [...development, ...open], issues,
  };
}

export function withSourceSnapshot(source, fn) {
  const temp = mkdtempSync(join(tmpdir(), 'ios-agent-source-'));
  try {
    // Materialize only normal files from the exact Git commit. No project hooks, builds, or symlinks.
    const archive = run('git', ['-C', source.path, 'archive', '--format=tar', source.sha,
      ...(source.folder ? ['--', source.folder] : [])], { encoding: null, maxBuffer: 160 * 1024 * 1024 });
    run('tar', ['-xf', '-', '-C', temp], { input: archive });
    const removeLinks = (dir) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) rmSync(path);
        else if (stat.isDirectory()) removeLinks(path);
      }
    };
    removeLinks(temp);
    return fn(join(temp, source.folder));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function inspectSource(source) {
  const allowed = new Set([...source.docs, ...source.evidence]);
  return tree(source.path, source.sha).filter(({ file }) => allowed.has(file)).slice(0, 12).map(({ file, oid }) => {
    const contents = git(source.path, ['cat-file', 'blob', oid]);
    const lines = contents.split('\n');
    if (ID_FILE.test(file)) return { file, excerpt: lines.filter((line) =>
      /PRODUCT_BUNDLE_IDENTIFIER|MARKETING_VERSION|CURRENT_PROJECT_VERSION|CFBundleIdentifier|CFBundleShortVersionString|bundleIdentifier/.test(line))
      .filter((line) => line.length < 300).slice(0, 20).join('\n') };
    return { file, excerpt: lines.slice(0, 32).filter((line) => !/token|api.key|password|secret|private.key|credential/i.test(line)).join('\n').slice(0, 2200) };
  });
}

// Read-only code access at an exact commit, scoped to the app folder. Secret-looking lines are redacted.
const CODE = /\.(swift|m|mm|h|c|cpp|kt|java|dart|ts|tsx|js|jsx|json|plist|strings|stringsdict|xcstrings|md|txt|yml|yaml|storyboard|xib|entitlements|xcprivacy|gradle|podspec|resolved)$/i;
const SECRET = /(api[_-]?key|secret|token|password|passwd|private[_-]?key|client[_-]?secret|bearer|authorization|-----BEGIN)/i;
const scoped = (source, file) => !source.folder || file.startsWith(source.folder + '/');
export function codeIndex(source, limit = 600) {
  const files = tree(source.path, source.sha).filter((e) => scoped(source, e.file) && CODE.test(e.file));
  return { total: files.length, truncated: files.length > limit,
    files: files.slice(0, limit).map(({ file, size }) => ({ file, size })) };
}
export function readCode(source, file) {
  if (typeof file !== 'string' || !file || file.includes('..') || !CODE.test(file)) throw new Error('Read a text source file listed by inspect (no path traversal)');
  const entry = tree(source.path, source.sha).find((e) => e.file === file && scoped(source, e.file));
  if (!entry) throw new Error('File not found in the app folder at ' + source.sha.slice(0, 12) + '; use inspect without --file for the index');
  const lines = git(source.path, ['cat-file', 'blob', entry.oid]).split('\n');
  return { file, sha: source.sha, lines: lines.length, redacted: lines.filter((l) => SECRET.test(l)).length,
    text: lines.map((l, i) => (i + 1) + ': ' + (SECRET.test(l) ? '[redacted: possible secret]' : l.slice(0, 400))).join('\n').slice(0, 120_000) };
}
export function searchCode(source, query) {
  if (typeof query !== 'string' || query.trim().length < 2 || query.length > 100) throw new Error('Search for 2-100 characters');
  let out = '';
  try {
    out = run('git', ['-C', source.path, 'grep', '-n', '-I', '-i', '--fixed-strings', '--max-count=20', '-e', query, source.sha, '--',
      ...(source.folder ? [source.folder] : ['.'])], { timeout: 30_000 });
  } catch (error) { if (error.status !== 1) throw new Error('Code search failed'); }
  const hits = out.split('\n').filter(Boolean).map((line) => {
    const [, file, number, text] = line.match(/^[^:]+:([^:]+):(\d+):(.*)$/) ?? [];
    return file && CODE.test(file) ? { file, line: Number(number), text: SECRET.test(text) ? '[redacted]' : text.trim().slice(0, 240) } : null;
  }).filter(Boolean);
  return { query, sha: source.sha, hits: hits.slice(0, 80), truncated: hits.length > 80 };
}
