import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calendarIssues, resolvePeriod, scheduleOn, upcomingDates, wibClock } from './calendar.ts';
import type { AnalysisPeriod, AnalysisSchedule } from './calendar.ts';
const fallback = {start_date:'2026-01-01',end_date:'2026-01-02'};
const range = (p:AnalysisPeriod,anchor:string)=>resolvePeriod(p,anchor,fallback);
test('H-1, H-7 satu hari, tujuh hari terakhir, dan rentang relatif berbeda',()=>{
  assert.deepEqual(range({mode:'yesterday'},'2026-10-01'),{start_date:'2026-09-30',end_date:'2026-09-30'});
  assert.deepEqual(range({mode:'days_ago',days:7},'2026-10-01'),{start_date:'2026-09-24',end_date:'2026-09-24'});
  assert.deepEqual(range({mode:'last_days',days:7,offset:1},'2026-10-01'),{start_date:'2026-09-24',end_date:'2026-09-30'});
  assert.deepEqual(range({mode:'relative',from:7,to:1},'2026-10-01'),range({mode:'last_days',days:7,offset:1},'2026-10-01'));
  assert.deepEqual(range({mode:'last_days',days:2,offset:1},'2026-01-01'),{start_date:'2025-12-30',end_date:'2025-12-31'});
});
test('bulan lengkap, berjalan, minggu lalu dan dua periode setengah bulan',()=>{
  assert.deepEqual(range({mode:'previous_month'},'2026-01-01'),{start_date:'2025-12-01',end_date:'2025-12-31'});
  assert.deepEqual(range({mode:'this_month'},'2026-10-06'),{start_date:'2026-10-01',end_date:'2026-10-06'});
  assert.deepEqual(range({mode:'previous_week'},'2026-10-05'),{start_date:'2026-09-28',end_date:'2026-10-04'});
  assert.deepEqual(range({mode:'half_month'},'2026-03-01'),{start_date:'2026-02-16',end_date:'2026-02-28'});
  assert.deepEqual(range({mode:'half_month'},'2028-03-01'),{start_date:'2028-02-16',end_date:'2028-02-29'});
  assert.deepEqual(range({mode:'half_month'},'2026-01-01'),{start_date:'2025-12-16',end_date:'2025-12-31'});
  assert.deepEqual(range({mode:'half_month'},'2026-10-16'),{start_date:'2026-10-01',end_date:'2026-10-15'});
  assert.deepEqual(range({mode:'run'},'2026-10-16'),fallback);
  assert.deepEqual(range({mode:'custom',start:'2026-05-03',end:'2026-05-06'},'2026-10-16'),{start_date:'2026-05-03',end_date:'2026-05-06'});
});
const schedule:AnalysisSchedule={enabled:true,frequency:'month_end',start:'2026-01-01',time:'08:00'};
test('akhir bulan mengikuti kalender termasuk tahun kabisat',()=>{
  for(const day of ['2026-02-28','2028-02-29','2026-04-30','2026-01-31']) assert.equal(scheduleOn(schedule,day),true);
  for(const day of ['2026-02-27','2028-02-28','2026-04-29','2026-01-30']) assert.equal(scheduleOn(schedule,day),false);
});
test('pengulangan dua hari melintasi pergantian bulan dan tahun',()=>{
  const s={...schedule,frequency:'interval' as const,start:'2025-12-31',interval:2};
  assert.equal(scheduleOn(s,'2025-12-30'),false);assert.equal(scheduleOn(s,'2026-01-02'),true);assert.equal(scheduleOn(s,'2026-01-03'),false);
});
test('Senin, tanggal tertentu, 1 & 16, dan penundaan mulai',()=>{
  assert.equal(scheduleOn({...schedule,frequency:'weekly',weekdays:[1]},'2026-10-05'),true);
  assert.equal(scheduleOn({...schedule,frequency:'weekly',weekdays:[1]},'2026-10-06'),false);
  assert.equal(scheduleOn({...schedule,frequency:'monthly',monthDays:[1,16]},'2026-10-16'),true);
  assert.deepEqual(upcomingDates({...schedule,frequency:'twice_monthly'},new Date('2026-10-01T02:00:00Z')),['2026-10-16','2026-11-01','2026-11-16']);
  assert.equal(scheduleOn({...schedule,start:'2026-12-01'},'2026-11-30'),false);
});
test('WIB dan validasi tanggal serta angka yang salah',()=>{
  assert.deepEqual(wibClock(new Date('2026-09-30T18:00:00Z')),{date:'2026-10-01',time:'01:00'});
  for(const p of [{mode:'custom',start:'2026-02-30',end:'2026-03-01'},{mode:'custom',start:'2026-02-10',end:'2026-02-01'},{mode:'relative',from:1,to:7},{mode:'last_days',days:0,offset:1}] as AnalysisPeriod[]) assert.ok(calendarIssues(p).length);
  assert.ok(calendarIssues({mode:'run'},schedule).length);
  assert.ok(calendarIssues({mode:'yesterday'},{...schedule,frequency:'weekly',weekdays:[]}).length);
});
