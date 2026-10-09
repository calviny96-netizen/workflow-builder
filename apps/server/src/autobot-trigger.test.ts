import assert from 'node:assert/strict';import {test} from 'node:test';import {randomBytes} from 'node:crypto';
import {buildApp} from './app.ts';import {stashSecrets} from './secrets.ts';
const workflow='22f4cfa5-8767-4b63-b034-c0be3a235bc7',receiver='11111111-1111-4111-8111-111111111111',dispatch='22222222-2222-4222-8222-222222222222';
test('Autobot trigger requires enabled published workflow, exact node secret and receiver ID; duplicate dispatch does not create run',async()=>{
 const master=randomBytes(32),records=new Map<string,any>();const row:any={id:workflow,status:'published',settings:{autobotTriggerEnabled:true},graph:{nodes:[{id:'http',type:'http',config:{destination:'autobot',autobotWorkflowId:receiver,autobotApiKey:'test-secret'}}],edges:[]}};
 const query=async(sql:string,p:any[]=[])=>{if(sql.startsWith('insert into node_secrets')){records.set(p[1]+':'+p[2],{value_enc:p[3],hint:p[4]});return {rows:[]};}if(sql.startsWith('select hint'))return {rows:[records.get(p[1]+':'+p[2])]};if(sql.startsWith('select node_id'))return {rows:[]};if(sql.startsWith('select value_enc'))return {rows:[records.get(p[1]+':'+p[2])]};if(sql.includes('from workflows'))return {rows:[row]};if(sql.includes("params->>'autobot_dispatch_id'"))return {rows:[{id:'existing-run'}]};return {rows:[]};};
 const db:any={query,connect:async()=>({query,release(){}})};row.graph=await stashSecrets(db,master,workflow,row.graph);
 const app=buildApp({db,api:{} as any,executor:{} as any,masterKey:master,globalConcurrency:1,secureCookie:false});
 const call=(key:string,body:any={workflow_id:receiver,run_id:dispatch,period:{from:'2026-10-04',to:'2026-10-04'}})=>app.inject({method:'POST',url:'/integration/v1/workflows/'+workflow+'/run',headers:{authorization:'Bearer '+key},payload:body});
 assert.equal((await call('wrong')).statusCode,401);
 assert.equal((await call('test-secret',{workflow_id:'other'})).statusCode,401);
 row.status='draft';assert.equal((await call('test-secret')).statusCode,401);row.status='published';row.settings.autobotTriggerEnabled=false;assert.equal((await call('test-secret')).statusCode,401);row.settings.autobotTriggerEnabled=true;
 const duplicate=await call('test-secret');assert.equal(duplicate.statusCode,200);assert.deepEqual(duplicate.json(),{id:'existing-run',duplicate:true});
 assert.equal((await call('test-secret',{workflow_id:receiver,run_id:dispatch,period:{from:'2026-02-30',to:'2026-03-01'}})).statusCode,400);
 await app.close();
});
