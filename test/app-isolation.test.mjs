import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {state} from '../src/state.mjs';
import {appContext,lesson,appFolder} from '../src/app-context.mjs';
import {buildInvocation,scopedResult} from '../src/host-tools.mjs';
import {advance} from '../src/operator.mjs';
const now='2026-11-25T15:00:00Z';
test('two apps cannot read or revise each other’s task, knowledge or learned rules; history survives restart',t=>{
 const dir=mkdtempSync(join(tmpdir(),'app-isolation-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let db=state(dir);
 for(const id of ['123','456'])db.saveScan(id,now,{app:{id,name:'app-'+id},capturedAt:now});
 assert.throws(()=>db.saveScan('123',now,{app:{id:'456'}}));
 const a=db.enqueue({appId:'123',key:'same-key',kind:'promotion',status:'closed',outcome:{verdict:'target missed',secret:'only-A'}},now);
 const b=db.enqueue({appId:'456',key:'same-key',kind:'promotion',status:'closed',outcome:{verdict:'met target',secret:'only-B'}},now);
 assert.equal(db.operation(a.id,'456'),null);
 assert.throws(()=>db.operationEvents(a.id,'456'));
 assert.throws(()=>db.updateOperation(a,{appId:'456'},'bad',now));
 assert.throws(()=>advance(db,a,{action:'cancel',reason:'wrong'},db.latest('456'),now));
 db.saveResearch('123',now,{appId:'123',finding:'private-A',observedOn:'2026-11-25'});
 db.saveResearch('456',now,{appId:'456',finding:'private-B',observedOn:'2026-11-25'});
 assert.throws(()=>db.saveResearch('123',now,{appId:'456'}));
 const rule={appId:'123',domain:'promotion',key:'hook-test',rule:'A-specific finding',limitations:'One experiment',taskIds:[a.id],expectedRevision:0};
 assert.equal(lesson(db,'123',rule,now).revision,1);
 assert.throws(()=>lesson(db,'456',{...rule,appId:'456'},now));
 assert.throws(()=>lesson(db,'123',rule,now),/revision/);
 assert.equal(lesson(db,'123',{...rule,expectedRevision:1,rule:'Revised A-only finding'},now).revision,2);
 assert.equal(lesson(db,'456',{...rule,appId:'456',taskIds:[b.id],rule:'B-specific finding'},now).revision,1);
 db.close();db=state(dir);
 try{
   const x=appContext(db,'123'), y=appContext(db,'456');
   assert.equal(x.progress.closed,1);assert.equal(y.progress.closed,1);
   assert.equal(x.learning.promotion.revisions,2);
   assert.equal(x.learning.promotion.current[0].revision,2);
   assert.equal(y.learning.promotion.revisions,1);
   assert.doesNotMatch(JSON.stringify(x),/private-B|only-B|B-specific finding/);
   assert.doesNotMatch(JSON.stringify(y),/private-A|only-A|A-specific finding/);
 }finally{db.close();}
});
test('runner demands same app identity and does not expose raw portfolio scan evidence',()=>{
 assert.throws(()=>buildInvocation('/tmp','task',{task:1}));
 assert.throws(()=>buildInvocation('/tmp','advance',{app:'123',task:1,inputJson:'{"appId":"456"}'}));
 assert.throws(()=>buildInvocation('/tmp','cycle',{app:'123',outcomesJson:'[{"appId":"456","taskId":1}]'}));
 assert.throws(()=>buildInvocation('/tmp','scan',{app:'123',metricsJson:'{"byApp":{"456":{}}}'}));
 const scans=[{app:{id:'123'},source:{status:'matched',private:'secret'},feedback:{private:'review'}}];
 assert.doesNotMatch(JSON.stringify(scopedResult('scan',{},scans)),/secret|review/);
 assert.match(JSON.stringify(scopedResult('scan',{app:'123'},scans)),/secret/);
});
test('app folder cannot alias another app, including symlinks',t=>{
 const dir=mkdtempSync(join(tmpdir(),'app-folder-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 mkdirSync(join(dir,'123'));mkdirSync(join(dir,'456'));
 writeFileSync(join(dir,'456','screen.png'),'B');
 assert.throws(()=>appFolder(dir,'../456'));
 if(process.platform!=='win32'){
  rmSync(join(dir,'123'),{recursive:true});
  symlinkSync(join(dir,'456'),join(dir,'123'));
  assert.throws(()=>appFolder(dir,'123'),/alias/);
 }
});
