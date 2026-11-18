import { STORE, emptyState, validateState, dayKey, shiftDay, validDay, validTime, pad, scheduleAt, slotsFor, nextSlot, dueSlots, upsertRecord, makeCalendar, recordsCSV } from './medication-core.js';
import type { MedicationState, Plan, Schedule, Slot, DoseRecord } from './medication-core.js';

declare global {
  interface Window {
    WarmIsland: { toast(title: string, body?: string, duration?: number): void; chime(): void };
    WarmMedication: { refresh(): void; renderNext(): void; renderNotificationStatus(): void; tick(now: Date): void };
  }
}
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`找不到页面区域：${id}`);
  return element as T;
};
const toast = (title: string, body = ''): void => window.WarmIsland.toast(title, body, 7000);
const uid = (): string => crypto.randomUUID ? crypto.randomUUID() : 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
let state = emptyState();
let blocked = false;
let warning = '';
let selectedDay = dayKey();
let observedDay = selectedDay;
let reminderBusy = false;
let sw: ServiceWorkerRegistration | null = null;
let editingPlan: string | null = null;
let recordingSlot: Slot | null = null;
let recordStatus: DoseRecord['status'] = 'taken';
let editingRecord = false;

function readState(): MedicationState {
  const raw = localStorage.getItem(STORE);
  return raw ? validateState(JSON.parse(raw)) : emptyState();
}
function load(): void {
  try { state = readState(); blocked = false; warning = ''; }
  catch { blocked = true; warning = '本机存储不可用或数据格式损坏。为保护原记录，已暂停写入。请先导出原始数据，或导入有效备份；无痕模式、存储已满也可能导致此问题。'; }
}
async function commit(change: (value: MedicationState) => void): Promise<boolean> {
  const perform = (): boolean => {
    try {
      if (blocked) throw new Error('本机存储不可用，请先处理页面上的存储提示');
      const value = readState();
      change(value);
      const validated = validateState(value);
      localStorage.setItem(STORE, JSON.stringify(validated));
      state = validated;
      warning = '';
      refresh();
      return true;
    } catch (error) {
      warning = error instanceof Error ? error.message : '保存失败';
      $('storageWarning').textContent = warning;
      $('storageWarning').hidden = false;
      toast('没有保存成功', warning);
      return false;
    }
  };
  if (navigator.locks) return navigator.locks.request(STORE, perform);
  return perform();
}
function node(tag: string, className = '', text = ''): HTMLElement {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}
function button(label: string, action: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', action);
  return b;
}
function download(content: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function localInput(date = new Date()): string {
  return `${dayKey(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function closeDialog(id: string): void { $<HTMLDialogElement>(id).close(); }
function showDialog(id: string): void { $<HTMLDialogElement>(id).showModal(); }

$('medWorkspace').innerHTML = `
  <div id="storageWarning" class="med-storage-warning" role="alert" hidden></div>
  <div class="med-layout">
    <article class="card med-panel">
      <h3>服药记录</h3><p>每一笔都由你确认。选择过去的日期，可补记真实情况。</p>
      <div class="med-summary" id="medWeek"></div>
      <div class="med-toolbar"><label for="medDate">查看日期</label><div class="med-tools"><button class="btn btn-quiet" id="medDateToday" type="button">今天</button><input class="med-input" id="medDate" type="date" aria-label="选择记录日期"></div></div>
      <p class="med-status" id="medDaySummary"></p><div class="dose-list" id="medRecords"></div>
      <div class="med-divider"></div>
      <div class="med-toolbar"><h3>我的每日用药计划</h3><button class="btn btn-primary" id="medAdd" type="button">添加计划</button></div>
      <p class="med-status">可设置每天 1–8 个时间。药名、剂量和时点请照医生说明填写，不会预设任何药物。修改或暂停从明天起生效，历史不变。</p>
      <div id="medPlans"></div>
    </article>
    <article class="card med-panel">
      <h3>让提醒更可靠一点</h3>
      <p class="med-note-inline"><strong>网页不能设置系统时钟闹钟。</strong>不存在通用的“设备闹钟授权”。要在锁屏后提醒，请导入手机日历，或自行在系统时钟设置闹钟。</p>
      <h4>01 · 导入手机日历</h4>
      <p>按计划生成未来 30 天的每日重复事件，附带到点提醒。需要你确认导入，并核对日历通知；不是已自动设置时钟闹钟。</p>
      <label class="med-label-check"><input id="calendarDetails" type="checkbox"><span>在日历中显示药名、剂量和备注（可能同步至日历云端；默认不包含）</span></label>
      <div class="med-tools"><button class="btn btn-primary" id="medCalendar" type="button">生成日历提醒 .ics</button><button class="btn btn-quiet" id="medCopyTimes" type="button">查看 / 复制闹钟时间</button></div>
      <p class="med-status" id="calendarStatus">尚未生成日历。导入是否成功，需要你在设备上确认。</p>
      <details class="med-disclosure"><summary>怎么导入？有什么限制？</summary><ol><li>iPhone：在 Safari 打开，下载 .ics 后用系统日历打开；若不支持，可在 Mac 日历导入并同步，或手动设时钟闹钟。</li><li>Android：用支持 .ics 的日历应用导入，或通过电脑端日历导入并同步手机；不同应用支持不同。</li><li>在日历中确认事件、提醒权限、声音和专注模式。部分应用会忽略文件中的提醒设置，请手动补上并测试。</li><li>文件覆盖未来 30 个自然日，到期要重新生成。更改或暂停计划后，先删除旧日历事件再重新导入，避免重复提醒。已服药也不会自动取消日历提醒。</li><li>按生成时设备的本地时刻写入；跨时区旅行后请重新核对。勿把日历或网页作为唯一的服药提醒。</li></ol></details>
      <div class="med-divider"></div>
      <h4>02 · 页面打开时提醒</h4>
      <p>页面运行且可见时，会在计划时点附近提示核对；已打卡的不再提醒。关闭、锁屏或系统休眠后不保证执行。</p>
      <div class="med-tools"><button class="btn btn-soft" id="medReminderToggle" type="button">开启页面内提醒</button><button class="btn btn-quiet" id="medNotification" type="button">申请通知权限</button><button class="btn btn-quiet" id="medTest" type="button">测试提醒</button></div>
      <p class="med-status" id="medNotifyStatus" role="status"></p>
      <details class="med-disclosure"><summary>安装到主屏幕</summary><p id="installStatus">iPhone：Safari → 分享 → 添加到主屏幕。Android：浏览器菜单 → 安装应用 / 添加到主屏幕。添加后支持离线打开，但不会获得系统闹钟或持续后台定时能力。</p><button class="btn btn-soft" id="medInstall" type="button" hidden>安装小暖岛</button><p>iPhone 通知可能需 iOS 16.4+ 且从主屏幕打开。拒绝授权后，请到浏览器或系统设置更改；网页不会反复弹窗。</p></details>
    </article>
  </div>
  <article class="card med-panel med-backup">
    <h3>把记录稳稳收好</h3><p>药名、服药记录、心情和小记只保存于本机的浏览器存储，不上传到 GitHub，不会跨设备自动同步。记录未加密，请勿在共用设备上填写敏感信息。清理浏览器、无痕模式或更换网站可能丢失记录，请定期备份。此处不是诊疗服务，身体不适或需要调整用药时请联系医生或药师。</p>
    <div class="med-tools"><button class="btn btn-soft" id="medExport" type="button">导出完整备份</button><button class="btn btn-quiet" id="medImport" type="button">导入备份</button><button class="btn btn-quiet" id="medCSV" type="button">导出服药记录 CSV</button><button class="btn btn-quiet" id="medClear" type="button">清除本机记录</button></div>
    <p class="med-status">备份含健康与心情信息，请妥善保管。仅生成下载，不代表文件已保存成功；请在下载目录确认。原页面旧版用药打卡只有“是否记录”，没有实际时间；可通过日期补记，旧版心情记录仍保留。</p>
    <input type="file" id="medImportFile" accept=".json,application/json" hidden>
  </article>`;
const dialogs = node('div');
dialogs.innerHTML = `
  <dialog class="med-dialog" id="medPlanDialog" aria-labelledby="medPlanTitle"><form class="dialog-inner med-form" id="medPlanForm">
    <div class="dialog-head"><h2 id="medPlanTitle">添加用药计划</h2><button type="button" class="icon-close" data-close="medPlanDialog" aria-label="关闭">×</button></div>
    <label>药名<input class="med-input" id="planName" required maxlength="60" placeholder="按医生说明填写" autocomplete="off"></label>
    <label>每次剂量（选填）<input class="med-input" id="planDose" maxlength="80" placeholder="照处方填写，不确定时先问医生或药师" autocomplete="off"></label>
    <label>每日时间<input class="med-input" id="planTimes" required maxlength="60" placeholder="例如 08:00, 20:00" inputmode="text"></label>
    <label>开始 / 生效日期<input class="med-input" id="planStart" type="date" required></label>
    <label>医嘱或提醒备注（选填）<textarea class="med-input" id="planNote" maxlength="240" placeholder="只记录已有医嘱"></textarea></label>
    <p class="dialog-note" id="planHelp">新增计划从所选日期开始；旧日期仅用来补记已有医嘱，不会追溯发出提醒。保存计划不代表设备闹钟已设置。</p>
    <p class="med-form-error" id="planError" role="alert"></p>
    <div class="dialog-actions"><button type="button" class="btn btn-quiet" data-close="medPlanDialog">取消</button><button type="submit" class="btn btn-primary">保存计划</button></div>
  </form></dialog>
  <dialog class="med-dialog" id="medRecordDialog" aria-labelledby="medRecordTitle"><form class="dialog-inner med-form" id="medRecordForm">
    <div class="dialog-head"><h2 id="medRecordTitle">确认服药记录</h2><button type="button" class="icon-close" data-close="medRecordDialog" aria-label="关闭">×</button></div>
    <p id="recordDescription" class="dialog-note"></p>
    <label id="actualLabel">实际服药时间<input class="med-input" id="recordActual" type="datetime-local" required></label>
    <label>备注（选填）<textarea class="med-input" id="recordNote" maxlength="240" placeholder="例如实际情况、已联系药师；不填也可以"></textarea></label>
    <p class="dialog-note">仅在确实服用后确认。“未服用”只是如实记录，不代表建议停药。未记录不等于未服药，不确定时请先核对，勿补服或重复服药。</p>
    <p class="med-form-error" id="recordError" role="alert"></p>
    <div class="dialog-actions"><button type="button" class="btn btn-quiet" data-close="medRecordDialog">取消</button><button type="submit" class="btn btn-primary" id="recordSubmit">确认记下</button></div>
  </form></dialog>
  <dialog class="med-dialog" id="medTimesDialog" aria-labelledby="medTimesTitle"><div class="dialog-inner"><div class="dialog-head"><h2 id="medTimesTitle">系统闹钟时间清单</h2><button type="button" class="icon-close" data-close="medTimesDialog" aria-label="关闭">×</button></div><textarea class="med-input" id="alarmText" rows="8" readonly aria-label="待手动设置的闹钟时间"></textarea><p class="dialog-note">请在设备“时钟 → 闹钟”按清单手动创建并选择每天重复。复制只复制文字，不会设置闹钟。</p><div class="dialog-actions"><button class="btn btn-primary" id="alarmCopy" type="button">复制清单</button><button type="button" class="btn btn-quiet" data-close="medTimesDialog">完成</button></div></div></dialog>`;
document.body.appendChild(dialogs);
document.querySelectorAll<HTMLElement>('[data-close]').forEach(b => b.addEventListener('click', () => closeDialog(b.dataset.close!)));
['medPlanDialog', 'medRecordDialog', 'medTimesDialog'].forEach(id => $(id).addEventListener('click', e => { if (e.target === $(id)) closeDialog(id); }));
const banner = node('div', 'med-banner');
banner.id = 'medBanner';
banner.hidden = true;
banner.innerHTML = '<p>到计划时间了，请先核对今天是否已服用。</p><a href="#medication">查看记录</a><button type="button">收起</button>';
banner.querySelector('button')!.addEventListener('click', () => { banner.hidden = true; });
$('top').prepend(banner);

function renderSlots(container: HTMLElement, date: string): void {
  container.replaceChildren();
  const slots = slotsFor(state, date);
  if (!slots.length) { container.append(node('p', 'med-empty', state.plans.length ? '这一天没有生效的用药计划。' : '还没有用药计划。先按医生说明添加，之后再记录实际服用情况。')); return; }
  for (const slot of slots) {
    const row = node('div', 'dose-item' + (slot.record?.status === 'taken' ? ' is-taken' : ''));
    const head = node('div', 'dose-heading');
    const info = node('div');
    info.append(node('h4', 'dose-name', slot.name), node('p', 'dose-detail', slot.dose || '剂量未填写，请照医生说明核对'));
    head.append(node('time', 'dose-time', slot.time), info);
    row.append(head);
    let label = new Date(`${date}T${slot.time}:00`) <= new Date() ? '已到计划时间 · 待核对' : '待记录';
    if (slot.record) {
      label = slot.record.status === 'taken' ? `已服用 · ${new Date(slot.record.actual!).toLocaleString('zh-CN', { hour12: false })}` : '已记为未服用';
      if (dayKey(new Date(slot.record.recordedAt)) !== slot.date) label += ' · 后补记录';
    }
    row.append(node('p', 'dose-detail', label));
    if (slot.record?.note || slot.note) row.append(node('p', 'dose-detail', slot.record?.note || slot.note));
    const actions = node('div', 'dose-actions');
    if (!slot.record) {
      actions.append(button('确实已服用', () => openRecord(slot, 'taken', false)), button('记录未服用', () => openRecord(slot, 'skipped', false)));
    } else {
      actions.append(button('编辑记录', () => openRecord(slot, slot.record!.status, true)), button('撤销这笔记录', () => {
        if (confirm('确定撤销这笔打卡？不会改变用药计划。仅在误记时操作，不表示再次服用。')) void commit(s => { s.records = s.records.filter(r => r.id !== slot.id); });
      }));
    }
    row.append(actions);
    container.append(row);
  }
}
function refresh(): void {
  $('storageWarning').hidden = !warning;
  $('storageWarning').textContent = warning;
  const today = dayKey();
  if (selectedDay > today) selectedDay = today;
  $<HTMLInputElement>('medDate').max = today;
  $<HTMLInputElement>('medDate').value = selectedDay;
  renderSlots($('medToday'), today);
  renderSlots($('medRecords'), selectedDay);
  const chosen = slotsFor(state, selectedDay);
  const taken = chosen.filter(s => s.record?.status === 'taken').length;
  const skipped = chosen.filter(s => s.record?.status === 'skipped').length;
  $('medDaySummary').textContent = `${selectedDay} · 计划 ${chosen.length} 次 · 已服用 ${taken} 次 · 记为未服用 ${skipped} 次 · 未记录 ${chosen.length - taken - skipped} 次`;
  let weekTaken = 0, weekUnrecorded = 0;
  for (let i = 0; i < 7; i++) {
    for (const slot of slotsFor(state, shiftDay(today, -i))) {
      if (slot.record?.status === 'taken') weekTaken++;
      if (!slot.record && new Date(`${slot.date}T${slot.time}:00`) <= new Date()) weekUnrecorded++;
    }
  }
  $('medWeek').replaceChildren(node('strong', '', `最近七天 · 已记录服用 ${weekTaken} 次`), node('small', '', `已到计划时间但未记录 ${weekUnrecorded} 次。只是记录，不推断是否漏服。`));
  const list = $('medPlans');
  list.replaceChildren();
  for (const plan of state.plans) {
    const latest = plan.versions.at(-1)!;
    const current = scheduleAt(plan, today);
    const row = node('div', 'med-plan-item');
    row.append(node('strong', '', latest.name), node('p', '', `${latest.times.join(' / ')} · ${latest.dose || '剂量未填写'} · ${latest.active ? '每天' : '提醒将暂停'}${latest.effective > today ? ` · ${latest.effective} 起生效` : ''}`));
    if (current && latest.effective > today) row.append(node('p', '', `今天仍按：${current.name} · ${current.times.join(' / ')}${current.active ? '' : '（提醒暂停）'}`));
    const tools = node('div', 'med-tools');
    tools.append(button('修改计划', () => openPlan(plan)), button(latest.active ? '暂停提醒计划' : '恢复提醒计划', () => {
      const action = latest.active ? '暂停' : '恢复';
      if (!confirm(`${action}从明天起生效，不影响历史打卡，也不代表停药或恢复用药。要继续吗？`)) return;
      void commit(s => {
        const p = s.plans.find(p => p.id === plan.id);
        if (!p) throw new Error('计划已经改变，请刷新后再操作');
        const last = p.versions.at(-1)!;
        const effective = last.effective > today ? last.effective : shiftDay(today, 1);
        p.versions = p.versions.filter(v => v.effective !== effective);
        p.versions.push({ ...last, times: [...last.times], effective, active: !last.active });
      }).then(ok => { if (ok) toast('已更新提醒计划', '如已导入日历，请删除旧事件并重新生成。实际服药安排仍以医嘱为准。'); });
    }));
    row.append(tools);
    list.append(row);
  }
  if (!state.plans.length) list.append(node('p', 'med-empty', '没有预设药物。点击“添加计划”，照医生说明填写即可。'));
  renderNext();
  renderNotificationStatus();
}
function openPlan(plan?: Plan): void {
  editingPlan = plan?.id || null;
  const latest = plan?.versions.at(-1);
  $('medPlanTitle').textContent = plan ? '修改用药计划' : '添加用药计划';
  $<HTMLInputElement>('planName').value = latest?.name || '';
  $<HTMLInputElement>('planDose').value = latest?.dose || '';
  $<HTMLInputElement>('planTimes').value = latest?.times.join(', ') || '';
  $<HTMLTextAreaElement>('planNote').value = latest?.note || '';
  const input = $<HTMLInputElement>('planStart');
  input.value = plan ? (latest!.effective > dayKey() ? latest!.effective : shiftDay(dayKey(), 1)) : dayKey();
  input.readOnly = !!plan;
  $('planHelp').textContent = plan ? '修改从显示的生效日期开始；今天与以往的用药安排、打卡均保持不变。已导入日历的提醒不会自动更新，请删除旧事件后重新生成。' : '新增计划从所选日期开始；旧日期仅用于补记已有医嘱，不会追溯提醒。保存不会自动设置设备闹钟。';
  $('planError').textContent = '';
  showDialog('medPlanDialog');
}
$('medAdd').addEventListener('click', () => openPlan());
$('medPlanForm').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $<HTMLInputElement>('planName').value.trim();
  const dose = $<HTMLInputElement>('planDose').value.trim();
  const times = $<HTMLInputElement>('planTimes').value.trim().split(/[,，\s]+/).filter(Boolean);
  const effective = $<HTMLInputElement>('planStart').value;
  if (!name || !validDay(effective) || effective < '2000-01-01' || !times.length || times.length > 8 || !times.every(validTime) || new Set(times).size !== times.length) {
    $('planError').textContent = '请填写药名、有效日期及每天 1–8 个不重复的 HH:MM 时间，用逗号分隔。';
    return;
  }
  if (editingPlan && effective <= dayKey()) { $('planError').textContent = '日期已变化，请关闭后重新编辑；修改只能从明天起生效。'; return; }
  const version: Schedule = { name, dose, times: times.sort(), effective, note: $<HTMLTextAreaElement>('planNote').value.trim(), active: true };
  const ok = await commit(s => {
    if (editingPlan) {
      const p = s.plans.find(p => p.id === editingPlan);
      if (!p) throw new Error('计划不存在');
      p.versions = p.versions.filter(v => v.effective !== effective);
      p.versions.push(version);
    } else s.plans.push({ id: uid(), versions: [version] });
  });
  if (ok) { closeDialog('medPlanDialog'); toast('计划已经保存', '请再核对药名、剂量和时点。手机日历或时钟提醒需要单独设置。'); }
});
function openRecord(slot: Slot, status: DoseRecord['status'], edit: boolean): void {
  recordingSlot = slot;
  recordStatus = status;
  editingRecord = edit;
  $('medRecordTitle').textContent = status === 'taken' ? (edit ? '编辑服药记录' : '确认确实已服用') : '如实记录未服用';
  $('recordDescription').textContent = `${slot.date} · 计划 ${slot.time}\n${slot.name} · ${slot.dose || '剂量未填写，按医嘱核对'}`;
  $('actualLabel').hidden = status !== 'taken';
  const actual = $<HTMLInputElement>('recordActual');
  actual.required = status === 'taken';
  actual.min = `${slot.date}T00:00`;
  actual.max = slot.date === dayKey() ? localInput() : `${slot.date}T23:59`;
  actual.value = slot.record?.actual ? localInput(new Date(slot.record.actual)) : slot.date === dayKey() ? localInput() : `${slot.date}T${slot.time}`;
  $<HTMLTextAreaElement>('recordNote').value = slot.record?.note || '';
  $('recordError').textContent = '';
  showDialog('medRecordDialog');
}
$('medRecordForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!recordingSlot) return;
  const slot = recordingSlot;
  const input = $<HTMLInputElement>('recordActual').value;
  const actual = new Date(input);
  if (recordStatus === 'taken' && (!Number.isFinite(actual.getTime()) || actual > new Date() || dayKey(actual) !== slot.date)) {
    $('recordError').textContent = '请填写这一天真实的服药时间，不能记录未来服药。'; return;
  }
  const note = $<HTMLTextAreaElement>('recordNote').value.trim();
  const ok = await commit(s => {
    const current = slotsFor(s, slot.date).find(item => item.id === slot.id);
    if (!current) throw new Error('当日计划已变化，请重新选择');
    if (current.record && !editingRecord) throw new Error('这一次已经记录过了，请先核对，不要重复记录或服药');
    upsertRecord(s, { id: slot.id, date: slot.date, planId: slot.planId, time: slot.time, name: current.name, dose: current.dose, status: recordStatus, actual: recordStatus === 'taken' ? actual.toISOString() : null, recordedAt: new Date().toISOString(), note });
  });
  if (ok) { closeDialog('medRecordDialog'); toast('这一笔已经记下', recordStatus === 'taken' ? '实际服药时间已保存，同一计划时点不会重复打卡。' : '只记录实际情况，不表示建议停药。'); }
});
$('medDate').addEventListener('change', () => {
  const value = $<HTMLInputElement>('medDate').value;
  if (validDay(value) && value <= dayKey()) selectedDay = value;
  refresh();
});
$('medDateToday').addEventListener('click', () => { selectedDay = dayKey(); refresh(); });
function renderNext(): void {
  const next = nextSlot(state);
  $('nextTime').textContent = next?.time || '—';
  $('nextTitle').textContent = next ? `${next.date === dayKey() ? '今天' : next.date} · ${next.name}` : '添加计划后，这里会显示下次时点';
  $('nextCount').textContent = next ? `约 ${Math.ceil((next.target.getTime() - Date.now()) / 60000)} 分钟后 · ${state.reminders ? '页面内提醒已开启' : '页面内提醒未开启'}` : '不预设药物，也不自动决定服药时点';
  $('reminderProgress').style.width = next ? `${Math.max(6, 100 - Math.min(1, (next.target.getTime() - Date.now()) / 86400000) * 100)}%` : '0%';
}
function renderNotificationStatus(): void {
  const permission = 'Notification' in window ? Notification.permission : 'unsupported';
  const label = permission === 'granted' ? '系统通知权限已允许' : permission === 'denied' ? '系统通知权限被拒绝；可在浏览器设置更改' : permission === 'unsupported' ? '当前浏览器不支持通知；iPhone 可尝试从主屏幕打开' : '尚未申请系统通知权限';
  $('medNotifyStatus').textContent = `${state.reminders ? '页面内提醒已开启' : '页面内提醒未开启'} · ${label}。${sw ? '离线资源已就绪。' : '离线资源尚未就绪。'}通知权限不代表锁屏、关页后可定时提醒。`;
  $('medReminderToggle').textContent = state.reminders ? '关闭页面内提醒' : '开启页面内提醒';
  $('medReminderToggle').setAttribute('aria-pressed', String(state.reminders));
  $('medNotification').textContent = permission === 'granted' ? '通知权限已允许' : permission === 'denied' ? '查看权限说明' : '申请通知权限';
}
async function notify(tag: string): Promise<void> {
  if (!('Notification' in window) || Notification.permission !== 'granted') throw new Error('系统通知未获授权，页面提示仍可用');
  const options: NotificationOptions = { body: '请打开小暖岛，先核对记录，再按医生说明照顾自己。', tag, icon: './icon-192.png', data: { url: './' } };
  if (sw) await sw.showNotification('小暖岛 · 核对用药计划', options);
  else new Notification('小暖岛 · 核对用药计划', options);
}
$('medReminderToggle').addEventListener('click', () => {
  void commit(s => { s.reminders = !s.reminders; }).then(ok => { if (ok) toast(state.reminders ? '页面内提醒已开启' : '页面内提醒已关闭', '关闭页面、锁屏或休眠后不保证执行。需要设备提醒时请设置日历或时钟。'); });
});
$('medNotification').addEventListener('click', async () => {
  if (!window.isSecureContext || !('Notification' in window)) { toast('此环境不能申请通知', '请用支持的浏览器打开 HTTPS 网页；iPhone 可尝试安装到主屏幕后打开。'); return; }
  if (Notification.permission === 'denied') { toast('请在设备上更改权限', '系统或浏览器设置 → 小暖岛 / 网站通知。允许后回来测试，网页无法替你更改。'); return; }
  try {
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    renderNotificationStatus();
    toast(permission === 'granted' ? '通知权限已允许' : '未允许系统通知', '只是显示通知的权限；仍需开启页面内提醒并保持页面运行，不能设置系统闹钟。');
  } catch { toast('无法申请通知', '当前浏览器或嵌入式预览可能限制通知，请在手机浏览器打开公网链接。'); }
});
$('medTest').addEventListener('click', async () => {
  banner.hidden = false;
  window.WarmIsland.chime();
  try { await notify('warm-island-test'); toast('已发送测试通知', '请在通知中心核对是否出现；声音还受浏览器及系统设置影响。'); }
  catch { toast('已显示页面内测试', '系统通知没有发送成功。可先申请权限；此测试不证明锁屏后会定时提醒。'); }
});
function tick(now: Date): void {
  if (dayKey(now) !== observedDay) {
    if (selectedDay === observedDay) selectedDay = dayKey(now);
    observedDay = dayKey(now);
    load();
    refresh();
  }
  renderNext();
  if (!state.reminders || blocked || reminderBusy || document.visibilityState !== 'visible') return;
  const due = dueSlots(state, now);
  if (!due.length) return;
  reminderBusy = true;
  let sent = false;
  void commit(s => {
    const current = dueSlots(s, now);
    if (!current.length || !s.reminders) return;
    sent = true;
    for (const slot of current) s.notified[slot.id] = now.getTime();
    for (const [key, timestamp] of Object.entries(s.notified)) if (timestamp < now.getTime() - 2 * 86400000) delete s.notified[key];
  }).then(async ok => {
    if (!ok || !sent) return;
    banner.hidden = false;
    window.WarmIsland.chime();
    try { await notify('warm-island-due'); } catch { /* 页面内提示仍可用 */ }
  }).finally(() => { reminderBusy = false; });
}
$('medCalendar').addEventListener('click', () => {
  try {
    const url = new URL('./', location.href).href;
    const content = makeCalendar(state, url, $<HTMLInputElement>('calendarDetails').checked);
    download(content, `小暖岛-30天提醒-${dayKey()}.ics`, 'text/calendar;charset=utf-8');
    $('calendarStatus').textContent = `已生成 ${dayKey()} 至 ${shiftDay(dayKey(), 29)} 的提醒文件，尚未确认设备导入。请打开日历核对事件及提醒权限。`;
    toast('日历文件已生成', '请确认下载，再导入设备日历。这不等于闹钟已设置；需要核对提醒并测试。');
  } catch (e) { toast('暂时不能生成', e instanceof Error ? e.message : '请先添加用药计划'); }
});
$('medCopyTimes').addEventListener('click', () => {
  const today = dayKey();
  const lines = state.plans.flatMap(plan => {
    const schedule = scheduleAt(plan, today);
    if (!schedule?.active) return [];
    return [`${schedule.name}：${schedule.times.join(' / ')}（每天）`];
  });
  $<HTMLTextAreaElement>('alarmText').value = lines.length ? `小暖岛 · 今日闹钟设置清单\n${lines.join('\n')}\n请核对剂量和医嘱；此清单不自动创建闹钟。` : '今天没有生效的计划。添加计划后再查看。';
  showDialog('medTimesDialog');
});
$('alarmCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($<HTMLTextAreaElement>('alarmText').value); toast('文字已复制', '请在设备时钟中手动创建闹钟；没有自动设置。'); }
  catch { $<HTMLTextAreaElement>('alarmText').select(); toast('请手动复制', '清单已选中，可长按或使用系统复制。'); }
});
$('medExport').addEventListener('click', () => {
  try {
    if (blocked) { download(localStorage.getItem(STORE) || '{}', `小暖岛-原始存储-${dayKey()}.json`, 'application/json'); return; }
    const backup = { app: 'warm-island', version: 2, exportedAt: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, medication: readState(), wellbeing: JSON.parse(localStorage.getItem('warm-island-v1') || 'null'), theme: localStorage.getItem('warm-island-theme') };
    download(JSON.stringify(backup, null, 2), `小暖岛-完整备份-${dayKey()}.json`, 'application/json;charset=utf-8');
    toast('备份文件已生成', '包含健康和心情信息，请确认下载并妥善保管，不要上传公开仓库。');
  } catch { toast('备份未生成', '无法读取本机存储，请检查浏览器权限和存储空间。'); }
});
$('medCSV').addEventListener('click', () => {
  if (!state.records.length) { toast('还没有记录', '先记录真实服药情况，再导出。'); return; }
  download(recordsCSV([...state.records].sort((a, b) => b.id.localeCompare(a.id))), `小暖岛-服药记录-${dayKey()}.csv`, 'text/csv;charset=utf-8');
  toast('CSV 已生成', '请在下载目录确认文件，内含药名和备注，请妥善保管。');
});
$('medImport').addEventListener('click', () => { $<HTMLInputElement>('medImportFile').value = ''; $<HTMLInputElement>('medImportFile').click(); });
$('medImportFile').addEventListener('change', async () => {
  const file = $<HTMLInputElement>('medImportFile').files?.[0];
  if (!file) return;
  try {
    if (file.size > 8 * 1024 * 1024) throw new Error('文件大于 8 MB，请选择小暖岛导出的备份');
    const raw = JSON.parse(await file.text());
    if (raw.app !== 'warm-island' || raw.version !== 2) throw new Error('请选择小暖岛 2.0 完整备份文件');
    const med = validateState(raw.medication);
    if (raw.wellbeing !== null && (typeof raw.wellbeing !== 'object' || Array.isArray(raw.wellbeing))) throw new Error('心情备份格式不正确');
    if (!confirm(`将导入 ${med.plans.length} 个计划、${med.records.length} 笔服药记录，并覆盖此网址上的心情记录。建议先导出当前备份。确定继续？`)) return;
    const previous = [STORE, 'warm-island-v1', 'warm-island-theme'].map(key => [key, localStorage.getItem(key)] as const);
    try {
      med.reminders = false;
      med.notified = {};
      localStorage.setItem(STORE, JSON.stringify(med));
      if (raw.wellbeing) localStorage.setItem('warm-island-v1', JSON.stringify(raw.wellbeing)); else localStorage.removeItem('warm-island-v1');
      if (['light', 'dark'].includes(raw.theme)) localStorage.setItem('warm-island-theme', raw.theme); else localStorage.removeItem('warm-island-theme');
    } catch (e) {
      for (const [key, value] of previous) { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* 尽力恢复原存储 */ } }
      throw e;
    }
    alert('备份已导入。提醒默认关闭，请核对计划和时区，再手动开启。日历事件不会自动更新。');
    location.reload();
  } catch (e) { toast('没有导入成功', e instanceof Error ? e.message : '文件格式不正确'); }
});
$('medClear').addEventListener('click', () => {
  if (!confirm('将清除此网址上的用药、心情、日常照顾和主题设置，不会清除手机日历或系统闹钟。请先导出备份。确定继续？')) return;
  if (prompt('为防误操作，请输入“清除”') !== '清除') return;
  try {
    [STORE, 'warm-island-v1', 'warm-island-theme'].forEach(key => localStorage.removeItem(key));
    location.reload();
  } catch { toast('未能清除', '当前浏览器不允许操作本机存储'); }
});

interface InstallEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }
let installEvent: InstallEvent | null = null;
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installEvent = event as InstallEvent;
  $('medInstall').hidden = false;
});
$('medInstall').addEventListener('click', async () => {
  if (!installEvent) return;
  await installEvent.prompt();
  const choice = await installEvent.userChoice;
  if (choice.outcome === 'accepted') $('installStatus').textContent = '安装请求已接受。安装不会获得系统闹钟或持续后台能力。';
  installEvent = null;
  $('medInstall').hidden = true;
});
if ('serviceWorker' in navigator && window.isSecureContext && location.protocol !== 'file:') {
  void navigator.serviceWorker.register('./service-worker.js', { scope: './' }).then(async registration => {
    sw = registration.active ? registration : await navigator.serviceWorker.ready;
    renderNotificationStatus();
  }).catch(() => { $('installStatus').textContent += ' 当前环境未能启用离线缓存，请在公网 HTTPS 地址打开。'; });
}
window.WarmMedication = { refresh, renderNext, renderNotificationStatus, tick };
window.addEventListener('storage', event => { if (event.key === STORE || event.key === null) { load(); refresh(); } });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { load(); refresh(); tick(new Date()); } });
load();
refresh();
tick(new Date());
