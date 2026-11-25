import {appId} from './app-context.mjs';
const profile=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._ -]{0,79}$/.test(x);
export function accountScopes(config){
 const scopes=config.appAccounts??{};
 if(!scopes||typeof scopes!=='object'||Array.isArray(scopes))throw Error('Invalid appAccounts');
 const ids=Object.keys(scopes);
 const names=new Set();
 for(const id of ids){
  appId(id);
  const p=scopes[id];
  if(!p||!profile(p.ascProfile)||!/^[-.\w]+$/.test(p.bundleId??'')||names.has(p.ascProfile)||
    (p.vendor!==undefined&&!/^\d+$/.test(String(p.vendor)))||
    (p.adsProfile!==undefined&&!profile(p.adsProfile))||
    (p.adsAccounts!==undefined&&(!Array.isArray(p.adsAccounts)||p.adsAccounts.some(x=>!/^\d+$/.test(String(x)))||p.adsAccounts.length&&!p.adsProfile)))
    throw Error('Each configured app needs an exact bundle ID, unique ASC profile and valid optional report accounts');
  names.add(p.ascProfile);
 }
 return ids;
}
export function appAccount(config,id){
 const ids=accountScopes(config);
 if(!ids.length)return null;
 if(!ids.includes(appId(id)))throw Error('No explicit account profile configured for selected app');
 const row=config.appAccounts[id];
 return {appId:id,bundleId:row.bundleId,
  asc:{cli:config.asc?.cli,profile:row.ascProfile,vendor:row.vendor,explicitScope:true},
  ads:{profile:row.adsProfile,accounts:row.adsAccounts??[],campaignApps:config.ads?.campaignApps??{},explicitScope:true}};
}
export function verifiedInventory(inventory,scope){
 if(!scope)return inventory;
 const matching=inventory.apps.filter(a=>a.id===scope.appId&&a.bundleId===scope.bundleId);
 if(matching.length!==1)throw Error('Selected account inventory does not confirm the exact app ID and bundle ID');
 return {...inventory,apps:matching};
}
