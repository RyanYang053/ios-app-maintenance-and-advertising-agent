// Local decision support: observations are not causal estimates or permission to spend.
const day=86400000;
const num=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
const count=x=>Number.isSafeInteger(x)&&x>=0;
const str=x=>typeof x==='string'&&x.trim().length>0&&x.length<=2000;
const stamp=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString().slice(0,10)===x;
const url=x=>{try{const u=new URL(x);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}};
const age=(x,now)=>(Date.parse(now)-Date.parse(x))/day;
export function validateResearch(input,now) {
  if(!input||!['competitor','customer','channel','cohort'].includes(input.kind)||!stamp(input.observedOn)||
    age(input.observedOn,now)<0||!str(input.market)||!str(input.source)||!str(input.evidence)||
    !str(input.finding)||!str(input.implication)) throw new Error('Research needs a dated observation, market, source, evidence, finding and implication');
  if(input.url!==undefined&&!url(input.url)) throw new Error('Use a valid HTTPS source URL without credentials');
  if(['competitor','channel'].includes(input.kind)&&!url(input.url)) throw new Error('Public market research requires source URL');
  const base={kind:input.kind,observedOn:input.observedOn,market:input.market,source:input.source,
    evidence:input.evidence,finding:input.finding,implication:input.implication,url:input.url??null};
  if(input.kind!=='cohort') return base;
  const c=input.cohort;
  if(!c||!stamp(c.start)||!stamp(c.end)||c.start>c.end||c.end>input.observedOn||
    !count(c.horizonDays)||c.horizonDays<7||c.horizonDays>365||
    age(c.end,input.observedOn)<c.horizonDays||!count(c.installs)||c.installs<1||
    !count(c.payers)||c.payers>c.installs||!num(c.netDeveloperProceeds)||!num(c.variableCost)||
    !/^[A-Z]{3}$/.test(c.currency)||!str(c.scope)||c.complete!==true)
    throw new Error('Complete matured install cohort, net developer proceeds, variable cost, currency and scope required');
  return {...base,cohort:{start:c.start,end:c.end,horizonDays:c.horizonDays,installs:c.installs,payers:c.payers,
    netDeveloperProceeds:c.netDeveloperProceeds,variableCost:c.variableCost,currency:c.currency,scope:c.scope,complete:true}};
}
export function portfolioPlan(db,config,now,appId) {
  const policy=config.loop??{}, all=db.operations(), rows=[];
  const hours=policy.portfolioHoursPerCycle??null;
  if(hours!==null&&(!num(hours)||hours===0)) throw new Error('Invalid portfolio hours per cycle');
  for(const scan of db.latestScans().filter(s=>!appId||s.app.id===appId)){
    const id=scan.app.id, p=policy.apps?.[id]??{}, market=p.market??null,currency=p.currency??policy.currency??'CAD';
    const history=db.research(id), relevant=history.filter(r=>r.market===market&&age(r.observedOn,now)>=0&&age(r.observedOn,now)<=90);
    // Use latest complete mature cohort only; do not double-count overlapping exports.
    const cohort=relevant.find(r=>r.kind==='cohort'&&r.cohort.currency===currency&&r.cohort.installs>=100);
    const contribution=cohort?(cohort.cohort.netDeveloperProceeds-cohort.cohort.variableCost)/cohort.cohort.installs:null;
    const tasks=all.filter(t=>t.appId===id&&!['closed','cancelled'].includes(t.status));
    const recent=all.filter(t=>t.appId===id&&t.kind==='promotion'&&t.status==='closed'&&t.outcome?.learningEligible&&
      t.policy.market===market&&t.policy.currency===currency&&age(t.outcome.end,now)>=0&&age(t.outcome.end,now)<=90);
    const channels=[];
    for(const channel of p.channels??[]){
      const matches=recent.filter(t=>t.channel===channel&&t.publication?.mode==='organic'&&
        t.policy.hourlyRate===(p.hourlyRate??policy.hourlyRate??null)&&
        t.policy.measurementDays===(p.measurementDays??7)&&num(t.outcome.totalCost)&&num(t.outcome.hours));
      const downloads=matches.reduce((a,t)=>a+t.outcome.downloads,0);
      const cost=matches.reduce((a,t)=>a+t.outcome.totalCost,0);
      const effort=matches.reduce((a,t)=>a+t.outcome.hours,0);
      const qualified=matches.length>=2&&downloads>=20;
      const cpa=qualified?cost/downloads:null;
      const net=qualified&&contribution!==null?contribution*downloads-cost:null;
      channels.push({channel,observations:matches.length,downloads,cpa,currency,
        observedContributionPerInstall:contribution,attributionBasedNetPerHour:net!==null&&effort>0?net/effort:null,
        observedHoursPerExperiment:matches.length>=2?effort/matches.length:null,
        action:channel==='apple-ads'?(contribution===null?'paid test only within cashCap after approval; collect cohort economics before scaling':'compare Apple Ads cost per tap download with cohort contribution before any budget change'):
          !qualified?'organic discovery or limited retest':contribution===null?'collect cohort economics; do not scale paid':
          contribution<=cpa?'do not scale; improve economics':'candidate for controlled organic replication',
        caveat:'Attributed installs times observed cohort contribution is a proxy, not incremental profit or a forecast.'});
    }
    const fresh=age(scan.capturedAt,now)>=0&&age(scan.capturedAt,now)<=3;
    const urgent=tasks.filter(t=>t.priority===1);
    const promotion=tasks.find(t=>t.kind==='promotion');
    const best=channels.filter(c=>c.attributionBasedNetPerHour!==null&&c.attributionBasedNetPerHour>0&&(p.maxCpa==null||c.cpa<=p.maxCpa))
      .sort((a,b)=>b.attributionBasedNetPerHour-a.attributionBasedNetPerHour)[0];
    rows.push({appId:id,appName:scan.app.name,market,currency,fresh,cohort:appId?(cohort??null):null,cohortAvailable:!!cohort,channels,
      urgentTaskIds:urgent.map(t=>t.id),promotionTaskId:promotion?.id??null,
      dueTaskIds:tasks.filter(t=>t.status==='live'&&t.dueAt<=now.slice(0,10)).map(t=>t.id),
      research:appId?relevant.filter(r=>r.kind!=='cohort').slice(0,10):[],researchCount:relevant.filter(r=>r.kind!=='cohort').length,
      priority:!fresh?0:urgent.length||tasks.some(t=>t.status==='live'&&t.dueAt<=now.slice(0,10))?1:best?2:3,
      next:!fresh?'refresh evidence':urgent.length?'resolve verified maintenance blocker':best?'consider qualified organic replication':'research or zero-cash exploration',
      rankingProxy:best?.attributionBasedNetPerHour??null,preferredChannel:best?.channel??null});
  }
  rows.sort((a,b)=>a.priority-b.priority||
    a.currency.localeCompare(b.currency)||((b.rankingProxy??-Infinity)-(a.rankingProxy??-Infinity))||a.appId.localeCompare(b.appId));
  const reserved=policy.portfolioMaintenanceReserveHours??null;
  if(reserved!==null&&(!num(reserved)||hours===null||reserved>hours)) throw new Error('Invalid maintenance time reserve');
  let remaining=hours===null||reserved===null?null:hours-reserved;
  const allocation=[];
  const eligible=rows.filter(r=>r.priority===2&&r.preferredChannel&&r.promotionTaskId);
  const currencies=new Set(eligible.map(r=>r.currency));
  if(currencies.size===1&&remaining!==null&&!rows.some(r=>r.priority===0||r.priority===1)){
    for(const r of eligible){
      const c=r.channels.find(c=>c.channel===r.preferredChannel);
      const task=all.find(t=>t.id===r.promotionTaskId);
      if(task?.channel!==c.channel||task.status!=='queued'||!num(c.observedHoursPerExperiment)||c.observedHoursPerExperiment===0) continue;
      if(c.observedHoursPerExperiment>remaining)continue;
      allocation.push({appId:r.appId,taskId:task.id,channel:c.channel,estimatedHours:c.observedHoursPerExperiment,
        observedNetProxyPerHour:c.attributionBasedNetPerHour,currency:r.currency});
      remaining-=c.observedHoursPerExperiment;
    }
  }
  return {asOf:now,portfolioHoursPerCycle:hours,maintenanceReserveHours:reserved,proposedOrganicAllocation:allocation,
    unallocatedHours:remaining,allocationNote:'Allocate only queued matching organic tasks with measured effort, positive attribution proxy and one currency; urgent, stale, due or missing evidence leaves allocation for owner review.',
    apps:rows,unconfiguredApps:rows.filter(r=>!r.market||r.channels.length===0).map(r=>r.appId),
    constraints:['Resolve due and urgent tasks first','Never rank monetary returns across currencies without conversion evidence','No paid spend without explicit per-experiment approval','Unknown economics is not zero and never authorizes scaling'],
    caveat:'A decision aid, not an autonomous spend optimizer. No causal incrementality or future profit is claimed.'};
}
