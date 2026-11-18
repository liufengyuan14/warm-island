export interface Schedule {
  effective: string;
  name: string;
  dose: string;
  times: string[];
  note: string;
  active: boolean;
}
export interface Plan { id: string; versions: Schedule[] }
export interface DoseRecord {
  id: string;
  date: string;
  planId: string;
  time: string;
  name: string;
  dose: string;
  status: 'taken' | 'skipped';
  actual: string | null;
  recordedAt: string;
  note: string;
}
export interface MedicationState {
  version: 2;
  plans: Plan[];
  records: DoseRecord[];
  reminders: boolean;
  notified: Record<string, number>;
}
export interface Slot {
  id: string;
  date: string;
  planId: string;
  time: string;
  name: string;
  dose: string;
  note: string;
  record?: DoseRecord;
}
export const STORE = 'warm-island-medication-v2';
export const pad = (n: number): string => String(n).padStart(2, '0');
export function dayKey(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function validDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime()) && dayKey(date) === value;
}
export function shiftDay(day: string, amount: number): string {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + amount);
  return dayKey(d);
}
export const validTime = (s: unknown): s is string => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
export const slotId = (date: string, planId: string, time: string): string => `${date}|${planId}|${time}`;
export function emptyState(): MedicationState {
  return { version: 2, plans: [], records: [], reminders: false, notified: {} };
}
function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('数据格式不正确');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new Error('文本字段不正确或过长');
  return value.trim();
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new Error('计划标识不正确');
  return value;
}
function iso(value: unknown): string {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('记录时间不正确');
  return value;
}
export function validateState(input: unknown): MedicationState {
  const raw = obj(input);
  if (raw.version !== 2 || !Array.isArray(raw.plans) || !Array.isArray(raw.records) || raw.plans.length > 50 || raw.records.length > 20000) throw new Error('备份版本不支持或记录过多');
  const ids = new Set<string>();
  const plans: Plan[] = raw.plans.map(value => {
    const p = obj(value);
    const id = identifier(p.id);
    if (ids.has(id)) throw new Error('存在重复计划');
    ids.add(id);
    if (!Array.isArray(p.versions) || !p.versions.length || p.versions.length > 100) throw new Error('计划版本不正确');
    const versions: Schedule[] = p.versions.map(item => {
      const v = obj(item);
      if (!validDay(v.effective) || typeof v.active !== 'boolean' || !Array.isArray(v.times) || !v.times.length || v.times.length > 8 || !v.times.every(validTime)) throw new Error('用药时间或日期不正确');
      const times = [...new Set(v.times as string[])].sort();
      if (times.length !== v.times.length) throw new Error('同一计划不能包含重复时间');
      return { effective: v.effective, name: text(v.name, 60, true), dose: text(v.dose, 80), times, note: text(v.note, 240), active: v.active };
    }).sort((a, b) => a.effective.localeCompare(b.effective));
    if (new Set(versions.map(v => v.effective)).size !== versions.length) throw new Error('同一天存在重复计划版本');
    return { id, versions };
  });
  const boundaries = new Set(plans.flatMap(plan => plan.versions.map(v => v.effective)));
  for (const date of boundaries) {
    const scheduled = new Set<string>();
    for (const plan of plans) {
      const version = scheduleAt(plan, date);
      if (!version?.active) continue;
      for (const time of version.times) {
        const key = version.name.normalize('NFKC').replace(/\s/g, '').toLowerCase() + '|' + time;
        if (scheduled.has(key)) throw new Error('同一药名在同一时间已有计划，请修改已有计划，避免重复打卡');
        scheduled.add(key);
      }
    }
  }
  const recordIds = new Set<string>();
  const records: DoseRecord[] = raw.records.map(value => {
    const r = obj(value);
    if (!validDay(r.date) || !validTime(r.time) || !['taken', 'skipped'].includes(String(r.status))) throw new Error('打卡日期、时间或状态不正确');
    const planId = identifier(r.planId);
    const id = slotId(r.date, planId, r.time);
    if (r.id !== id || !ids.has(planId) || recordIds.has(id)) throw new Error('打卡重复或找不到对应计划');
    recordIds.add(id);
    const actual = r.status === 'taken' ? iso(r.actual) : null;
    if (r.status === 'skipped' && r.actual !== null) throw new Error('未服用记录不能有服药时间');
    return { id, date: r.date, planId, time: r.time, name: text(r.name, 60, true), dose: text(r.dose, 80), status: r.status as DoseRecord['status'], actual, recordedAt: iso(r.recordedAt), note: text(r.note, 240) };
  });
  const state: MedicationState = { version: 2, plans, records, reminders: raw.reminders === true, notified: {} };
  for (const record of records) {
    const plan = plans.find(p => p.id === record.planId)!;
    const schedule = scheduleAt(plan, record.date);
    if (!schedule?.active || !schedule.times.includes(record.time) || schedule.name !== record.name || schedule.dose !== record.dose) throw new Error('记录与当日计划不一致');
  }
  if (raw.notified && typeof raw.notified === 'object' && !Array.isArray(raw.notified)) {
    for (const [key, stamp] of Object.entries(raw.notified)) {
      if (/^\d{4}-\d{2}-\d{2}\|[a-zA-Z0-9_-]{1,80}\|\d{2}:\d{2}$/.test(key) && typeof stamp === 'number' && Number.isFinite(stamp)) state.notified[key] = stamp;
    }
  }
  return state;
}
export function scheduleAt(plan: Plan, date: string): Schedule | undefined {
  return [...plan.versions].reverse().find(v => v.effective <= date);
}
export function slotsFor(state: MedicationState, date: string): Slot[] {
  const records = new Map(state.records.filter(r => r.date === date).map(r => [r.id, r]));
  return state.plans.flatMap(plan => {
    const version = scheduleAt(plan, date);
    if (!version?.active) return [];
    return version.times.map(time => ({ id: slotId(date, plan.id, time), date, planId: plan.id, time, name: version.name, dose: version.dose, note: version.note, record: records.get(slotId(date, plan.id, time)) }));
  }).sort((a, b) => a.time.localeCompare(b.time) || a.name.localeCompare(b.name));
}
export function nextSlot(state: MedicationState, now = new Date()): (Slot & { target: Date }) | null {
  let next: (Slot & { target: Date }) | null = null;
  for (let offset = 0; offset <= 31; offset++) {
    for (const slot of slotsFor(state, shiftDay(dayKey(now), offset))) {
      const target = new Date(`${slot.date}T${slot.time}:00`);
      if (!slot.record && target > now && (!next || target < next.target)) next = { ...slot, target };
    }
    if (next) break;
  }
  return next;
}
export function dueSlots(state: MedicationState, now = new Date()): Slot[] {
  return slotsFor(state, dayKey(now)).filter(slot => {
    const lag = now.getTime() - new Date(`${slot.date}T${slot.time}:00`).getTime();
    return !slot.record && lag >= 0 && lag <= 10 * 60000 && !state.notified[slot.id];
  });
}
export function upsertRecord(state: MedicationState, record: DoseRecord): void {
  const index = state.records.findIndex(r => r.id === record.id);
  if (index < 0) state.records.push(record); else state.records[index] = record;
}
function escapeICS(s: string): string { return s.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,'); }
function floating(date: string, time: string): string { return date.replace(/-/g, '') + 'T' + time.replace(':', '') + '00'; }
function stamp(d: Date): string { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  let part = '', bytes = 0;
  const lines: string[] = [];
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (bytes + size > 75) { lines.push(part); part = ' '; bytes = 1; }
    part += char;
    bytes += size;
  }
  lines.push(part);
  return lines.join('\r\n');
}
export function makeCalendar(state: MedicationState, url: string, disclose = false, now = new Date()): string {
  const groups = new Map<string, Slot[]>();
  for (let offset = 0; offset < 30; offset++) {
    const date = shiftDay(dayKey(now), offset);
    for (const slot of slotsFor(state, date)) {
      if (new Date(`${date}T${slot.time}:00`) <= now) continue;
      const version = scheduleAt(state.plans.find(p => p.id === slot.planId)!, date)!;
      const key = `${slot.planId}|${version.effective}|${slot.time}`;
      const list = groups.get(key) || [];
      list.push(slot);
      groups.set(key, list);
    }
  }
  if (!groups.size) throw new Error('未来 30 天没有计划，请先添加计划');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Warm Island//Medication Calendar//ZH', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:小暖岛用药核对提醒'];
  for (const list of groups.values()) {
    const first = list[0];
    const title = disclose ? `小暖岛 · ${first.name}` : '小暖岛 · 核对用药计划';
    const description = disclose ? `${first.name} ${first.dose}\n${first.note}\n按医生交代服用；请先核对是否已服用，勿重复服药。\n${url}` : `请打开小暖岛核对用药记录。不确定时请咨询医生或药师，勿重复服药。\n${url}`;
    lines.push('BEGIN:VEVENT', `UID:${first.planId}-${first.date}-${first.time.replace(':', '')}@warm-island.local`, `DTSTAMP:${stamp(now)}`, `DTSTART:${floating(first.date, first.time)}`, 'DURATION:PT5M', `RRULE:FREQ=DAILY;COUNT=${list.length}`, `SUMMARY:${escapeICS(title)}`, `DESCRIPTION:${escapeICS(description)}`, 'BEGIN:VALARM', 'TRIGGER:PT0M', 'ACTION:DISPLAY', `DESCRIPTION:${escapeICS(title)}`, 'END:VALARM', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
export function recordsCSV(records: DoseRecord[]): string {
  const cell = (value: string): string => '"' + (/^[=+\-@\t\r]/.test(value) ? "'" + value : value).replace(/"/g, '""') + '"';
  const rows = [['计划日期', '计划时间', '药名', '剂量（自行记录）', '状态', '实际服药时间', '补记时间', '备注'], ...records.map(r => [r.date, r.time, r.name, r.dose, r.status === 'taken' ? '已服用' : '未服用', r.actual ? new Date(r.actual).toLocaleString('zh-CN', { hour12: false }) : '', new Date(r.recordedAt).toLocaleString('zh-CN', { hour12: false }), r.note])];
  return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n');
}
