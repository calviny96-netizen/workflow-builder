import assert from 'node:assert/strict';
import {test} from 'node:test';
import {executeCode,codeItems,dataOutput} from './code.ts';
import {CODE_SAMPLE,CODE_TEMPLATES} from '../../../packages/nodes/src/code.ts';
import {buildPlan} from './planner.ts';
import {canConnect,compatible,validateGraph,NODE_SPECS} from '../../../packages/nodes/src/index.ts';
const input=JSON.parse(CODE_SAMPLE);
for(const language of ['javascript','python']) {
  test(`${language}: filter, mapping, dedup, split, aggregate and chat filtering produce structured output without LLM`,async()=>{
    const call=(key:keyof typeof CODE_TEMPLATES,items:any=input)=>executeCode({language,code:CODE_TEMPLATES[key][language]},items);
    const filter=await call('filter');assert.equal(filter.items.length,2);assert.deepEqual(filter.tables[0].columns,['id','status','amount']);assert.equal(filter.summary.tokens,0);
    const dedup=await call('dedup');assert.equal(dedup.items.length,2);
    const aggregate=await call('aggregate');assert.deepEqual(aggregate.items,[{json:{count:3,total:350}}]);
    assert.equal((await call('map')).items[0].json.total,111.00000000000001);
    assert.deepEqual((await call('split',{items:[{a:1},{a:2}]})).items,[{json:{a:1}},{json:{a:2}}]);
    const chats=await call('chats',{chats:{'628@c.us':{messages:[{text:'order'}]},'x@g.us':{messages:[{}]},empty:{messages:[]}}});assert.deepEqual(Object.keys(chats.items[0].json.chats),['628@c.us']);
  });
  test(`${language}: per-item mode, logs, Unicode, empty filtering, syntax errors and bounded execution`,async()=>{
    const each=await executeCode({language,runMode:'each',code:language==='python'?"print('log')\nreturn {'json': {'index': _itemIndex, 'name': _json['name']}}":"console.log('log'); return {json:{index:$itemIndex,name:$json.name}};"},[{name:'日本語'},{name:'Indonesia'}]);assert.equal(each.items[1].json.index,1);assert.equal(each.items[0].json.name,'日本語');assert.equal(each.logs.length,2);
    const empty=await executeCode({language,code:language==='python'?'return []':'return [];'},input);assert.deepEqual(empty.items,[]);
    if(language==='python') assert.equal((await executeCode({language,code:"import datetime\nreturn {'date': datetime.datetime.strptime('2026-10-06', '%Y-%m-%d').isoformat()}"},[])).items[0].json.date,'2026-10-06T00:00:00');
    await assert.rejects(executeCode({language,code:language==='python'?'return [':'return [;'},[]),/SyntaxError/);
    await assert.rejects(executeCode({language,timeoutSeconds:1,code:language==='python'?'while True:\n    pass':'while (true) {}'},[]),/batas|interrupted|memori/);
  });
}
test('sandbox excludes Node globals and Python filesystem, network and child processes',async()=>{
  const js=await executeCode({language:'javascript',code:"return {process:typeof process,require:typeof require,fetch:typeof fetch};"},[]);assert.deepEqual(js.items[0].json,{process:'undefined',require:'undefined',fetch:'undefined'});
  for(const code of ["return open('/etc/passwd').read()","import ctypes\nreturn ctypes.CDLL(None).socket(2,1,0)","import os\nreturn os.fork()","import os\nreturn os.mkfifo('/tmp/code-sandbox-fifo')","import ctypes\nreturn ctypes.CDLL(None).syscall(257, -100, b'/etc/passwd', 0)"]) {
    const result=await executeCode({language:'python',code},[]).catch(e=>e);
    if(result instanceof Error) assert.match(result.message,/Permission|permitted|Import|sandbox/);else assert.equal(result.items[0].json.value,-1);
  }
});
test('Code chains validate and plan without calling AutoAudit APIs',async()=>{
  const node=(id:string,type:any)=>({id,type,position:{x:0,y:0},config:structuredClone(NODE_SPECS[type].defaults)});
  const nodes=[node('t','trigger'),node('c','code'),node('c2','code'),node('e','export')];
  const edges=[['t','c'],['c','c2'],['c2','e']].map(([source,target],i)=>({id:String(i),source,target,sourceHandle:'out',targetHandle:'in'}));
  const graph={nodes,edges};assert.deepEqual(validateGraph(graph),[]);assert.equal(compatible('code','code'),true);assert.equal(canConnect({nodes,edges:[]},edges[1]),null);
  const api=new Proxy({},{get(){throw new Error('Tidak boleh memanggil AutoAudit untuk alur Code.');}});
  const plan=await buildPlan({api:api as any,graph,params:{start_date:'2026-10-01',end_date:'2026-10-01'},companyId:1});assert.equal(plan.units.length,0);assert.equal(plan.totals.tokens,0);
  nodes[3].config.format='md';assert.deepEqual(validateGraph(graph),[]);
});
test('oversized and malformed item payloads are rejected',async()=>{
  assert.throws(()=>codeItems({json:'invalid'}),/objek/);
  assert.throws(()=>dataOutput(Array.from({length:201},(_,i)=>({['column'+i]:i}))),/200 kolom/);
  assert.throws(()=>codeItems(Array.from({length:10001},()=>({}))),/10.000/);
  await assert.rejects(executeCode({language:'javascript',code:"return {content:'x'.repeat(2200000)};"},[]),/output maksimal/);
});
