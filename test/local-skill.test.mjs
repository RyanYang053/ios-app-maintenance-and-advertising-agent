import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const script=resolve(import.meta.dirname,'../scripts/operator.mjs');
const call=(...args)=>spawnSync(process.execPath,[script,...args],{encoding:'utf8'});
test('local skill runner discovers instructions and pinned skills',()=>{
  let r=call('guide');assert.equal(r.status,0,r.stderr);assert.match(JSON.parse(r.stdout).workflow,/ios-app-operator|App Store/);
  r=call('skills');assert.equal(r.status,0,r.stderr);assert.ok(JSON.parse(r.stdout).some(s=>s.name==='marketing-loops'));
  r=call('skill','--name','ios-app-operator');assert.equal(r.status,0,r.stderr);
  r=call('browser','--platform','asc');assert.equal(r.status,0,r.stderr);assert.match(JSON.parse(r.stdout).url,/appstoreconnect/);
});
test('local runner refuses dispatch, config overrides, and traversal',()=>{
  for(const args of [['dispatch','--task','1'],['scan','--config','/tmp/x'],['skill','--name','ios-app-operator','--file','../../../AGENTS.md'],['scan','--app','--help']]){
    assert.notEqual(call(...args).status,0,args.join(' '));
  }
});
