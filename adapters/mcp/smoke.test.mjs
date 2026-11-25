import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolve } from 'node:path';
test('official MCP client discovers tools and reads workflow without Apple credentials',{timeout:30000},async()=>{
  const client=new Client({name:'operator-smoke',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve(import.meta.dirname,'server.mjs')]});
  try {
    await client.connect(transport);
    const {tools}=await client.listTools();
    const names=tools.map(t=>t.name);
    for(const name of ['operator_guide','skill_catalog','read_skill','cycle','memory','dispatch_preview','video']) assert.ok(names.includes(name));
    assert.ok(!names.includes('dispatch'));
    const guide=await client.callTool({name:'operator_guide',arguments:{}});
    assert.ok(!guide.isError);
    assert.match(guide.content[0].text,/iOS app operations/);
    const catalog=await client.callTool({name:'skill_catalog',arguments:{}});
    assert.ok(!catalog.isError);
    assert.match(catalog.content[0].text,/marketing-loops/);
    const denied=await client.callTool({name:'read_skill',arguments:{name:'ios-app-operator',file:'../../../AGENTS.md'}});
    assert.equal(denied.isError,true);
    const browser=await client.callTool({name:'browser',arguments:{platform:'asc'}});
    assert.ok(!browser.isError);
    assert.match(browser.content[0].text,/appstoreconnect/);
  } finally {await client.close();}
});
