import { parseArgs } from 'node:util';
import { readFileSync,realpathSync,statSync,existsSync } from 'node:fs';
import { resolve,relative,isAbsolute,sep } from 'node:path';
import { actions,runHostTool } from '../src/host-tools.mjs';
import { skillCatalog,readSkill,operatorGuide } from '../src/host-skills.mjs';
import { appFolder } from '../src/app-context.mjs';
import { readiness } from '../src/readiness.mjs';

const root=resolve(import.meta.dirname,'..');
function loadEvidence(file,app) {
  if(file==='-') return readFileSync(0,'utf8');
  const configPath=resolve(root,'agent.config.json');
  const cfg=existsSync(configPath)?JSON.parse(readFileSync(configPath,'utf8')):{};
  const parent=resolve(root,cfg.stateDir??'.agent-data','imports');
  const base=app?appFolder(parent,app):realpathSync(parent);
  const dest=realpathSync(resolve(base,file)),rel=relative(base,dest);
  if(!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)) throw new Error('Evidence file must be in stateDir/imports');
  const info=statSync(dest);
  if(!info.isFile()||info.size>750000||!dest.endsWith('.json')) throw new Error('Expected bounded JSON evidence file');
  return readFileSync(dest,'utf8');
}
async function main() {
  const {values:v,positionals:p}=parseArgs({allowPositionals:true,options:{
    app:{type:'string'},task:{type:'string'},days:{type:'string'},cached:{type:'boolean'},release:{type:'boolean'},
    platform:{type:'string'},brief:{type:'string'},screenshot:{type:'string'},input:{type:'string'},
    metrics:{type:'string'},outcomes:{type:'string'},name:{type:'string'},file:{type:'string'},help:{type:'boolean'},live:{type:'boolean'}
  }});
  if(v.help||p.length===0) return {usage:'node scripts/operator.mjs ACTION [options]',actions:Object.keys(actions),references:['guide','skills','skill --name NAME [--file FILE]','doctor [--live]'],evidence:'--input/--metrics/--outcomes accept stdin (-) or JSON under stateDir/imports'};
  if(p.length!==1) throw new Error('Expected one action');
  const action=p[0];
  if(action==='doctor') {
    if(Object.keys(v).some(k=>k!=='live')) throw new Error('Only --live is supported for doctor');
    return readiness(root,{live:v.live===true});
  }
  if(['guide','skills','skill'].includes(action)){
    if(Object.keys(v).some(k=>!['name','file'].includes(k))) throw new Error('Unexpected reference option');
    if(action==='guide') return operatorGuide(root);
    if(action==='skills') return skillCatalog(root);
    return readSkill(root,v.name,v.file);
  }
  if(!Object.hasOwn(actions,action)) throw new Error('Unsupported operator action');
  const args={...v};
  for(const k of ['task','days']) if(args[k]!==undefined){
    if(!/^\d+$/.test(args[k])) throw new Error('Invalid numeric option');
    args[k]=Number(args[k]);
  }
  if(args.app!==undefined&&!/^\d+$/.test(args.app))throw Error('Exact App Store ID required');
  const keys=['input','metrics','outcomes'].filter(k=>args[k]!==undefined);
  if(keys.length>1) throw new Error('Import one evidence payload per call');
  for(const k of keys){args[k+'Json']=loadEvidence(args[k],args.app);delete args[k];}
  return runHostTool(root,action,args);
}
try{console.log(JSON.stringify(await main(),null,2));}
catch(e){console.error(e.message);process.exitCode=1;}
