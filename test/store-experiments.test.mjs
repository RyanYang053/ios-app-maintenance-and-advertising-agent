import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateSync} from 'node:zlib';
import {state} from '../src/state.mjs';
import {screenshotHtml,pngInfo,renderScreenshot,planPpo,recordPpo} from '../src/store-experiments.mjs';
const now='2026-11-25T15:00:00Z';
const scan={app:{id:'123',name:'Fixture App'},store:{status:'ok',data:{live:{version:'1.2'}}},source:{releaseStatus:'tag-match',release:{sha:'abc'}}};
const input={appId:'123',verifiedVersion:'1.2',listingSha:'abc',locale:'en-CA',device:'iphone-medium',style:'midnight',headline:'Use <real> data',subtitle:'Synthetic fixture only',captureEvidence:'test fixture',approvedCapture:true};
function crc32(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function chunk(name,data){const type=Buffer.from(name),n=Buffer.alloc(4),crc=Buffer.alloc(4);n.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([type,data])));return Buffer.concat([n,type,data,crc]);}
function fixture(){
 const header=Buffer.alloc(13);header.writeUInt32BE(400,0);header.writeUInt32BE(800,4);header[8]=8;header[9]=2;
 const rows=Buffer.alloc(800*(1+400*3));for(let y=0;y<800;y++)for(let x=0;x<400;x++){const o=y*1201+x*3+1;rows[o]=x%255;rows[o+1]=y%255;rows[o+2]=100;}
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
test('local screenshot template enforces release, exact dimensions, image and escaped copy',()=>{
 const bytes=fixture();
 const r=screenshotHtml(scan,'123',input,bytes);
 assert.deepEqual([r.width,r.height],[1206,2622]);
 assert.deepEqual(pngInfo(bytes),{width:400,height:800,colorType:2});
 assert.match(r.html,/Use &lt;real&gt; data/);
 assert.match(r.html,/data:image\/png;base64/);
 assert.throws(()=>screenshotHtml(scan,'456',{...input,appId:'456'},bytes));
 assert.throws(()=>screenshotHtml(scan,'123',{...input,listingSha:'unshipped'},bytes));
});
test('PPO matches app, version, predeclared floors and Apple confidence without auto-apply',t=>{
 const dir=mkdtempSync(join(tmpdir(),'ppo-')),db=state(dir);t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 const plan={...input,key:'new-hero',hypothesis:'Improve conversion',control:'Current',treatments:[{name:'B',change:'Headline',assetRef:'draft B'}],minimumImpressions:100,minimumConfidence:.9};
 planPpo(db,scan,'123',plan,'2026-11-01T12:00:00Z');
 const report={appId:'123',key:plan.key,version:'1.2',locale:'en-CA',experimentId:'apple-123',evidence:'Apple report',approvalReference:'receipt',start:'2026-11-02',end:'2026-11-20',reportComplete:true,source:'App Store Connect Product Page Optimization',results:[{name:'control',impressions:200,conversionRate:.1},{name:'B',impressions:200,conversionRate:.13,confidence:.95}]};
 assert.throws(()=>recordPpo(db,'456',{...report,appId:'456'},now));
 assert.equal(recordPpo(db,'123',report,now).winner,'B');
 assert.equal(db.opsEvidence('456','ppo-result').length,0);
 assert.throws(()=>recordPpo(db,'123',report,now),/already exists/);
});
test('real Chrome renders an opaque App Store sized PNG',{skip:process.env.RUN_CHROME_SMOKE!=='1'},t=>{
 const dir=mkdtempSync(join(tmpdir(),'screen-render-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'fixture.png');writeFileSync(path,fixture());
 const r=renderScreenshot(scan,'123',input,path,dir);
 assert.equal(r.width,1206);assert.equal(r.height,2622);assert.ok([0,2].includes(r.colorType));
});
