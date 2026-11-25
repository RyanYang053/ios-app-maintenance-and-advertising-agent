import { existsSync, mkdirSync, lstatSync, readlinkSync, symlinkSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { readJson, run } from '../src/io.mjs';

const root = resolve(import.meta.dirname, '..');
const repos = readJson(join(root, 'upstream.json'));
const target = join(root, '.agents', 'skills');
const checkouts = join(root, '.agent-data', 'upstream');
mkdirSync(checkouts, { recursive: true, mode: 0o700 });

for (const item of repos.filter((item) => item.checkout)) {
  if (item.checkout === 'compliance' && !process.argv.includes('--with-compliance')) continue;
  const dir = join(checkouts, item.checkout);
  if (!existsSync(dir)) {
    mkdirSync(dir, { mode: 0o700 });
    run('git', ['-C', dir, 'init', '--quiet']);
    run('git', ['-C', dir, 'remote', 'add', 'origin', item.url + '.git']);
  }
  const git = (args) => run('git', ['-C', dir, ...args], { timeout: 240_000 }).trim();
  if (git(['remote', 'get-url', 'origin']) !== item.url + '.git') throw new Error('Unexpected remote at ' + dir);
  let current;
  try { current = git(['rev-parse', 'HEAD']); } catch { current = null; }
  if (current !== item.revision) {
    if (git(['status', '--porcelain'])) throw new Error('Local upstream edits at ' + dir);
    git(['fetch', '--depth=1', 'origin', item.revision]);
    git(['checkout', '--detach', item.revision]);
  }
  for (const path of item.skills ?? []) {
    const name = path.split('/').at(-1);
    const source = join(dir, path);
    if (!existsSync(join(source, 'SKILL.md'))) throw new Error('Missing pinned skill: ' + path);
    // Skill docs are loaded by path with their upstream references intact.
    const link = join(target, name);
    const linkPath = relative(target, source);
    let existing;
    try { existing = lstatSync(link); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing && (!existing.isSymbolicLink() || readlinkSync(link) !== linkPath)) throw new Error('Skill path already used: ' + link);
    if (!existing) symlinkSync(linkPath, link, 'junction');
  }
  console.log(item.checkout + ' @ ' + item.revision.slice(0, 12));
}
