import { existsSync, mkdirSync, lstatSync, realpathSync, symlinkSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { readJson, run } from '../src/io.mjs';

const root = resolve(import.meta.dirname, '..');
const repos = readJson(join(root, 'upstream.json'));
const targets = [join(root,'.agents','skills'),join(root,'.claude','skills')];
for(const target of targets) mkdirSync(target,{recursive:true});
function linkSkill(source,target,name) {
  const link=join(target,name);
  let existing;
  try {existing=lstatSync(link);} catch(e) {if(e.code!=='ENOENT') throw e;}
  if(existing) {
    if(realpathSync(link)!==realpathSync(source)) throw new Error('Skill path already used: '+link);
    return;
  }
  symlinkSync(process.platform==='win32'?resolve(source):relative(target,source),link,process.platform==='win32'?'junction':'dir');
}
linkSkill(join(targets[0],'ios-app-operator'),targets[1],'ios-app-operator');
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
    for(const target of targets) linkSkill(source,target,name);
  }
  console.log(item.checkout + ' @ ' + item.revision.slice(0, 12));
}
