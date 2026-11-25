import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { state } from '../src/state.mjs';
import { portfolioPlan,validateResearch } from '../src/portfolio.mjs';
const now='2026-11-25T15:00:00Z';
const config={loop:{currency:'CAD',hourlyRate:20,portfolioHoursPerCycle:4,portfolioMaintenanceReserveHours:1,apps:{'123':{market:'CA',channels:['youtube','reddit']},'456':{market:'CA',channels:['youtube']}}}};
const cohort={kind:'cohort',observedOn:'2026-11-24',market:'CA',source:'Cohort report',evidence:'report 1',finding:'Mature cohort',implication:'Compare costs',cohort:{start:'2026-09-01',end:'2026-09-30',horizonDays:30,installs:200,payers:30,netDeveloperProceeds:500,variableCost:100,currency:'CAD',scope:'CA acquisition cohort',complete:true}};
test('rejects incomplete, immature or untraceable research',()=>{
  assert.throws(()=>validateResearch({...cohort,cohort:{...cohort.cohort,complete:false}},now));
  assert.throws(()=>validateResearch({...cohort,cohort:{...cohort.cohort,end:'2026-11-20'}},now));
  assert.throws(()=>validateResearch({...cohort,kind:'competitor'},now));
  assert.throws(()=>validateResearch({...cohort,observedOn:'2026-11-26'},now));
});
test('durable research, dedupe, failed campaigns, unknown economics and ranking',t=>{
  const dir=mkdtempSync(join(tmpdir(),'portfolio-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let db=state(dir);
  for(const id of ['123','456'])db.saveScan(id,now,{app:{id,name:id},capturedAt:now});
  const row=validateResearch(cohort,now);
  assert.equal(db.saveResearch('123',now,row).stored,true);
  assert.equal(db.saveResearch('123',now,row).stored,false);
  for(const [i,downloads] of [40,0].entries()){
    db.enqueue({appId:'123',key:'promo-'+i,kind:'promotion',status:'closed',channel:'youtube',
      policy:{market:'CA',currency:'CAD',hourlyRate:20,measurementDays:7},
      publication:{mode:'organic'},outcome:{learningEligible:true,end:'2026-11-20',downloads,totalCost:20,hours:1}},now);
  }
  db.enqueue({appId:'123',key:'queued-promo',kind:'promotion',status:'queued',channel:'youtube'},now);
  db.close();db=state(dir);
  try{
    const plan=portfolioPlan(db,config,now);
    assert.equal(plan.apps[0].appId,'123');
    const channel=plan.apps[0].channels[0];
    assert.equal(channel.cpa,1);
    assert.equal(plan.proposedOrganicAllocation.length,1);
    assert.equal(plan.unallocatedHours,2);
    assert.equal(channel.observedContributionPerInstall,2);
    assert.equal(channel.attributionBasedNetPerHour,20);
    assert.equal(plan.apps[1].channels[0].observedContributionPerInstall,null);
    assert.equal(plan.apps[0].channels[1].cpa,null);
    assert.equal(portfolioPlan(db,config,'2027-03-01T15:00:00Z','123').apps[0].cohort,null);
    assert.equal(plan.apps[0].cohort,null);
    assert.ok(portfolioPlan(db,config,now,'123').apps[0].cohort);
  }finally{db.close();}
});
