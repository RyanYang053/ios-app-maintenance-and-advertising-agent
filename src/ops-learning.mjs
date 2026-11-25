// Portions ported from ASO Studio scheduler.ts (MIT, Copyright 2026 Nomly)
// and Hermes tools/memory_tool_store.py (MIT, Copyright 2025 Nous Research).
// See third-party/ for licenses and pinned provenance.
import {appId,assertEvidenceApp} from './app-context.mjs';
const DAY=86400000;
const text=(x,n=500)=>typeof x==='string'&&x.trim().length>0&&x.length<=n;
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const count=x=>Number.isSafeInteger(x)&&x>=0;
const date=x=>new Date(x).toISOString().slice(0,10);
const stamp=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&Number.isFinite(Date.parse(x))&&date(x)===x;
const norm=s=>String(s).replace(/\\n/g,' ').replace(/["\x60\u2018-\u201f]/g,"'").replace(/[\u2010-\u2015\u2212]/g,'-').trim().replace(/\s+/g,' ');
export function weekdayFor(keyword,storefront){
  const s=storefront.toLowerCase()+'|'+keyword.trim().toLowerCase();
  let h=0x811c9dc5;
  for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0;}
  return h%7;
}
export function uniqueMemoryMatch(entries,oldText){
  const exact=entries.map((e,i)=>e===oldText?i:-1).filter(i=>i>=0);
  let matches=exact.length?exact:entries.map((e,i)=>e.includes(oldText)?i:-1).filter(i=>i>=0);
  if(!matches.length&&/[\p{L}\p{N}]/u.test(norm(oldText)))matches=entries.map((e,i)=>norm(e).includes(norm(oldText))?i:-1).filter(i=>i>=0);
  if(!/[\p{L}\p{N}]/u.test(norm(oldText)))return {index:null,ambiguous:false};
  return new Set(matches.map(i=>entries[i])).size>1?{index:null,ambiguous:true}:{index:matches[0]??null,ambiguous:false};
}
export function keywordPlan(db,id,config,now){
  appId(id);
  const policy=config.loop?.apps?.[id]?.aso??{};
  const keywords=policy.keywords??[],countries=policy.storefronts??[];
  if(!Array.isArray(keywords)||!Array.isArray(countries)||keywords.length>50||countries.length>10||
     keywords.some(k=>!text(k,100))||countries.some(c=>typeof c!=='string'||!/^[A-Z]{2}$/.test(c)))throw Error('Configure up to 50 keywords and 10 ISO storefronts');
  const today=date(now),hist=db.opsEvidence(id,'rank'), rows=[];
  for(const keyword of [...new Set(keywords.map(k=>k.trim().toLowerCase()))])for(const country of [...new Set(countries)]){
    const prior=hist.filter(r=>r.keyword===keyword&&r.country===country&&r.source==='itunes-search');
    const latest=prior.find(r=>r.status==='observed'),first=prior.at(-1);
    const daily=!latest||latest.rank!==null&&latest.rank<=50||first&&(Date.parse(today)-Date.parse(first.observedOn))/DAY<7;
    const elapsed=latest?(Date.parse(today)-Date.parse(latest.observedOn))/DAY:Infinity;
    if(elapsed>=1&&(daily||weekdayFor(keyword,country)===new Date(today).getUTCDay()||elapsed>=7))
      rows.push({keyword,country,reason:daily?'daily':'weekly',ageDays:Number.isFinite(elapsed)?elapsed:null});
  }
  return {appId:id,source:'itunes-search',notice:'Public iTunes Search API ordering, NOT native App Store rank. Do not compare across sources.',due:rows,history:hist.slice(0,50)};
}
export async function checkKeyword(db,id,config,input,now,fetcher=fetch){
  assertEvidenceApp(id,input);
  const plan=keywordPlan(db,id,config,now);
  const keyword=typeof input.keyword==='string'?input.keyword.trim().toLowerCase():'';
  const country=input.country;
  if(!plan.due.some(r=>r.keyword===keyword&&r.country===country))throw Error('Keyword/storefront not configured or not due');
  // Reserve one global request every 6 seconds and honor HTTP rate limits across apps/processes.
  db.reservePublicRequest(Date.parse(now));
  const params=new URLSearchParams({term:keyword,country:country.toLowerCase(),media:'software',entity:'software',limit:'200'});
  let response;
  try{response=await fetcher('https://itunes.apple.com/search?'+params,{redirect:'error',headers:{Accept:'application/json'},signal:AbortSignal.timeout(15000)});}
  catch{throw Error('Public search unavailable; no rank recorded');}
  if([403,429].includes(response.status)){db.pausePublicRequests(Date.parse(now)+300000);throw Error('Apple rate limited; wait at least five minutes');}
  if(!response.ok)throw Error('Public search unavailable; no rank recorded');
  const data=await response.json();
  if(!Array.isArray(data.results)||data.results.length>200||data.results.some(r=>!r||!Number.isSafeInteger(r.trackId)||r.trackId<=0))throw Error('Unexpected search schema; no rank recorded');
  const ids=data.results.map(r=>String(r.trackId));
  const rank=ids.indexOf(id)+1||null;
  const row={appId:id,source:'itunes-search',observedOn:date(now),keyword,country,status:'observed',rank,resultCount:ids.length,
    competitors:data.results.filter(r=>String(r.trackId)!==id).slice(0,10).map(r=>({appId:String(r.trackId),name:String(r.trackName??'').slice(0,120),genre:String(r.primaryGenreName??'').slice(0,80)}))};
  return db.saveOpsEvidence(id,'rank',country+'|'+keyword+'|'+row.observedOn,row);
}
export function recordHealth(db,id,input,now){
  assertEvidenceApp(id,input);
  const {start,end,source,scope,metrics,incidents=[]}=input;
  if(!stamp(start)||!stamp(end)||Date.parse(end)-Date.parse(start)!==6*DAY||end>=date(now)||!text(source)||!text(scope)||
    !metrics||typeof metrics!=='object'||Array.isArray(metrics)||!Object.keys(metrics).length||
    Object.entries(metrics).some(([k,v])=>!['downloads','sessions','crashes','deletions','rating','ratingCount','proceeds'].includes(k)||!finite(v)||v<0||(['downloads','sessions','crashes','deletions','ratingCount'].includes(k)&&!count(v))||(k==='rating'&&v>5))||
    (metrics.proceeds!==undefined&&!/^[A-Z]{3}$/.test(input.currency??''))||
    !Array.isArray(incidents)||incidents.length>100||incidents.some(i=>!text(i.signature,200)||!text(i.os,40)||!text(i.evidence)||!count(i.occurrences)||i.occurrences<1))
      throw Error('Provide complete 7-day scoped health export and sanitized incident signatures');
  const prior=db.opsEvidence(id,'health').find(r=>r.source===source&&r.scope===scope&&r.currency===(input.currency??null)&&Date.parse(start)-Date.parse(r.end)===DAY);
  const alerts=[];
  for(const k of Object.keys(metrics)){
    const p=prior?.metrics[k],v=metrics[k];
    if(!finite(p))continue;
    if(['downloads','sessions','proceeds'].includes(k)&&p>=20&&Math.abs(v-p)/p>=.3)alerts.push({metric:k,before:p,after:v});
    if(k==='crashes'&&v>=3&&(p===0||v>=p*1.5))alerts.push({metric:k,before:p,after:v});
    if(k==='rating'&&prior.metrics.ratingCount>=20&&p-v>=.2-1e-9)alerts.push({metric:k,before:p,after:v});
  }
  const clusters=new Map();
  for(const i of incidents){const key=norm(i.signature)+'|'+i.os;const old=clusters.get(key);clusters.set(key,{signature:i.signature,os:i.os,occurrences:(old?.occurrences??0)+i.occurrences,evidence:[...new Set([...(old?.evidence??[]),i.evidence])]});}
  const row={appId:id,start,end,source,scope,currency:input.currency??null,metrics,alerts,clusters:[...clusters.values()].sort((a,b)=>b.occurrences-a.occurrences).slice(0,10),
    notice:'Read-only health triage. Confirm incident evidence and create separately approved development task.'};
  return db.saveOpsEvidence(id,'health',JSON.stringify([source,scope,input.currency??null,end]),row);
}
export function forecast(db,id,input,now){
  assertEvidenceApp(id,input);
  const task=db.operation(input.taskId,id);
  if(!task||task.status!=='queued'||!['promotion','feature'].includes(task.kind)||!finite(input.expected)||input.expected<0||!text(input.rationale)||!text(input.failureCondition))throw Error('Forecast requires a queued same-app task, expected metric and falsifier');
  const metric=task.kind==='promotion'?'downloads':task.impact?.metric;
  if(!metric||input.metric!==metric)throw Error('Forecast metric must match task measurement');
  return db.saveOpsEvidence(id,'forecast',String(task.id),{appId:id,taskId:task.id,metric,expected:input.expected,rationale:input.rationale,failureCondition:input.failureCondition,recordedAt:now});
}
export function learningReview(db,id,now){
  const forecasts=db.opsEvidence(id,'forecast').map(f=>{
    const t=db.operation(f.taskId,id);
    const actual=t?.kind==='promotion'?t.outcome?.downloads:t?.outcome?.value;
    return {...f,actual:t?.status==='closed'&&finite(actual)?actual:null,error:t?.status==='closed'&&finite(actual)?actual-f.expected:null,verdict:t?.outcome?.verdict??null};
  });
  const lessons=db.lessons(id).filter(l=>l.current);
  return {appId:id,forecasts,knowledgeReview:lessons.map(l=>{
    const ageDays=(Date.parse(now)-Date.parse(l.recordedAt))/DAY;
    const duplicate=uniqueMemoryMatch(lessons.filter(x=>x.domain===l.domain&&x.key!==l.key).map(x=>x.rule),l.rule);
    return {domain:l.domain,key:l.key,revision:l.revision,reviewDue:ageDays>=90||duplicate.index!==null||duplicate.ambiguous,possibleDuplicate:duplicate.index!==null||duplicate.ambiguous,ageDays:Math.floor(ageDays)};
  }),health:db.opsEvidence(id,'health').slice(0,8),notice:'Review stale/overlapping rules and forecast errors; corrections use a new version. Never delete evidence automatically.'};
}
