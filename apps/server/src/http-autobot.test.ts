import {test} from 'node:test';
import assert from 'node:assert/strict';
import {httpUrl,httpDestination,AUTOBOT_BASE_URL} from '../../../packages/nodes/src/http.ts';
import {sendHttp} from './steps-io.ts';
const id='f1345c4d-5784-4fc0-9dca-cc27140bbbaf';
test('new Autobot destinations are validated; existing URLs stay custom',()=>{
 assert.equal(httpDestination({}),'autobot');assert.equal(httpUrl({destination:'autobot',autobotWorkflowId:'bad'}),'');assert.equal(httpUrl({destination:'autobot',autobotWorkflowId:id}),`${AUTOBOT_BASE_URL}/integration/v1/workflows/${id}/builder-results`);
 assert.equal(httpDestination({url:'https://legacy.example/hook'}),'custom');assert.equal(httpUrl({url:'https://legacy.example/hook'}),'https://legacy.example/hook');
});
test('Autobot sends POST with its encrypted-at-rest key, custom mode preserves method and headers',async()=>{
 const seen:any[]=[];const mock=async(url:any,options:any)=>{seen.push({url,...options});return new Response('{}',{status:202});};
 await sendHttp({id:'n',type:'http',position:{x:0,y:0},config:{destination:'autobot',autobotWorkflowId:id,autobotApiKey:'test-only',method:'PUT'}},{tables:[]},mock as typeof fetch);
 assert.equal(seen[0].method,'POST');assert.equal(seen[0].headers.Authorization,'Bearer test-only');assert.equal(seen[0].url,httpUrl({autobotWorkflowId:id}));
 await sendHttp({id:'n',type:'http',position:{x:0,y:0},config:{url:'https://legacy.example/hook',method:'PATCH',headers:'X-Test: preserved'}},{},mock as typeof fetch);
 assert.equal(seen[1].method,'PATCH');assert.equal(seen[1].headers['X-Test'],'preserved');assert.equal(seen[1].headers.Authorization,undefined);
});
