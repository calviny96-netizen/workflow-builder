// Isolated PostgreSQL + real code runtimes. No live audit, external HTTP or Sheets writes.
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import ExcelJS from 'exceljs';
import {createPool,migrate} from '../apps/server/src/db.ts';
import {hashPassword} from '../apps/server/src/auth.ts';
import {buildApp} from '../apps/server/src/app.ts';
import {createExecutor} from '../apps/server/src/executor.ts';
import {NODE_SPECS} from '../packages/nodes/src/index.ts';
import {CODE_TEMPLATES} from '../packages/nodes/src/code.ts';
const dir=await mkdtemp(join(tmpdir(),'code-node-'));
const pg=new EmbeddedPostgres({databaseDir:join(dir,'pg'),port:55442,user:'postgres',password:'test',persistent:false,onLog:()=>{},onError:()=>{}});
let db:ReturnType<typeof createPool>|undefined,app:ReturnType<typeof buildApp>|undefined;
try {
  await pg.initialise();await pg.start();
  db=createPool('postgres://postgres:test@127.0.0.1:55442/postgres');await migrate(db);
  const masterKey=randomBytes(32),id=randomUUID(),password=randomUUID(),email='fixture@local.test';
  await db.query('insert into users(id,email,password_hash) values($1,$2,$3)',[id,email,await hashPassword(password)]);
  const http:any[]=[],sheet:any[]=[],logs:string[]=[];
  const api=new Proxy({},{get(){throw new Error('Alur Code tidak boleh memanggil AutoAudit.');}}) as any;
  const sheets:any={tabs:async()=>({title:'Fixture',tabs:[{gid:0,title:'Data'}]}),read:async()=>[['count','total']],update:async(...args:any[])=>sheet.push({update:args}),append:async(...args:any[])=>sheet.push({append:args})};
  const executor=createExecutor({db,api,sheets,masterKey,filesDir:join(dir,'files'),globalConcurrency:2,fetch:async(_url,options)=>{http.push(JSON.parse(String(options?.body)));return new Response('{"accepted":true}',{status:200});},log:m=>logs.push(m)});
  app=buildApp({db,api,executor,sheets,masterKey,globalConcurrency:2,secureCookie:false});
  assert.equal((await app.inject({method:'POST',url:'/api/code/test',payload:{}})).statusCode,401);
  const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{email,password}});assert.equal(login.statusCode,200);const cookie=String(login.headers['set-cookie']).split(';')[0];
  const call=async(method:any,url:string,payload?:any)=>{const res=await app!.inject({method,url,headers:{cookie},payload});assert.equal(res.statusCode,200,`${url}: ${res.body}`);return res.json();};
  const test=await call('POST','/api/code/test',{language:'python',code:"return [{'json': {'ok': True}}]",items:[]});assert.equal(test.items[0].json.ok,true);
  const node=(id:string,type:any,config:any={})=>({id,type,position:{x:0,y:0},config:{...structuredClone(NODE_SPECS[type].defaults),...config}});
  const nodes=[node('t','trigger'),node('filter','code',{code:CODE_TEMPLATES.filter.javascript}),node('total','code',{language:'python',code:CODE_TEMPLATES.aggregate.python}),node('export','export',{split:'combined'}),node('http','http',{destination:'custom',url:'https://fixture.invalid/out',method:'POST'}),node('response','code',{code:'return $input.all().map(item=>({json:{...item.json,received:true}}));'}),node('sheet','sheets',{url:'https://docs.google.com/spreadsheets/d/123456789012345678901234567890/edit',gid:0,tabTitle:'Data',mode:'append'})];
  const edges=[['t','filter'],['filter','total'],['total','export'],['total','http'],['http','response'],['total','sheet']].map(([source,target],i)=>({id:String(i),source,target,sourceHandle:'out',targetHandle:'in'}));
  const workflow=await call('POST','/api/workflows',{name:'Fixture Code',company_id:1,company_name:'Fixture',graph:{nodes,edges},settings:{requireApproval:false}});
  assert.deepEqual((await call('GET',`/api/workflows/${workflow.id}`)).issues,[]);
  const {id:runId}=await call('POST',`/api/workflows/${workflow.id}/runs`,{start_date:'2026-10-01',end_date:'2026-10-01'});
  for(let i=0;i<20;i++){if((await db.query('select status from runs where id=$1',[runId])).rows[0].status==='running')break;await new Promise(r=>setTimeout(r,10));}
  await executor.tick();
  const run=await call('GET',`/api/runs/${runId}`);assert.equal(run.status,'completed');assert.equal(run.units.length,0);assert.equal(run.plan.totals.tokens,0);assert.equal(run.steps.length,6);assert.ok(run.steps.every((s:any)=>s.status==='done'));
  const responseStep=run.steps.find((s:any)=>s.node_id==='response');assert.deepEqual((await call('GET',`/api/steps/${responseStep.id}`)).items,[{json:{accepted:true,received:true}}]);
  assert.equal(http.length,1);assert.deepEqual(http[0].items,[{json:{count:2,total:150}}]);
  assert.deepEqual(sheet.find(r=>r.append).append[2],[['2','150']]);
  const fileStep=(await db.query("select output from steps where run_id=$1 and type='export'",[runId])).rows[0].output;
  const workbook=new ExcelJS.Workbook();await workbook.xlsx.readFile(fileStep.file.path);assert.equal(workbook.worksheets[0].getCell('A2').value,'2');assert.equal(workbook.worksheets[0].getCell('B2').value,'150');
  const codeStep=run.steps.find((s:any)=>s.node_id==='total');const detail=await call('GET',`/api/steps/${codeStep.id}`);assert.deepEqual(detail.items,[{json:{count:2,total:150}}]);
  // An empty filter stays empty downstream instead of reverting to the node's sample input.
  nodes[1].config.code='return [];';nodes[2].config.code='return _input.all()';nodes[3].config.format='md';
  await call('PUT',`/api/workflows/${workflow.id}`,{name:'Fixture Code',company_id:1,company_name:'Fixture',graph:{nodes:nodes.slice(0,4),edges:edges.slice(0,3)},settings:{requireApproval:false}});
  const empty=await call('POST',`/api/workflows/${workflow.id}/runs`,{start_date:'2026-10-01',end_date:'2026-10-01'});
  for(let i=0;i<20;i++){if((await db.query('select status from runs where id=$1',[empty.id])).rows[0].status==='running')break;await new Promise(r=>setTimeout(r,10));}
  await executor.tick();const emptyRun=await call('GET',`/api/runs/${empty.id}`);assert.equal(emptyRun.status,'completed');assert.equal(emptyRun.steps.find((s:any)=>s.node_id==='total').summary.items,0);
  assert.ok(logs.every(m=>!m.includes('gagal')),logs.join('\n'));
  console.log('PASS: authenticated code testing, no-LLM planning, JS → Python chain, HTTP JSON, Sheets rows, actual XLSX export, saved output and empty-filter propagation.');
} finally {await app?.close();await db?.end();await pg.stop().catch(()=>{});await rm(dir,{recursive:true,force:true});}
