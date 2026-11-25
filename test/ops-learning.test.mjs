import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {state} from '../src/state.mjs';
import {weekdayFor,uniqueMemoryMatch,keywordPlan,checkKeyword,importNativeRank,recordHealth,forecast,learningReview} from '../src/ops-learning.mjs';
import {buildInvocation} from '../src/host-tools.mjs';
const now='2026-11-25T15:00:00Z';
function workspace(t){
 const dir=mkdtempSync(join(tmpdir(),'ops-learning-'));const db=state(dir);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});return db;
}
test('MIT ports preserve deterministic weekday and safe ambiguous memory matching',()=>{
 assert.equal(weekdayFor('Fit','CA'),weekdayFor('fit','ca'));
 assert.deepEqual(uniqueMemoryMatch(['A — B','C'],'A - B'),{index:0,ambiguous:false});
 assert.equal(uniqueMemoryMatch(['one test','two test'],'test').ambiguous,true);
 assert.equal(uniqueMemoryMatch(['one test','test'],'test').index,1);
});
test('rank planning and HTTP observations remain app-scoped and rate-limited',async t=>{
 const db=workspace(t);
 const cfg={loop:{apps:{'123':{aso:{keywords:['Workout'],storefronts:['CA']}},'456':{aso:{keywords:['Fishing'],storefronts:['CA']}}}}};
 assert.equal(keywordPlan(db,'123',cfg,now).due.length,1);
 const result=await checkKeyword(db,'123',cfg,{appId:'123',keyword:'workout',country:'CA'},now,async url=>{
  assert.match(url,/itunes\.apple\.com\/search/);
  return {ok:true,status:200,json:async()=>({results:[{trackId:789,trackName:'Rival'},{trackId:123}]})};
 });
 assert.equal(result.rank,2);
 assert.equal(keywordPlan(db,'123',cfg,now).due.length,0);
 assert.equal(keywordPlan(db,'456',cfg,now).history.length,0);
 await assert.rejects(checkKeyword(db,'456',cfg,{appId:'456',keyword:'fishing',country:'CA'},now,async()=>{}),/cooldown/);
 await assert.rejects(checkKeyword(db,'456',cfg,{appId:'456',keyword:'fishing',country:'CA'},'2026-11-25T15:00:07Z',async()=>({ok:false,status:429})),/rate limited/);
 assert.equal(db.opsEvidence('456','rank').length,0);
 await assert.rejects(checkKeyword(db,'456',cfg,{appId:'456',keyword:'fishing',country:'CA'},'2026-11-25T15:01:00Z',async()=>{}),/cooldown/);
});
test('weekly health alerts, incident dedup and forecast error use only matched app evidence',t=>{
 const db=workspace(t);
 const report={appId:'123',source:'ASC report',scope:'CA iOS',start:'2026-11-10',end:'2026-11-16',metrics:{downloads:100,crashes:2}};
 recordHealth(db,'123',report,now);
 const current={...report,start:'2026-11-17',end:'2026-11-23',metrics:{downloads:60,crashes:4},incidents:[
  {signature:'View — crash',os:'iOS 27',occurrences:2,evidence:'trace A'},
  {signature:'View - crash',os:'iOS 27',occurrences:3,evidence:'trace B'}]};
 const observed=recordHealth(db,'123',current,now);
 assert.equal(observed.alerts.length,2);assert.equal(observed.clusters[0].occurrences,5);
 assert.throws(()=>recordHealth(db,'123',current,now),/already exists/);
 assert.throws(()=>recordHealth(db,'456',current,now),/match/);
 const task=db.enqueue({appId:'123',key:'promo',kind:'promotion',status:'queued'},now);
 const payload={appId:'123',taskId:task.id,metric:'downloads',expected:50,rationale:'prior test',failureCondition:'below target'};
 forecast(db,'123',payload,now);
 assert.throws(()=>forecast(db,'123',payload,now),/already exists/);
 assert.throws(()=>forecast(db,'456',{...payload,appId:'456'},now));
 db.updateOperation(task,{status:'closed',outcome:{downloads:30,verdict:'below download floor'}},'measured',now);
 assert.equal(learningReview(db,'123',now).forecasts[0].error,-20);
 assert.equal(learningReview(db,'456',now).forecasts.length,0);
 assert.throws(()=>buildInvocation('/tmp','forecast',{app:'456',inputJson:JSON.stringify(payload)}));
});

