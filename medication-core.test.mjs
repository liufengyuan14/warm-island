import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { emptyState, validateState, slotsFor, nextSlot, dueSlots, upsertRecord, makeCalendar, foldLine, recordsCSV, validDay, shiftDay } from './medication-core.js';
const fixture = () => ({ ...emptyState(), plans: [{ id: 'test-plan', versions: [{ effective: '2026-11-18', name: '测试计划 A', dose: '按医嘱填写', times: ['08:00', '20:00'], note: '', active: true }] }] });
function record(slot, status = 'taken') {
  return { id: slot.id, date: slot.date, planId: slot.planId, time: slot.time, name: slot.name, dose: slot.dose, status, actual: status === 'taken' ? new Date(`${slot.date}T08:05:00`).toISOString() : null, recordedAt: new Date(`${slot.date}T08:06:00`).toISOString(), note: '' };
}
test('初始状态无预设药物、记录或授权', () => {
  assert.deepEqual(slotsFor(emptyState(), '2026-11-18'), []);
  assert.equal(emptyState().reminders, false);
});
test('日期验证及月底、闰日跨天', () => {
  assert.equal(validDay('2026-02-29'), false);
  assert.equal(validDay('2028-02-29'), true);
  assert.equal(shiftDay('2026-12-31', 1), '2027-01-01');
});
test('历史不会因为明天修改计划而变化', () => {
  const s = fixture();
  s.plans[0].versions.push({ ...s.plans[0].versions[0], effective: '2026-11-19', times: ['09:00'] });
  assert.deepEqual(slotsFor(s, '2026-11-18').map(s => s.time), ['08:00', '20:00']);
  assert.deepEqual(slotsFor(s, '2026-11-19').map(s => s.time), ['09:00']);
});
test('同一时点重复写入只保留一笔，跨天独立', () => {
  const s = fixture();
  const slot = slotsFor(s, '2026-11-18')[0];
  upsertRecord(s, record(slot));
  upsertRecord(s, { ...record(slot), note: '更正备注' });
  assert.equal(s.records.length, 1);
  assert.equal(s.records[0].note, '更正备注');
  assert.equal(slotsFor(s, '2026-11-19')[0].record, undefined);
  assert.equal(validateState(s).records.length, 1);
});
test('下一提醒跳过已经服用或记为未服用的时点', () => {
  const s = fixture();
  upsertRecord(s, record(slotsFor(s, '2026-11-18')[0], 'skipped'));
  assert.equal(nextSlot(s, new Date('2026-11-18T07:00:00')).time, '20:00');
});
test('只有到点附近未打卡的项目提醒；不会回补陈旧提醒', () => {
  const s = fixture();
  assert.equal(dueSlots(s, new Date('2026-11-18T07:59:00')).length, 0);
  assert.equal(dueSlots(s, new Date('2026-11-18T08:05:00')).length, 1);
  assert.equal(dueSlots(s, new Date('2026-11-18T08:11:00')).length, 0);
  const slot = slotsFor(s, '2026-11-18')[0];
  s.notified[slot.id] = Date.now();
  assert.equal(dueSlots(s, new Date('2026-11-18T08:05:00')).length, 0);
  s.notified = {};
  upsertRecord(s, record(slot));
  assert.equal(dueSlots(s, new Date('2026-11-18T08:05:00')).length, 0);
});
test('暂停提醒计划从生效日起停止，不改变过去', () => {
  const s = fixture();
  s.plans[0].versions.push({ ...s.plans[0].versions[0], effective: '2026-11-19', active: false });
  assert.equal(slotsFor(s, '2026-11-18').length, 2);
  assert.equal(slotsFor(s, '2026-11-19').length, 0);
});
test('拒绝非法备份、重复时间、重复记录和错误计划快照', () => {
  assert.throws(() => validateState({}));
  const s = fixture();
  s.plans[0].versions[0].times = ['08:00', '08:00'];
  assert.throws(() => validateState(s));
  s.plans[0].versions[0].times = ['25:00'];
  assert.throws(() => validateState(s));
  s.plans[0].versions[0].times = ['08:00'];
  const r = record(slotsFor(s, '2026-11-18')[0]);
  s.records = [r, r];
  assert.throws(() => validateState(s));
  s.records = [{ ...r, name: '不匹配的快照' }];
  assert.throws(() => validateState(s));
});
test('拒绝不同计划重复安排同一药名和时点', () => {
  const s = fixture();
  s.plans.push({ id: 'another-plan', versions: [{ ...s.plans[0].versions[0], name: '测试计划A' }] });
  assert.throws(() => validateState(s), /同一药名/);
});
test('午夜提醒使用新一天的计划，不混用昨天记录', () => {
  const s = fixture();
  s.plans[0].versions[0].times = ['00:00'];
  upsertRecord(s, record(slotsFor(s, '2026-11-18')[0]));
  assert.equal(dueSlots(s, new Date('2026-11-19T00:00:15')).length, 1);
});
test('日历包含 30 天的每日重复与提醒，默认不透露药名', () => {
  const calendar = makeCalendar(fixture(), 'https://example.com/warm-island/', false, new Date('2026-11-18T07:00:00'));
  const unfolded = calendar.replace(/\r\n /g, '');
  assert.equal((calendar.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.ok(unfolded.includes('RRULE:FREQ=DAILY;COUNT=30'));
  assert.ok(unfolded.includes('TRIGGER:PT0M'));
  assert.equal(unfolded.includes('测试计划 A'), false);
  assert.ok(unfolded.includes('https://example.com/warm-island/'));
  assert.ok(calendar.endsWith('END:VCALENDAR\r\n'));
});
test('日历随计划未来变更分段，过去时点不再导出', () => {
  const s = fixture();
  s.plans[0].versions.push({ ...s.plans[0].versions[0], effective: '2026-11-20', times: ['10:00'] });
  const calendar = makeCalendar(s, 'https://example.com/', false, new Date('2026-11-18T09:00:00'));
  assert.ok(calendar.includes('DTSTART:20261119T080000'));
  assert.ok(calendar.includes('DTSTART:20261118T200000'));
  assert.ok(calendar.includes('DTSTART:20261120T100000'));
  assert.ok(calendar.includes('RRULE:FREQ=DAILY;COUNT=28'));
});
test('日历转义用户文本，UTF-8 折行不超过 75 字节', () => {
  const s = fixture();
  s.plans[0].versions[0].note = '示例,备注;\n换行';
  const unfolded = makeCalendar(s, 'https://example.com/', true, new Date('2026-11-18T07:00:00')).replace(/\r\n /g, '');
  assert.ok(unfolded.includes('示例\\,备注\\;\\n换行'));
  const long = 'DESCRIPTION:' + '中文测试'.repeat(60);
  const folded = foldLine(long);
  for (const line of folded.split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75);
  assert.equal(folded.replace(/\r\n /g, ''), long);
});
test('CSV 处理公式注入、引号和换行', () => {
  const s = fixture();
  const r = { ...record(slotsFor(s, '2026-11-18')[0]), note: '=SUM(1,2)\n"测试"' };
  const csv = recordsCSV([r]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes("'=SUM(1,2)"));
  assert.ok(csv.includes('""测试""'));
});
test('原页面内联代码语法有效，所有固定 DOM 引用存在', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const ts = readFileSync(new URL('./src/medication.ts', import.meta.url), 'utf8');
  const source = html + ts;
  const ids = new Set([...source.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  for (const [, id] of source.matchAll(/\$(?:<[^>]+>)?\('([^']+)'\)/g)) assert.ok(ids.has(id), `缺少 DOM 节点 ${id}`);
  for (const [, attrs, body] of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) if (!attrs.includes('src=')) assert.doesNotThrow(() => new vm.Script(body));
  assert.equal(html.includes("$('openSchedule')"), false);
  assert.equal(html.includes("$('enableNotifications')"), false);
  assert.equal(html.includes('reminderInfo('), false);
});
