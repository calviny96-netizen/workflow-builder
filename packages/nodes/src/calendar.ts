// Calendar arithmetic uses date-only UTC values; the execution clock is always WIB.
export type PeriodMode = 'run' | 'today' | 'yesterday' | 'days_ago' | 'last_days' | 'this_month' | 'previous_month' | 'previous_week' | 'half_month' | 'relative' | 'custom';
export interface AnalysisPeriod { mode: PeriodMode; days?: number; offset?: number; from?: number; to?: number; start?: string; end?: string }
export interface AnalysisSchedule { enabled?: boolean; frequency: 'daily' | 'interval' | 'weekly' | 'monthly' | 'month_end' | 'twice_monthly'; time: string; start: string; interval?: number; weekdays?: number[]; monthDays?: number[] }
export const PERIOD_LABELS: Record<PeriodMode, string> = { run: 'Ikuti tanggal saat Run', today: 'Hari ini', yesterday: 'Kemarin (H-1)', days_ago: 'Satu hari tertentu (H-n)', last_days: 'Beberapa hari terakhir', this_month: 'Bulan berjalan', previous_month: 'Bulan lalu, lengkap', previous_week: 'Minggu lalu (Senin–Minggu)', half_month: 'Setengah bulan sebelumnya', relative: 'Rentang relatif (H-n sampai H-n)', custom: 'Tanggal khusus' };
export const WEEKDAYS = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
export function wibClock(now = new Date()) { const shifted = new Date(now.getTime() + 7 * 3600000); return { date: shifted.toISOString().slice(0, 10), time: shifted.toISOString().slice(11, 16) }; }
export function validDate(s: unknown): s is string { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s; }
const iso = (d: Date) => d.toISOString().slice(0,10);
export function shiftDay(day: string, n: number) { const d = new Date(day); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
const integer = (n: unknown, min: number, max: number) => Number.isInteger(n) && Number(n) >= min && Number(n) <= max;
export function calendarIssues(p?: AnalysisPeriod, s?: AnalysisSchedule): string[] {
  const errors: string[] = [];
  if (p && !Object.hasOwn(PERIOD_LABELS, p.mode)) errors.push('Pilih periode analisis yang valid.');
  if (p?.mode === 'custom' && (!validDate(p.start) || !validDate(p.end) || p.end < p.start)) errors.push('Isi tanggal khusus yang valid; tanggal selesai harus sama atau setelah tanggal mulai.');
  if (p?.mode === 'days_ago' && !integer(p.days, 0, 3660)) errors.push('H-n harus berupa angka 0–3660.');
  if (p?.mode === 'last_days' && (!integer(p.days,1,3660) || !integer(p.offset,0,3660))) errors.push('Isi jumlah hari (1–3660) dan jeda hari (0–3660).');
  if (p?.mode === 'relative' && (!integer(p.from,0,3660) || !integer(p.to,0,3660) || Number(p.from) < Number(p.to))) errors.push('Awal H-n harus sama atau lebih besar dari akhir H-n.');
  if (s?.enabled) {
    if (!['daily','interval','weekly','monthly','month_end','twice_monthly'].includes(s.frequency)) errors.push('Pilih pengulangan jadwal yang valid.');
    if (!validDate(s.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) errors.push('Isi tanggal mulai dan jam jadwal yang valid (WIB).');
    if (s.frequency === 'interval' && !integer(s.interval,1,366)) errors.push('Jadwal berulang setiap 1–366 hari.');
    if (s.frequency === 'weekly' && (!s.weekdays?.length || s.weekdays.some(d=>!integer(d,0,6)))) errors.push('Pilih minimal satu hari dalam minggu.');
    if (s.frequency === 'monthly' && (!s.monthDays?.length || s.monthDays.some(d=>!integer(d,1,31)))) errors.push('Pilih minimal satu tanggal bulanan (1–31).');
    if (!p || p.mode === 'run') errors.push('Jadwal otomatis membutuhkan periode analisis selain “Ikuti tanggal saat Run”.');
  }
  return errors;
}
export function resolvePeriod(p: AnalysisPeriod | undefined, anchor: string, fallback: { start_date: string; end_date: string }) {
  if (!validDate(anchor)) throw new Error('Tanggal acuan analisis tidak valid.');
  const errors = calendarIssues(p); if (errors.length) throw new Error(errors.join(' '));
  const d = new Date(anchor), y = d.getUTCFullYear(), m = d.getUTCMonth();
  const month = (delta: number, day: number) => iso(new Date(Date.UTC(y,m+delta,day)));
  let start = anchor, end = anchor;
  switch (p?.mode ?? 'run') {
    case 'run': return fallback;
    case 'today': break;
    case 'yesterday': start = end = shiftDay(anchor,-1); break;
    case 'days_ago': start = end = shiftDay(anchor,-p!.days!); break;
    case 'last_days': end = shiftDay(anchor,-p!.offset!); start = shiftDay(end,1-p!.days!); break;
    case 'relative': start = shiftDay(anchor,-p!.from!); end = shiftDay(anchor,-p!.to!); break;
    case 'this_month': start = month(0,1); break;
    case 'previous_month': start = month(-1,1); end = month(0,0); break;
    case 'previous_week': end = shiftDay(anchor,-((d.getUTCDay()+6)%7)-1); start = shiftDay(end,-6); break;
    case 'half_month': if(d.getUTCDate() <= 15) {start = month(-1,16); end = month(0,0);} else {start = month(0,1); end = month(0,15);} break;
    case 'custom': start = p!.start!; end = p!.end!; break;
  }
  return { start_date: start, end_date: end };
}
export function scheduleOn(s: AnalysisSchedule, day: string) {
  if (!s.enabled || !validDate(day) || !validDate(s.start) || day < s.start) return false;
  const d = new Date(day), n = d.getUTCDate();
  switch(s.frequency) {
    case 'daily': return true;
    case 'interval': return (Date.parse(day)-Date.parse(s.start))/86400000 % Number(s.interval) === 0;
    case 'weekly': return s.weekdays?.includes(d.getUTCDay()) ?? false;
    case 'monthly': return s.monthDays?.includes(n) ?? false;
    case 'month_end': return shiftDay(day,1).slice(0,7) !== day.slice(0,7);
    case 'twice_monthly': return n === 1 || n === 16;
  }
  return false;
}
export function upcomingDates(s: AnalysisSchedule, now = new Date(), count = 3) {
  const clock = wibClock(now), dates: string[] = [];
  let day = clock.date;
  for(let i=0;i<1500 && dates.length<count;i++,day=shiftDay(day,1)) if(scheduleOn(s,day) && (day !== clock.date || s.time > clock.time)) dates.push(day);
  return dates;
}
