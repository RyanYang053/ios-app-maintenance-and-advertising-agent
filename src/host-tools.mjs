import { execFile } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { appFolder } from './app-context.mjs';

export const actions = Object.freeze({
  'keyword-plan': 'Plan app-specific keyword refresh',
  screenshot: 'Render a local opaque App Store PNG draft from an approved app capture',
  'ppo-plan': 'Record app-specific product page optimization draft',
  'ppo-result': 'Record matched completed Apple PPO report',
  'rank-import': 'Import verified native storefront search results without mixing rank sources',
  'keyword-check': 'Read one configured public iTunes search and save evidence',
  'health-scan': 'Fetch scoped recent TestFlight and performance diagnostics',
  'health-record': 'Import app-specific weekly health evidence',
  forecast: 'Record a pre-action expected outcome',
  'learning-review': 'Compare predictions and identify stale knowledge',
  context: 'Read only the selected app knowledge, progress and skill revisions',
  'lesson-retire': 'Retire an app lesson by app and revision while retaining history',
  lesson: 'Record an app-specific skill lesson from closed outcomes',
  apps: 'List authorized Apple apps',
  scan: 'Scan Apple data, release status, compliance and growth signals; save local evidence',
  cycle: 'Run portfolio operations and reconcile release or impact evidence',
  portfolio: 'Prioritize across apps using recent evidence and cohort contribution',
  'store-observe': 'Queue proactive App Store maintenance from verified evidence',
  research: 'Persist dated competitor, customer, channel or cohort evidence locally',
  memory: 'Read persistent per-app outcomes and qualified channel evidence',
  feedback: 'Read recent customer reviews as untrusted evidence',
  inspect: 'Inspect verified read-only app source excerpts',
  history: 'Read prior scans and experiments',
  task: 'Read operation and event history',
  observe: 'Queue an evidenced feature proposal locally',
  handoff: 'Prepare sanitized development handoff locally; no external dispatch',
  'dispatch-preview': 'Preview exact external issue; owner must dispatch separately',
  advance: 'Record verified operation evidence or acceptance locally',
  'store-draft': 'Save exact proposed store changes locally',
  brief: 'Save promotion brief locally',
  'release-confirm': 'Record the commit that built the live version when no Git tag matches',
  storyboard: 'Validate and save an agent-authored video storyboard (OpenDesign-guided)',
  'content-plan': 'Record a weekly multi-channel posting calendar',
  'ads-plan': 'Preview an exact Apple Ads campaign for owner approval; spends nothing',
  video: 'Check, render and review a storyboard video (or legacy brief + screenshot) inside the operator workspace',
  record: 'Record observed experiment evidence locally',
  browser: 'Return the approved platform dashboard URL'
});
const platforms = ['asc','ads','tiktok','instagram','youtube','x','reddit','linkedin'];
const newInputs = ['release-confirm','storyboard','content-plan','ads-plan'];
const appRequired = new Set([...newInputs,'lesson-retire','screenshot','ppo-plan','ppo-result','rank-import','health-scan','keyword-plan','keyword-check','health-record','forecast','learning-review','context','lesson','task','handoff','advance','dispatch-preview','video','feedback','inspect','history','observe','research','store-observe','store-draft','brief','record']);
const taskRequired = new Set(['task','handoff','dispatch-preview','advance']);
export const inputRequired = new Set([...newInputs,'lesson-retire','screenshot','ppo-plan','ppo-result','rank-import','keyword-check','health-record','forecast','lesson','observe','advance','research','store-observe','store-draft','brief','record']);
const inputAllowed = new Set([...inputRequired,'handoff']);
function inside(root, path) {
  const base = realpathSync(root);
  const dest = realpathSync(resolve(base,path));
  const rel = relative(base,dest);
  if (!rel || rel === '..' || rel.startsWith('..'+sep) || isAbsolute(rel)) throw new Error('Asset must be within approved workspace');
  return dest;
}
export function buildInvocation(root, action, args = {}) {
  if (!Object.hasOwn(actions, action)) throw new Error('Unsupported operator action');
  const allowed = new Set([
    ...(['scan','cycle','memory','portfolio',...appRequired].includes(action)?['app']:[]),
    ...(taskRequired.has(action)?['task']:[]),
    ...(['scan','cycle'].includes(action)?['days']:[]),
    ...(action==='cycle'?['cached','outcomesJson']:[]),
    ...(['apps','scan','cycle'].includes(action)?['metricsJson']:[]),
    ...(inputAllowed.has(action)?['inputJson']:[]),
    ...(action==='inspect'?['release']:[]),
    ...(action==='browser'?['platform']:[]),
    ...(action==='video'?['brief','screenshot','storyboard']:[]),
    ...(action==='screenshot'?['screenshot']:[])
  ]);
  for (const k of Object.keys(args)) if (args[k]!==undefined && !allowed.has(k)) throw new Error('Unexpected option: '+k);
  const argv = [resolve(root,'src/cli.mjs'),action];
  if (appRequired.has(action) && args.app===undefined) throw new Error('App ID required');
  if (args.app!==undefined) {
    if (typeof args.app!=='string' || !/^\d+$/.test(args.app)) throw new Error('Invalid app ID');
    argv.push('--app',args.app);
  }
  if (taskRequired.has(action)) {
    if (!Number.isSafeInteger(args.task) || args.task<1) throw new Error('Task ID required');
    argv.push('--task',String(args.task));
  }
  if (args.days!==undefined) {
    if (!Number.isInteger(args.days)||args.days<1||args.days>30) throw new Error('Invalid days');
    argv.push('--days',String(args.days));
  }
  for (const key of ['cached','release']) if (args[key]===true) argv.push('--'+key);
  if (action==='browser') {
    if (!platforms.includes(args.platform)) throw new Error('Invalid platform');
    argv.push('--platform',args.platform);
  }
  if (action==='video'||action==='screenshot') {
    let config={};
    try { config=JSON.parse(readFileSync(resolve(root,'agent.config.json'),'utf8')); }
    catch(e) { if(e.code!=='ENOENT') throw e; }
    const state=resolve(root,config.stateDir??'.agent-data');
    if(action==='video'&&args.storyboard!==undefined){
      if(args.brief!==undefined||args.screenshot!==undefined)throw Error('Use --storyboard alone, or the legacy --brief with --screenshot');
      argv.push('--storyboard',inside(appFolder(resolve(state,'drafts'),args.app),args.storyboard));
    } else {
      if(!args.screenshot||(action==='video'&&!args.brief))throw Error(action==='video'?'Provide --storyboard FILE (in drafts/APP_ID), or legacy --brief and --screenshot':'Provide --screenshot FILE in assets/APP_ID');
      if(action==='video')argv.push('--brief',inside(appFolder(resolve(state,'drafts'),args.app),args.brief));
      argv.push('--screenshot',inside(appFolder(resolve(state,'assets'),args.app),args.screenshot));
    }
  }
  if(inputRequired.has(action)&&args.inputJson===undefined) throw new Error('Evidence input required');
  const inputs=['inputJson','metricsJson','outcomesJson'].filter(k=>args[k]!==undefined);
  if(inputs.length>1) throw new Error('Import one evidence payload per call');
  let stdin;
  if(inputs.length) {
    const k=inputs[0], value=args[k];
    if(typeof value!=='string'||Buffer.byteLength(value)>750000) throw new Error('Evidence JSON too large or invalid');
    const parsed=JSON.parse(value);
    if(k==='outcomesJson'?!Array.isArray(parsed):(!parsed||typeof parsed!=='object'||Array.isArray(parsed))) throw new Error('Invalid evidence shape');
    if(k==='inputJson'&&args.app!==undefined&&parsed.appId!==args.app)throw Error('Evidence appId must match --app');
    if(k==='outcomesJson'&&(!args.app||parsed.some(row=>row?.appId!==args.app)))throw Error('Import outcomes one app at a time with explicit matching appId');
    if(k==='metricsJson'&&args.app&&(Object.keys(parsed.byApp??{}).some(id=>id!==args.app)|| (parsed.apps??[]).some(a=>a.id!==args.app)))throw Error('Metrics contain a different app');
    stdin=JSON.stringify(parsed);
    argv.push('--'+k.replace('Json',''),'-');
  }
  return {argv,stdin};
}
export function scopedResult(action,args,data){
  if(args.app)return data;
  if(action==='scan')return data.map(s=>({app:s.app,capturedAt:s.capturedAt,storeStatus:s.store?.status,
    liveVersion:s.store?.data?.live?.version,sourceStatus:s.source?.status,
    complianceStatus:s.compliance?.status,priority:s.decision?.recommendation?.priority}));
  if(action==='cycle')return {...data,apps:data.apps.map(({appId,appName,status,latestScan,created,updated,due,learning,feedback})=>
    ({appId,appName,status,latestScan,created,updated,due,learning,reviewCount:feedback?.data?.count??null}))};
  return data;
}
// The owner CLI prints only sanitized messages (validation text or a generic tool failure),
// so its stderr is safe to relay; it is what lets the agent correct its input.
export function failureDetail(stderr) {
  const lines=String(stderr??'').split(/\r?\n/).filter(line=>line.trim()&&!/^\(node:\d+\)|ExperimentalWarning|--trace-warnings/.test(line));
  const detail=lines.join('\n').slice(0,4000);
  return detail?'Operator command failed: '+detail:'Operator command failed without a message; check local setup (doctor) or run the command with valid input';
}
export async function runHostTool(root,action,args) {
  const {argv,stdin}=buildInvocation(root,action,args);
  return await new Promise((done,fail)=>{
    const child=execFile(process.execPath,['--disable-warning=ExperimentalWarning',...argv],{cwd:root,timeout:action==='video'?1800000:600000,maxBuffer:24*1024*1024,windowsHide:true},(err,out,errOut)=>{
      if(err) return fail(new Error(err.killed?'Operator command timed out':failureDetail(errOut)));
      try {done(scopedResult(action,args,JSON.parse(out)));} catch {fail(new Error('Invalid operator response'));}
    });
    child.stdin.on('error',()=>{});
    child.stdin.end(stdin);
  });
}
