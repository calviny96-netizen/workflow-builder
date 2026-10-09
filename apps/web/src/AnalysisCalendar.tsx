import { PERIOD_LABELS, WEEKDAYS, calendarIssues, resolvePeriod, upcomingDates, wibClock } from '@nodes';
import type { AnalysisPeriod, AnalysisSchedule, PeriodMode } from '@nodes';
import { Select } from './Select.tsx';
const displayDate = (day: string) => new Date(day).toLocaleDateString('id-ID', {day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});
export function AnalysisCalendar({config,onChange,startMode}: {startMode?: 'schedule' | 'webhook'; config: Record<string,any>; onChange: (patch: Record<string,any>)=>void}) {
  const today = wibClock().date;
  const p: AnalysisPeriod = config.analysisPeriod ?? {mode:'run'};
  const s: AnalysisSchedule = {frequency:'daily',time:'08:00',start:today,...config.analysisSchedule};
  if(!s.start) s.start = today;
  const period = (patch: Partial<AnalysisPeriod>)=>onChange({analysisPeriod:{...p,...patch}});
  const schedule = (patch: Partial<AnalysisSchedule>)=>onChange({analysisSchedule:{...s,...patch}});
  const presets: {label:string; period:AnalysisPeriod; schedule: Partial<AnalysisSchedule>}[] = [
    {label:'Harian · H-1',period:{mode:'yesterday'},schedule:{frequency:'daily'}},
    {label:'Tiap 2 hari',period:{mode:'last_days',days:2,offset:1},schedule:{frequency:'interval',interval:2}},
    {label:'Senin · minggu lalu',period:{mode:'previous_week'},schedule:{frequency:'weekly',weekdays:[1]}},
    {label:'Tanggal 1 · bulan lalu',period:{mode:'previous_month'},schedule:{frequency:'monthly',monthDays:[1]}},
    {label:'Akhir bulan',period:{mode:'this_month'},schedule:{frequency:'month_end'}},
    {label:'Tanggal 1 & 16',period:{mode:'half_month'},schedule:{frequency:'twice_monthly'}},
  ];
  const errors = calendarIssues(p,s);
  const next = errors.length ? [] : upcomingDates(s);
  let preview: ReturnType<typeof resolvePeriod> | null = null;
  try { preview = resolvePeriod(p,today,{start_date:today,end_date:today}); } catch { /* Inline validation below. */ }
  const numberInput = (label:string,key:'days'|'offset'|'from'|'to',min:number,value:number)=><label>{label}<input type="number" min={min} max={3660} value={p[key] ?? value} onChange={e=>period({[key]:e.target.value === '' ? undefined : Number(e.target.value)})}/></label>;
  return <section className="analysis-calendar" aria-label="Periode dan jadwal analisis">
    <div className="panel-title">{startMode === 'webhook' ? 'Periode default webhook' : startMode ? 'Periode & jadwal Start' : 'Periode & jadwal analisis'}</div>
    <p className="muted small">{startMode === 'webhook' ? 'Pilih periode yang dipakai jika webhook tidak mengirim tanggal.' : 'Pilih data yang dianalisis, lalu tentukan kapan workflow berjalan.'}</p>
    {startMode !== 'webhook' && <><span className="small">Atur cepat</span>
    <div className="calendar-presets">{presets.map(preset=><button type="button" className="btn small" key={preset.label} onClick={()=>onChange({analysisPeriod:preset.period,analysisSchedule:{...s,...preset.schedule,enabled:true}})}>{preset.label}</button>)}</div></>}
    <label>Data dari tanggal berapa?<Select value={p.mode} onChange={e=>period({mode:e.target.value as PeriodMode,days:7,offset:1,from:7,to:1})}>{Object.entries(PERIOD_LABELS).map(([key,label])=><option value={key} key={key}>{label}</option>)}</Select></label>
    {p.mode === 'days_ago' && <>{numberInput('Berapa hari sebelum dijalankan?', 'days',0,7)}<p className="muted small">H-7 berarti hanya satu hari, tepat 7 hari sebelum analisis dijalankan.</p></>}
    {p.mode === 'last_days' && <><div className="row">{numberInput('Jumlah hari','days',1,7)}{numberInput('Berakhir H-n','offset',0,1)}</div><p className="muted small">Berakhir H-1 berarti sampai kemarin. Pilih H-0 untuk menyertakan hari ini.</p></>}
    {p.mode === 'relative' && <><div className="row">{numberInput('Mulai H-n','from',0,7)}{numberInput('Sampai H-n','to',0,1)}</div><p className="muted small">Contoh H-7 sampai H-1: tujuh hari penuh sebelum dijalankan.</p></>}
    {p.mode === 'custom' && <div className="row"><label>Tanggal mulai<input type="date" value={p.start ?? ''} onChange={e=>period({start:e.target.value})}/></label><label>Tanggal selesai<input type="date" min={p.start} value={p.end ?? ''} onChange={e=>period({end:e.target.value})}/></label></div>}
    {p.mode === 'this_month' && <p className="muted small">Tanggal 1 bulan berjalan sampai hari analisis. Untuk laporan bulan lengkap setiap tanggal 1, pilih “Bulan lalu, lengkap”.</p>}
    {p.mode === 'half_month' && <p className="muted small">Dijalankan tanggal 1: analisis tanggal 16–akhir bulan lalu. Dijalankan tanggal 16: analisis tanggal 1–15 bulan ini.</p>}
    {p.mode === 'run' ? <p className="muted small">{startMode === 'webhook' ? 'Tanggal dapat dikirim melalui body webhook. Tanpa tanggal, gunakan hari ini (WIB).' : 'Rentang tanggal dipilih saat menekan Run.'}</p> : preview && <div className="calendar-example"><span>Jika dijalankan hari ini</span><strong>{displayDate(preview.start_date)} – {displayDate(preview.end_date)}</strong><small>Kedua tanggal ikut dianalisis.</small></div>}
    {!startMode && <label className="check"><input type="checkbox" checked={s.enabled === true} onChange={e=>onChange({analysisSchedule:{...s,enabled:e.target.checked},...(e.target.checked && p.mode==='run'?{analysisPeriod:{mode:'yesterday'}}:{})})}/>Jalankan otomatis</label>}
    {s.enabled && <>
      <label>Kapan dijalankan?<Select value={s.frequency} onChange={e=>schedule({frequency:e.target.value as AnalysisSchedule['frequency'],interval:s.interval??2,weekdays:s.weekdays??[1],monthDays:s.monthDays??[1]})}><option value="daily">Setiap hari</option><option value="interval">Setiap beberapa hari</option><option value="weekly">Hari tertentu setiap minggu</option><option value="monthly">Tanggal tertentu setiap bulan</option><option value="month_end">Hari terakhir setiap bulan</option><option value="twice_monthly">Tanggal 1 dan 16 setiap bulan</option></Select></label>
      {s.frequency==='interval' && <label>Ulangi setiap (hari)<input type="number" min={1} max={366} value={s.interval??2} onChange={e=>schedule({interval:Number(e.target.value)})}/></label>}
      {s.frequency==='weekly' && <fieldset className="calendar-days"><legend>Pilih hari</legend>{[1,2,3,4,5,6,0].map(day=><label key={day}><input type="checkbox" checked={s.weekdays?.includes(day)??false} onChange={e=>schedule({weekdays:e.target.checked?[...(s.weekdays??[]),day]:(s.weekdays??[]).filter(d=>d!==day)})}/>{WEEKDAYS[day]}</label>)}</fieldset>}
      {s.frequency==='monthly' && <><fieldset className="calendar-days month-days"><legend>Pilih tanggal</legend>{Array.from({length:31},(_,i)=>i+1).map(day=><label key={day}><input type="checkbox" checked={s.monthDays?.includes(day)??false} onChange={e=>schedule({monthDays:e.target.checked?[...(s.monthDays??[]),day]:(s.monthDays??[]).filter(d=>d!==day)})}/>{day}</label>)}</fieldset><p className="muted small">Tanggal yang tidak ada dalam suatu bulan dilewati. Pilih “Hari terakhir” agar selalu mengikuti akhir bulan.</p></>}
      {s.frequency==='month_end' && <p className="muted small">Otomatis tanggal 28/29, 30, atau 31 sesuai bulan.</p>}
      <div className="row"><label>Mulai tanggal<input type="date" value={s.start} onChange={e=>schedule({start:e.target.value})}/></label><label>Jam mulai (WIB)<input type="time" value={s.time} onChange={e=>schedule({time:e.target.value})}/></label></div>
      <p className="muted small">Satu jadwal otomatis menjalankan seluruh workflow. Tiap AW memakai periode pilihannya. Publish workflow untuk mengaktifkan jadwal; server harus tetap berjalan.</p>
      <div className="calendar-example" aria-live="polite"><span>Jadwal berikutnya · WIB</span>{next.map(day=>{const range=resolvePeriod(p,day,{start_date:day,end_date:day});return <div className="calendar-occurrence" key={day}><strong>{displayDate(day)} · {s.time}</strong><small>Analisis {displayDate(range.start_date)} – {displayDate(range.end_date)}</small></div>;})}{!next.length&&!errors.length&&<small>Tidak ada jadwal mendatang untuk pengaturan ini.</small>}</div>
      <p className="muted small">Jam di atas adalah waktu mulai analisis. Hasil dikirim setelah analisis selesai melalui node Kirim Pesan atau HTTP Request yang terhubung. Pengaturan “Konfirmasi sebelum jalan” tetap berlaku.</p>
      {p.mode==='custom' && <p className="notice small">Tanggal khusus tetap sama pada setiap pengulangan.</p>}
    </>}
    {errors.length>0 && <div className="notice small" role="alert">{errors.map(e=><p key={e}>{e}</p>)}</div>}
  </section>;
}
