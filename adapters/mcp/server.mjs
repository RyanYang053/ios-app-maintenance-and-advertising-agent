import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { resolve } from 'node:path';
import { actions, runHostTool } from '../../src/host-tools.mjs';

const root=resolve(import.meta.dirname,'../..');
const app=z.string().regex(/^\d+$/), task=z.number().int().positive(), days=z.number().int().min(1).max(30);
const json=z.string().max(750000);
const schema={
  apps:{metricsJson:json.optional()},
  scan:{app:app.optional(),days:days.optional(),metricsJson:json.optional()},
  cycle:{app:app.optional(),days:days.optional(),cached:z.boolean().optional(),metricsJson:json.optional(),outcomesJson:json.optional()},
  memory:{app:app.optional()},feedback:{app},inspect:{app,release:z.boolean().optional()},history:{app},task:{task},
  observe:{app,inputJson:json},handoff:{task,inputJson:json.optional()},'dispatch-preview':{task},
  advance:{task,inputJson:json},'store-draft':{app,inputJson:json},brief:{app,inputJson:json},
  video:{brief:z.string().max(4096),screenshot:z.string().max(4096)},record:{app,inputJson:json},
  browser:{platform:z.enum(['asc','ads','tiktok','instagram','youtube','x','reddit','linkedin'])}
};
const readOnly=new Set(['apps','memory','feedback','inspect','history','task','dispatch-preview','browser']);
export function createServer() {
  const server=new McpServer({name:'ios-app-operator',version:'0.2.0'});
  for(const [action,description] of Object.entries(actions)) {
    server.registerTool(action.replaceAll('-','_'),{
      description,inputSchema:z.strictObject(schema[action]),
      annotations:{readOnlyHint:readOnly.has(action),destructiveHint:false,idempotentHint:false,openWorldHint:true}
    },async args=>{
      try {
        const result=await runHostTool(root,action,args);
        return {content:[{type:'text',text:JSON.stringify(result)}]};
      } catch(e) {
        return {isError:true,content:[{type:'text',text:e.message}]};
      }
    });
  }
  return server;
}
void serveStdio(createServer);
