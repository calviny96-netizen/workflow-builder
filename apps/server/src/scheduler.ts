import { calendarIssues, resolvePeriod, scheduleOn, wibClock } from '../../../packages/nodes/src/calendar.ts';
import { validateGraph } from '../../../packages/nodes/src/index.ts';
import type { Graph } from '../../../packages/nodes/src/index.ts';
import type { Db } from './db.ts';
// Claim each occurrence durably. Workflow row locks serialize with edits and lifecycle changes.
export function createScheduler(db: Db, dispatch: (id: string, requireApproval: boolean) => Promise<void>, concurrency: number, log: (error: unknown) => void = console.error) {
  let busy = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  async function tick(now = new Date()) {
    if (busy) return;
    busy = true;
    try {
      const clock = wibClock(now);
      const workflows = (await db.query("select id from workflows where status='published' and company_id is not null and jsonb_path_exists(graph, '$.nodes[*] ? ((@.type == \"aw\" && @.config.analysisSchedule.enabled == true) || (@.type == \"trigger\" && @.config.mode == \"schedule\"))')")).rows;
      for (const {id} of workflows) {
        const client = await db.connect();
        try {
          await client.query('begin');
          const w = (await client.query("select * from workflows where id=$1 and status='published' for update",[id])).rows[0];
          if (!w) {await client.query('rollback');continue;}
          const graph: Graph = w.graph;
          const start = graph.nodes.find(n=>n.type==='trigger' && n.config.mode==='schedule');
          const driver = start ?? graph.nodes.find(n=>n.type==='aw' && n.config.analysisSchedule?.enabled);
          const period = start ? start.config.triggerPeriod ?? {mode:'yesterday'} : driver?.config.analysisPeriod;
          const schedule = start ? {...start.config.triggerSchedule,enabled:true} : driver?.config.analysisSchedule;
          if (!driver || calendarIssues(period,schedule).length || validateGraph(graph).length || !scheduleOn(schedule,clock.date) || schedule.time > clock.time) {await client.query('rollback');continue;}
          const key = `${driver.id}:${clock.date}:${schedule.time}`;
          // Do not replay an occurrence whose time was before its latest publication.
          const occurrence = new Date(`${clock.date}T${schedule.time}:00+07:00`);
          if (w.published_at && occurrence < new Date(w.published_at)) {await client.query('rollback');continue;}
          const params = {...(start ? resolvePeriod(period,clock.date,{start_date:clock.date,end_date:clock.date}) : {start_date:clock.date,end_date:clock.date}),trigger_source:start ? 'schedule' : 'aw_schedule',analysis_date:clock.date,schedule_key:key,require_approval:w.settings?.requireApproval !== false};
          await client.query(`insert into runs(workflow_id,company_id,graph,params,concurrency,created_by,chunk_confirmed)
            values($1,$2,$3,$4,$5,$6,true) on conflict do nothing`,[w.id,w.company_id,w.graph,params,Math.min(concurrency,Number(w.settings?.concurrency)||concurrency),w.created_by]);
          await client.query('commit');
        } catch(error) {await client.query('rollback');log(error);} finally {client.release();}
      }
      // Also recover occurrences claimed before a restart during planning.
      const pending = (await db.query(`select r.id, r.params from runs r join workflows w on w.id=r.workflow_id
        where (r.status='planning' or (r.status='awaiting_approval' and r.params->>'require_approval'='false')) and r.params ? 'schedule_key' and w.status='published' order by r.created_at`)).rows;
      for (const run of pending) {
        const client = await db.connect();
        try {
          const locked = (await client.query('select pg_try_advisory_lock(hashtextextended($1, 0)) as locked',[run.id])).rows[0]?.locked;
          if (!locked) continue;
          try {
            const current = (await db.query('select status from runs where id=$1',[run.id])).rows[0];
            if(current?.status==='planning' || current?.status==='awaiting_approval') await dispatch(run.id,run.params.require_approval !== false);
          } finally {await client.query('select pg_advisory_unlock(hashtextextended($1, 0))',[run.id]);}
        } catch(error) {log(error);} finally {client.release();}
      }
    } catch(error) {log(error);} finally {busy=false;}
  }
  return { tick, start() {if(!timer){timer=setInterval(()=>{void tick();},30_000);void tick();}}, stop() {if(timer)clearInterval(timer);timer=undefined;} };
}
