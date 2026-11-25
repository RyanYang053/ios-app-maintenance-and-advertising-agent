import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { actions,buildInvocation } from '../src/host-tools.mjs';
test('allowlist excludes external dispatch, arbitrary shell and config overrides',()=>{
  assert.equal(Object.hasOwn(actions,'dispatch'),false);
  for(const name of ['dispatch','exec','constructor']) assert.throws(()=>buildInvocation('/tmp',name));
  assert.throws(()=>buildInvocation('/tmp','scan',{config:'/etc/passwd'}));
  assert.throws(()=>buildInvocation('/tmp','scan',{app:'--help'}));
  assert.throws(()=>buildInvocation('/tmp','task',{task:0}));
});
test('JSON evidence goes to stdin, never arbitrary CLI paths',()=>{
  const result=buildInvocation('/tmp','observe',{app:'123',inputJson:'{"appId":"123","test":true}'});
  assert.deepEqual(result.argv.slice(1),['observe','--app','123','--input','-']);
  assert.equal(result.stdin,'{"appId":"123","test":true}');
  assert.throws(()=>buildInvocation('/tmp','observe',{app:'123'}));
  assert.throws(()=>buildInvocation('/tmp','cycle',{metricsJson:'{}',outcomesJson:'[]'}));
});
test('video input stays in approved folders, including symlink escape',t=>{
  const root=mkdtempSync(join(tmpdir(),'operator-host-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  for(const p of ['drafts','assets']) mkdirSync(join(root,'.agent-data',p,'123'),{recursive:true});
  writeFileSync(join(root,'.agent-data','drafts','123','brief.json'),'{}');
  writeFileSync(join(root,'.agent-data','assets','123','screen.png'),'x');
  writeFileSync(join(root,'secret'),'private');
  const args={app:'123',brief:'brief.json',screenshot:'screen.png'};
  assert.ok(buildInvocation(root,'video',args).argv.includes(realpathSync(join(root,'.agent-data','assets','123','screen.png'))));
  assert.throws(()=>buildInvocation(root,'video',{...args,screenshot:'../../secret'}));
  if(process.platform!=='win32') {
    symlinkSync(join(root,'secret'),join(root,'.agent-data','assets','123','escape'));
    assert.throws(()=>buildInvocation(root,'video',{...args,screenshot:'escape'}));
  }
});
