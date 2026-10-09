// Isolated PostgreSQL fixture; no audit or outbound message is dispatched.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../apps/server/src/app.ts';
import { stashSecrets } from '../apps/server/src/secrets.ts';
import { wibClock, shiftDay } from '../packages/nodes/src/calendar.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { createPool, migrate } from '../apps/server/src/db.ts';
import { createScheduler } from '../apps/server/src/scheduler.ts';
import { validateGraph } from '../packages/nodes/src/index.ts';
const dir = await mkdtemp(join(tmpdir(),'aw-calendar-'));
const pg = new EmbeddedPostgres({databaseDir:dir,port:55439,user:'postgres',password:'test',persistent:false,onLog:()=>{},onError:()=>{}});
let db: ReturnType<typeof createPool> | undefined;
try {
  await pg.initialise(); await pg.start();
  db = createPool('postgres://postgres:test@127.0.0.1:55439/postgres'); await migrate(db); await migrate(db);
  const graph = { nodes: [
    {id:'t',type:'trigger',position:{x:0,y:0},config:{}},
    {id:'s',type:'sales',position:{x:0,y:0},config:{sales:[{id:1,name:'Fixture'}]}},
    {id:'p',type:'prompt',position:{x:0,y:0},config:{mode:'text',text:'Fixture'}},
    {id:'a',type:'aw',position:{x:0,y:0},config:{model:'mock/model',analysisPeriod:{mode:'half_month'},analysisSchedule:{enabled:true,frequency:'twice_monthly',start:'2026-10-01',time:'08:00'}}},
  ], edges: [
    {id:'e1',source:'t',sourceHandle:'out',target:'s',targetHandle:'in'},
    {id:'e2',source:'s',sourceHandle:'out',target:'a',targetHandle:'source'},
    {id:'e3',source:'p',sourceHandle:'out',target:'a',targetHandle:'prompt'},
  ] };
  assert.deepEqual(validateGraph(graph as any),[]);
  const w = (await db.query("insert into workflows(name,company_id,graph,status,published_at,settings) values('Fixture',1,$1,'published','2026-10-01T00:00:00Z',$2) returning id",[graph,{requireApproval:false}])).rows[0];
  const calls: string[] = [], errors: unknown[] = [];
  const dispatch = async(id:string,approval:boolean)=>{calls.push(id);assert.equal(approval,false);await db!.query("update runs set status='running' where id=$1",[id]);};
  const a = createScheduler(db,dispatch,5,e=>errors.push(e)), b = createScheduler(db,dispatch,5,e=>errors.push(e));
  await a.tick(new Date('2026-10-16T00:59:00Z'));assert.equal(calls.length,0);
  await Promise.all([a.tick(new Date('2026-10-16T01:00:00Z')),b.tick(new Date('2026-10-16T01:00:00Z'))]);
  assert.equal(calls.length,1);assert.equal((await db.query('select count(*)::int as n from runs')).rows[0].n,1);
  const run=(await db.query('select * from runs')).rows[0];assert.equal(run.params.analysis_date,'2026-10-16');assert.equal(run.chunk_confirmed,true);
  await a.tick(new Date('2026-10-16T04:00:00Z'));assert.equal(calls.length,1);
  await db.query("update runs set status='planning' where id=$1",[run.id]);
  await a.tick(new Date('2026-10-17T01:00:00Z'));assert.equal(calls.length,2,'pending planning recovered after restart');
  await db.query("update runs set status='awaiting_approval' where id=$1",[run.id]);
  await a.tick(new Date('2026-10-17T01:00:00Z'));assert.equal(calls.length,3,'automatic approval recovered after restart');
  await db.query("update workflows set status='draft' where id=$1",[w.id]);await a.tick(new Date('2026-11-01T01:00:00Z'));assert.equal(calls.length,3);
  await db.query("update workflows set status='published',published_at='2026-11-01T02:00:00Z' where id=$1",[w.id]);await a.tick(new Date('2026-11-01T03:00:00Z'));assert.equal(calls.length,3,'publication after occurrence does not replay it');
  const startGraph:any = structuredClone(graph);
  startGraph.nodes[3].config.analysisSchedule.enabled = false;
  startGraph.nodes[3].config.analysisPeriod = {mode:'run'};
  startGraph.nodes[0].config = {mode:'schedule',triggerPeriod:{mode:'previous_week'},triggerSchedule:{frequency:'weekly',weekdays:[1],start:'2026-11-01',time:'08:00'}};
  assert.deepEqual(validateGraph(startGraph),[]);
  startGraph.nodes[3].config.analysisSchedule.enabled = true;
  assert.ok(validateGraph(startGraph).some(i=>i.message.includes('Nonaktifkan')));
  startGraph.nodes[3].config.analysisSchedule.enabled = false;
  await db.query("update workflows set graph=$2,published_at='2026-11-01T00:00:00Z' where id=$1",[w.id,startGraph]);
  await a.tick(new Date('2026-11-02T00:59:00Z'));assert.equal(calls.length,3);
  await Promise.all([a.tick(new Date('2026-11-02T01:00:00Z')),b.tick(new Date('2026-11-02T01:00:00Z'))]);assert.equal(calls.length,4);
  const startRun=(await db.query("select * from runs where params->>'trigger_source'='schedule'")).rows[0];
  assert.equal(startRun.params.start_date,'2026-10-26');assert.equal(startRun.params.end_date,'2026-11-01');
  await a.tick(new Date('2026-11-03T01:00:00Z'));assert.equal(calls.length,4,'weekly Start skips other weekdays');
  startGraph.nodes[0].config.triggerSchedule={frequency:'monthly',monthDays:[5],start:'2026-11-01',time:'09:15'};
  await db.query('update workflows set graph=$2 where id=$1',[w.id,startGraph]);
  await a.tick(new Date('2026-11-04T04:00:00Z'));assert.equal(calls.length,4);
  await a.tick(new Date('2026-11-05T02:15:00Z'));assert.equal(calls.length,5);
  startGraph.nodes[0].config.triggerSchedule={frequency:'daily',start:'2026-11-01',time:'10:00'};
  await db.query('update workflows set graph=$2 where id=$1',[w.id,startGraph]);
  await a.tick(new Date('2026-11-06T03:00:00Z'));assert.equal(calls.length,6);
  await a.tick(new Date('2026-11-06T03:01:00Z'));assert.equal(calls.length,6,'daily Start deduplicates');
  const master=randomBytes(32), token='fixture-webhook-token-32-characters-long';
  startGraph.nodes[0].config={mode:'webhook',triggerPeriod:{mode:'yesterday'},webhookToken:token};
  const safe=await stashSecrets(db,master,w.id,startGraph);
  assert.equal(safe.nodes[0].config.webhookToken,'');assert.equal(safe.nodes[0].config.webhookTokenHint,token.slice(-4));
  await db.query('update workflows set graph=$2 where id=$1',[w.id,safe]);
  const app=buildApp({db,api:{} as any,executor:{} as any,masterKey:master,globalConcurrency:5,secureCookie:false});
  try {
    const call=(payload:any={},auth=token)=>app.inject({method:'POST',url:`/integration/v1/workflows/${w.id}/webhook`,headers:{authorization:`Bearer ${auth}`},payload});
    assert.equal((await call({},'wrong')).statusCode,401);
    assert.equal((await call({start_date:'2026-02-30',end_date:'2026-03-01'})).statusCode,400);
    assert.equal((await call({start_date:'2026-10-05'})).statusCode,400);
    assert.equal((await call({start_date:'2026-10-06',end_date:'2026-10-05'})).statusCode,400);
    const [first,second]=await Promise.all([call({request_id:'same-request'}),call({request_id:'same-request'})]);
    assert.deepEqual([first.statusCode,second.statusCode].sort(),[200,202]);
    assert.equal(first.json().id,second.json().id);
    const hookRun=(await db.query('select * from runs where id=$1',[first.json().id])).rows[0];
    assert.equal(hookRun.params.start_date,shiftDay(wibClock().date,-1));assert.equal(hookRun.params.trigger_source,'webhook');assert.equal(hookRun.chunk_confirmed,true);
    const explicit=await call({start_date:'2026-10-01',end_date:'2026-10-03',request_id:'explicit'});assert.equal(explicit.statusCode,202);
    assert.equal((await db.query('select params from runs where id=$1',[explicit.json().id])).rows[0].params.end_date,'2026-10-03');
    await db.query("update workflows set status='draft' where id=$1",[w.id]);assert.equal((await call()).statusCode,401);
    await db.query("update workflows set status='published' where id=$1",[w.id]);
    safe.nodes[0].config.mode='manual';await db.query('update workflows set graph=$2 where id=$1',[w.id,safe]);assert.equal((await call()).statusCode,401);
  } finally {await app.close();}
  assert.deepEqual(errors,[]);console.log('PASS: PostgreSQL migration, occurrence deduplication, concurrent schedulers, restart recovery, draft pause, publication boundary, Start daily/weekly/monthly triggers, encrypted webhook, date validation and webhook retry deduplication.');
} finally {await db?.end();await pg.stop().catch(()=>{});await rm(dir,{recursive:true,force:true});}
