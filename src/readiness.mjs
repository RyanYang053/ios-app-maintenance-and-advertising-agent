import { existsSync,readFileSync,accessSync,constants } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { skillCatalog } from './host-skills.mjs';
import { appleClient } from './apple.mjs';
import { accountScopes,appAccount,verifiedInventory } from './account-scope.mjs';

const result=(name,status,detail)=>({name,status,detail});
const placeholder=x=>typeof x==='string'&&/OWNER\/REPOSITORY|\/absolute\/path\/to\/|^MyApps$|^MyAppleAds$/.test(x);
function probe(command,args) {
  try {
    const r=spawnSync(command,args,{encoding:'utf8',timeout:10000,windowsHide:true,stdio:['ignore','pipe','pipe']});
    return !r.error&&r.status===0;
  } catch{return false;}
}
export function readiness(root,{live=false,probeCommand=probe,inventory=null}={}) {
  const checks=[];
  const put=(...args)=>checks.push(result(...args));
  const [major,minor]=process.versions.node.split('.').map(Number);
  put('node',major>22||major===22&&minor>=13?'PASS':'FAIL','Node.js 22.13+ required');
  const file=resolve(root,'agent.config.json');
  let cfg={};
  try{
    cfg=JSON.parse(readFileSync(file,'utf8'));
    if(!cfg||typeof cfg!=='object'||Array.isArray(cfg))throw Error();
    put('config','PASS','Local configuration parses');
  }catch{cfg={};put('config','BLOCKED','Run node scripts/setup-local.mjs and review agent.config.json');}
  const dir=resolve(root,cfg.stateDir??'.agent-data');
  try{
    for(const p of ['imports','assets','drafts']) accessSync(resolve(dir,p),constants.R_OK|constants.W_OK);
    const db=new DatabaseSync(':memory:');
    try{db.exec('CREATE TABLE readiness_test(x INTEGER); INSERT INTO readiness_test VALUES(1)');}
    finally{db.close();}
    if(existsSync(resolve(dir,'history.sqlite'))){
      const db=new DatabaseSync(resolve(dir,'history.sqlite'),{readOnly:true});
      try{const row=db.prepare('PRAGMA quick_check').get();if(!Object.values(row).includes('ok'))throw Error();}
      finally{db.close();}
    }
    put('local-state','PASS','Writable workspace and SQLite check; existing ledger checked read-only');
  }catch{put('local-state','BLOCKED','Create or repair the configured state directory; retain any existing ledger');}
  try{
    const rows=skillCatalog(root),missing=rows.filter(x=>!x.installed).map(x=>x.name);
    put('skills',missing.length?'BLOCKED':'PASS',missing.length?'Run setup-local.mjs; missing: '+missing.join(', '):rows.length+' skills present');
  }catch{put('skills','BLOCKED','Check pinned skill inventory');}
  for(const name of ['.agents/skills/ios-app-operator/SKILL.md','.claude/skills/ios-app-operator/SKILL.md','AGENTS.md','CLAUDE.md']){
    put(name,existsSync(resolve(root,name))?'PASS':'BLOCKED','Native project skill or instruction file');
  }
  put('git',probeCommand('git',['--version'])?'PASS':'BLOCKED','Required for source inspection and upstream checkout');
  const asc=probeCommand(cfg.asc?.cli??'asc',['--version']);
  put('asc-cli',asc?'PASS':'BLOCKED','Install the documented ASC CLI; browser exports are a limited fallback');
  const specs=cfg.github?.repos??[];
  const sources=(Array.isArray(specs)&&specs.some(x=>x&&(x.path||x.repo)&&!placeholder(x.path)&&!placeholder(x.repo)))||
    (typeof cfg.github?.owner==='string'&&cfg.github.owner.length>0);
  put('source-config',sources?'PASS':'BLOCKED','Configure real local/GitHub app sources or an authorized owner; source matches verified during scan');
  if(cfg.github?.owner)put('gh-cli',probeCommand('gh',['--version'])?'PASS':'BLOCKED','Required for owner repository discovery; auth checked during scan');
  let scopedIds=[];
  try{scopedIds=accountScopes(cfg);put('account-routing','PASS',scopedIds.length?'Explicit app profiles configured':'Shared account mode; not credential isolation');}catch{put('account-routing','BLOCKED','Invalid per-app profiles; fix configuration');}
  put('sales-vendor',(scopedIds.length?scopedIds.every(id=>cfg.appAccounts[id].vendor):cfg.asc?.vendor||process.env.ASC_VENDOR_NUMBER)?'PASS':'BLOCKED','Vendor number required for Sales and Trends API; scoped report import is possible');
  put('ads-account',cfg.ads?.accounts?.length||process.env.ASC_ADS_AD_ACCOUNT_ID?'PASS':'OPTIONAL','Needed only to read paid Apple Ads accounts');
  const configured=Object.entries(cfg.loop?.apps??{}).filter(([id,p])=>/^\d+$/.test(id)&&p?.market&&p?.channels?.length);
  put('promotion-policy',configured.length?'PASS':'BLOCKED','Set real App Store IDs, markets, allowed channels and cost limits');
  put('labor-cost',cfg.loop?.hourlyRate!=null||configured.some(([,p])=>p.hourlyRate!=null)?'PASS':'OPTIONAL','Price labor for comparable total acquisition cost');
  let gsap=false;try{createRequire(resolve(root,'package.json')).resolve('gsap/dist/gsap.min.js');gsap=true;}catch{}
  const video=gsap&&probeCommand('ffmpeg',['-version'])&&probeCommand('ffprobe',['-version']);
  put('video-prerequisites',video?'PASS':'OPTIONAL','GSAP, FFmpeg and FFprobe; actual HyperFrames/Chromium render still requires a smoke test');
  put('video-engine',probeCommand(process.platform==='win32'?'npx.cmd':'npx',['--version'])?'PASS':'OPTIONAL','npx runs pinned hyperframes@0.9.95 check and render for storyboard videos; owner smoke test: RUN_VIDEO_SMOKE=1 node --test test/storyboard.test.mjs');
  put('compliance-scanner',cfg.compliance?.checkout&&existsSync(resolve(root,cfg.compliance.checkout))?'PASS':'OPTIONAL','Optional licensed compliance scanner; install only after license review');
  if(live){
    try{
      const apps=inventory?inventory():scopedIds.length?scopedIds.flatMap(id=>{const scope=appAccount(cfg,id);return verifiedInventory({apps:appleClient(scope.asc).apps()},scope).apps;}):appleClient(cfg.asc).apps();
      if(!Array.isArray(apps))throw Error();
      put('apple-inventory',apps.length?'PASS':'BLOCKED',apps.length+' authorized apps returned; confirm intended team');
      const ids=new Set(configured.map(([id])=>id));
      const missing=apps.filter(a=>!ids.has(a.id)).map(a=>a.id);
      put('all-app-policies',apps.length&&!missing.length?'PASS':'BLOCKED',missing.length?'Configure promotion policies for App IDs: '+missing.join(', '):'Every returned app has a market/channel policy (or no apps returned)');
    }catch{put('apple-inventory','BLOCKED','Read-only ASC inventory failed; verify CLI install, auth, profile and network');}
  }else put('apple-inventory','BLOCKED','Not tested. Run doctor --live after authenticating; read-only request');
  put('actual-hosts','BLOCKED','Run guide, doctor --live, memory and a one-app scan in each installed desktop host');
  put('external-execution','BLOCKED','Validate real account permissions, approved publication/Apple edits, developer receiver and outcome evidence');
  return {mode:live?'live-read-only':'local',checks,localPrerequisites:checks.filter(x=>!['actual-hosts','external-execution','apple-inventory','all-app-policies'].includes(x.name)).every(x=>['PASS','OPTIONAL'].includes(x.status)),productionVerified:false,notice:'Prerequisite checks are not live end-to-end acceptance. No external writes or purchases performed.'};
}
