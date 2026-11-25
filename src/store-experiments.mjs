// Local draft creator using approved app captures; layout/style-lock concept from ASO Studio.
// No AI API, upload or App Store write. Verify every exported image visually before use.
import {readFileSync,writeFileSync,existsSync,mkdirSync,mkdtempSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {run,writeJson} from './io.mjs';
import {appId,assertEvidenceApp} from './app-context.mjs';
import {liveRelease} from './release-record.mjs';
const text=(x,n=500)=>typeof x==='string'&&x.trim().length>0&&x.length<=n;
const locale=x=>typeof x==='string'&&/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(x);
const num=x=>typeof x==='number'&&Number.isFinite(x);
const stamp=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString().slice(0,10)===x;
const palettes={midnight:['#111c31','#183b58','#f5f7fa','#a6e3e9'],paper:['#f2eee4','#d9e2d0','#172b31','#235b4d'],orchid:['#24182f','#4a335b','#faf3ff','#ffdbb1']};
export const sizes={'iphone-large':[1320,2868],'iphone-medium':[1206,2622],'iphone-6.5':[1284,2778],'ipad-13':[2064,2752]};
const escape=x=>x.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
export function pngInfo(bytes){
 if(bytes.length<33||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.subarray(12,16).toString()!=='IHDR')throw Error('Expected valid PNG header');
 return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20),colorType:bytes[25]};
}
function validateLive(scan,id,input,release=liveRelease(scan)){
 assertEvidenceApp(id,input);
 if(scan?.app?.id!==id||scan.store?.status!=='ok'||scan.store.data?.live?.version!==input.verifiedVersion||
 !release?.sha||release.sha!==input.listingSha)
  throw Error('Confirm the live version and shipped source (matching Git tag or a release-confirm record) before preparing promotional assets; listingSha must equal that commit');
}
export function screenshotHtml(scan,id,input,bytes,release){
 validateLive(scan,id,input,release);
 if(!Object.hasOwn(sizes,input.device)||!Object.hasOwn(palettes,input.style)||!locale(input.locale)||
   !text(input.headline,80)||!text(input.subtitle,140)||!text(input.captureEvidence)||input.approvedCapture!==true)
  throw Error('Provide verified capture, supported device, locale, style and concise truthful copy');
 const info=pngInfo(bytes);
 if(bytes.length>20_000_000||info.width<200||info.height<200||info.width>6000||info.height>6000)throw Error('PNG capture size out of bounds');
 const [w,h]=sizes[input.device];
 const [a,b,c,d]=palettes[input.style];
 return {width:w,height:h,html:'<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;; img-src data:; style-src &apos;unsafe-inline&apos;"><style>*{box-sizing:border-box}html,body{margin:0;width:'+w+'px;height:'+h+'px;overflow:hidden;background:'+a+';color:'+c+';font-family:Arial,sans-serif}main{height:100%;padding:7% 8%;background:radial-gradient(ellipse at 85% 80%,'+b+','+a+' 72%);display:flex;flex-direction:column;align-items:center;text-align:center;gap:2%}.brand{font-size:'+Math.round(w*.032)+'px;font-weight:bold;color:'+d+'}h1{margin:0;font-size:'+Math.round(w*.071)+'px;line-height:1.05;letter-spacing:-.025em;overflow-wrap:anywhere}p{margin:0;font-size:'+Math.round(w*.033)+'px;line-height:1.2;overflow-wrap:anywhere}.capture{flex:1;min-height:0;width:100%;object-fit:contain;filter:drop-shadow(0 18px 32px #0005)}</style></head><body><main><div class="brand">'+escape(scan.app.name)+'</div><h1>'+escape(input.headline)+'</h1><p>'+escape(input.subtitle)+'</p><img class="capture" alt="" src="data:image/png;base64,'+bytes.toString('base64')+'"></main></body></html>'};
}
export function renderScreenshot(scan,id,input,path,dir,chrome,release){
 const {html,width,height}=screenshotHtml(scan,id,input,readFileSync(path),release);
 mkdirSync(dir,{recursive:true,mode:0o700});
 const output=mkdtempSync(join(dir,'screenshot-')), source=join(output,'index.html'), png=join(output,'screenshot.png');
 writeFileSync(source,html,{mode:0o600});
 const browser=chrome??(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':'google-chrome');
 run(browser,['--headless','--disable-gpu','--hide-scrollbars','--force-device-scale-factor=1','--disable-background-networking','--disable-extensions','--no-first-run','--no-default-browser-check','--user-data-dir='+join(output,'browser-profile'),'--window-size='+width+','+height,'--screenshot='+png,pathToFileURL(source).href],{timeout:60000});
 const result=pngInfo(readFileSync(png));
 if(result.width!==width||result.height!==height||![0,2].includes(result.colorType))throw Error('Rendered PNG failed exact dimensions or opaque color format');
 const manifest={appId:id,version:input.verifiedVersion,listingSha:input.listingSha,locale:input.locale,device:input.device,style:input.style,path:png,...result,state:'draft',notice:'Review visual layout, copy, source and current Apple specs before approval'};
 writeJson(join(output,'manifest.json'),manifest);
 return manifest;
}
export function planPpo(db,scan,id,input,now){
 validateLive(scan,id,input,liveRelease(scan,db.opsEvidence(id,'release-record')));
 if(!/^[a-z0-9-]{3,64}$/.test(input.key??'')||!locale(input.locale)||!text(input.hypothesis)||!text(input.control)||
 !Array.isArray(input.treatments)||input.treatments.length<1||input.treatments.length>3||
 input.treatments.some(t=>!text(t.name,60)||!text(t.change)||!text(t.assetRef))||
 new Set(input.treatments.map(t=>t.name)).size!==input.treatments.length||input.treatments.some(t=>t.name==='control')||
 !Number.isSafeInteger(input.minimumImpressions)||input.minimumImpressions<100||
 !num(input.minimumConfidence)||input.minimumConfidence<.9||input.minimumConfidence>1)
  throw Error('PPO needs exact version, control, one to three treatments, hypothesis and predefined sample/confidence');
 return db.saveOpsEvidence(id,'ppo-plan',input.key,{appId:id,key:input.key,locale:input.locale,version:input.verifiedVersion,listingSha:input.listingSha,hypothesis:input.hypothesis,control:input.control,treatments:input.treatments,minimumImpressions:input.minimumImpressions,minimumConfidence:input.minimumConfidence,recordedAt:now,state:'draft'});
}
export function recordPpo(db,id,input,now){
 assertEvidenceApp(id,input);
 const plan=db.opsEvidence(id,'ppo-plan').find(x=>x.key===input.key);
 if(!plan||input.version!==plan.version||input.locale!==plan.locale||!text(input.experimentId,100)||!text(input.evidence)||
 !text(input.approvalReference)||!stamp(input.start)||!stamp(input.end)||input.start>input.end||input.start<plan.recordedAt.slice(0,10)||input.end>=now.slice(0,10)||
 input.reportComplete!==true||input.source!=='App Store Connect Product Page Optimization'||
 !Array.isArray(input.results)||input.results.length!==plan.treatments.length+1)
  throw Error('Provide matched approved PPO result with complete Apple report');
 const names=['control',...plan.treatments.map(t=>t.name)];
 if(new Set(input.results.map(x=>x.name)).size!==names.length||input.results.some(x=>!names.includes(x.name)||
 !Number.isSafeInteger(x.impressions)||x.impressions<0||!num(x.conversionRate)||x.conversionRate<0||x.conversionRate>1||
 (x.name!=='control'&&(!num(x.confidence)||x.confidence<0||x.confidence>1))))throw Error('Use reported metrics per exact treatment; no invented confidence');
 const control=input.results.find(x=>x.name==='control');
 const winner=input.results.filter(x=>x.name!=='control'&&x.impressions>=plan.minimumImpressions&&control.impressions>=plan.minimumImpressions&&x.confidence>=plan.minimumConfidence&&x.conversionRate>control.conversionRate).sort((a,b)=>b.conversionRate-a.conversionRate)[0];
 return db.saveOpsEvidence(id,'ppo-result',plan.key,{appId:id,key:plan.key,experimentId:input.experimentId,start:input.start,end:input.end,results:input.results,approvalReference:input.approvalReference,evidence:input.evidence,winner:winner?.name??null,decision:winner?'candidate for owner review':'inconclusive or no qualified improvement',notice:'Based on Apple-reported confidence and configured floors, not a new statistical significance test; no automatic application'});
}