import {accountScopes,appAccount,verifiedInventory} from '../src/account-scope.mjs';
test('explicit per-app account routing fails closed on missing profile, wrong bundle and duplicate profile',()=>{
 const cfg={appAccounts:{'123':{ascProfile:'A',bundleId:'com.a',vendor:'12'},'456':{ascProfile:'B',bundleId:'com.b'}}};
 assert.deepEqual(accountScopes(cfg),['123','456']);
 const a=appAccount(cfg,'123');
 assert.equal(a.asc.profile,'A');assert.equal(a.asc.explicitScope,true);
 assert.equal(appAccount(cfg,'456').asc.vendor,undefined);
 assert.throws(()=>appAccount(cfg,'789'),/No explicit/);
 assert.throws(()=>verifiedInventory({apps:[{id:'123',bundleId:'com.b'}]},a),/bundle ID/);
 assert.deepEqual(verifiedInventory({apps:[{id:'123',bundleId:'com.a'},{id:'456',bundleId:'com.b'}]},a).apps,[{id:'123',bundleId:'com.a'}]);
 assert.throws(()=>accountScopes({appAccounts:{...cfg.appAccounts,'456':{ascProfile:'A',bundleId:'com.b'}}}));
});

import {appleClient} from '../src/apple.mjs';
test('ASC health fetch uses read-only app/profile scope, linked build and strips private tester data',()=>{
 const calls=[];
 const apple=appleClient({profile:'AppA'},(cmd,args)=>{
  calls.push(args);
  assert.equal(cmd,'asc');assert.equal(args.at(-1),'AppA');
  if(args[0]==='testflight')return {data:[{id:'receipt',attributes:{osVersion:'27',signature:'sig',email:'private@example.com',comment:'private text'}}]};
  if(args[0]==='builds')return {data:[{id:'build-a',attributes:{version:'12'}}]};
  if(args[0]==='performance'){assert.ok(args.includes('build-a'));return {data:[{id:'diag',attributes:{diagnosticType:'HANGS',weight:2}}]};}
  throw Error('Unexpected command');
 });
 const health=apple.health('123');
 assert.equal(health.crashes.data.sampleCount,1);
 assert.equal(health.diagnostics.data.buildId,'build-a');
 assert.doesNotMatch(JSON.stringify(health),/private/);
 assert.equal(calls.length,4);
 assert.ok(calls.filter(a=>a[0]==='testflight').every(a=>a.includes('123')));
});

test('native rank import preserves source, app and keyword and rejects schema drift',t=>{
 const db=workspace(t),cfg={loop:{apps:{'123':{aso:{keywords:['Workout'],storefronts:['CA']}}}}};
 const input={appId:'123',keyword:'workout',country:'CA',observedOn:'2026-11-25',complete:true,evidence:'verified native export',export:{pageData:{bubbles:[{name:'software',results:[{id:'123'},{id:'789'}]}]}}};
 assert.equal(importNativeRank(db,'123',cfg,input,now).rank,1);
 const plan=keywordPlan(db,'123',cfg,now);
 assert.equal(plan.due.length,1);
 assert.equal(plan.nativeHistory[0].rank,1);
 assert.equal(plan.history.length,0);
 assert.equal(plan.competitorOverlap[0].appId,'789');
 assert.throws(()=>importNativeRank(db,'123',cfg,{...input,export:{}},now),/Unexpected/);
});

import {lesson,retireLesson,appContext} from '../src/app-context.mjs';
test('curation retires only an exact revision with closed app evidence; old revisions remain',t=>{
 const db=workspace(t);
 db.saveScan('123',now,{app:{id:'123',name:'Fixture'},capturedAt:now});
 const task=db.enqueue({appId:'123',key:'c',kind:'promotion',status:'closed',outcome:{verdict:'missed'}},now);
 const input={appId:'123',domain:'promotion',key:'old-rule',rule:'Old rule',limitations:'Limited evidence',taskIds:[task.id],expectedRevision:0};
 lesson(db,'123',input,now);
 assert.throws(()=>retireLesson(db,'123',{...input,expectedRevision:0,reason:'outdated'},now));
 retireLesson(db,'123',{...input,expectedRevision:1,reason:'outdated'},now);
 assert.equal(db.lessons('123').length,2);
 assert.equal(appContext(db,'123').learning.promotion.current.length,0);
 assert.equal(appContext(db,'123').learning.promotion.retired.length,1);
 assert.equal(learningReview(db,'123',now).knowledgeReview.length,0);
});
