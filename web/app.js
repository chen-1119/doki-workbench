import { compareSchedule, isPastSchedule, isPending, localDay, shiftDay, weekSchedule } from './schedule.js';

const $ = selector => document.querySelector(selector);
const editor = $('#editor');
const form = $('#edit-form');
const fields = form.elements;
const statuses = { draft: '草稿', queued: '待交接', handed_off: '待回填', published: '已发布' };
const views = { overview: '发布总览', calendar: '分发日历', pending: '发布队列', all: '全部内容', published: '发布归档' };
const types = { images: '图文', video: '视频' };
const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', hour12: false });
const dayDate = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' });
const todayDate = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' });
const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const readView = () => {
  const page = location.hash.slice(1);
  return Object.hasOwn(views, page) ? page : 'overview';
};
let platformList = {}, jobs = [], current = null, view = readView(), busy = false;
let weekOffset = 0, selectedDay = null, loaded = false, opening = false, refreshing = false, requestId = 0;

function node(tag, text, attributes = {}) {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
  return el;
}
function button(label, action, className = '') {
  const el = node('button', label, { type: 'button', class: className });
  el.addEventListener('click', action);
  return el;
}
function status(selector, message, failed = false) {
  const el = $(selector);
  el.textContent = message;
  el.classList.toggle('error', failed);
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'X-Doki-Local': '1', ...options.headers } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || '操作失败');
  return payload;
}
const write = (path, data, method = 'POST') => api(path, {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
});
const jobUrl = id => '/api/jobs/' + id;
const fmtDate = value => value ? date.format(new Date(value)) : '—';
const editorUrl = job => platformList[job.platform].editors[job.kind] ?? platformList[job.platform].editors.any;
const platformName = id => platformList[id]?.label ?? id;
const formatWeek = days => dayDate.format(days[0].day) + ' – ' + dayDate.format(days[6].day);
const totalIn = days => days.reduce((count, day) => count + day.jobs.length, 0);
const statusBadge = job => node('span', statuses[job.status], { class: 'pill ' + job.status });

function setView(next, statusName = '', updateUrl = true) {
  if (view !== next || statusName) {
    for (const id of ['search', 'platform-filter', 'kind-filter']) document.getElementById(id).value = '';
  }
  view = next;
  $('#status-filter').value = statusName;
  if (updateUrl && location.hash !== '#' + next) history.pushState(null, '', '#' + next);
  render();
}

function jobItem(job, subtitle, now) {
  const item = button('', () => openJob(job.id), 'job-item');
  const copy = node('span', null, { class: 'job-copy' });
  const late = isPastSchedule(job, now);
  copy.append(node('strong', job.title), node('small', subtitle + (late ? ' · 已过排期' : ''),
    late ? { class: 'late-note' } : {}));
  item.append(copy, statusBadge(job));
  return item;
}

function renderOverview(now) {
  const pending = jobs.filter(isPending).sort(compareSchedule);
  const overdue = pending.filter(job => isPastSchedule(job, now));
  const next = pending[0] ?? jobs.find(job => job.status === 'draft');
  const nextAction = $('#next-action');
  $('#next-title').textContent = next?.title ?? (jobs.length ? '创建新任务' : '开始第一条发布');
  $('#next-detail').textContent = next
    ? [platformName(next.platform), types[next.kind], statuses[next.status],
      next.scheduledAt ? fmtDate(next.scheduledAt) : '未排期'].join(' · ')
    : '选择图文或视频，安排发布时间，再交接给对应平台。';
  nextAction.replaceChildren(next
    ? button(next.status === 'draft' ? '继续编辑 ↗' : '打开任务 ↗', () => openJob(next.id), 'hero-button')
    : button('创建草稿 ↗', () => openJob(), 'hero-button'));

  for (const name of Object.keys(statuses)) {
    $('#stat-' + name).textContent = jobs.filter(job => job.status === name).length;
  }
  const days = weekSchedule(now, jobs);
  $('#week-total').textContent = totalIn(days);
  $('#week-range').textContent = formatWeek(days);
  const today = localDay(now);
  const focus = days.find(day => day.key === (selectedDay ?? today)) ?? days.find(day => day.key === today);
  $('#week-strip').replaceChildren(...days.map(day => {
    const item = button('', () => {
      selectedDay = day.key;
      renderOverview(new Date());
      $('#week-strip [aria-pressed="true"]')?.focus();
    }, 'week-day');
    item.setAttribute('aria-pressed', String(day.key === focus.key));
    item.setAttribute('aria-label', dayDate.format(day.day) + '，' + day.jobs.length + ' 条排期');
    if (day.key === today) item.classList.add('is-today');
    item.append(node('small', weekday.format(day.day)), node('strong', day.day.getDate()),
      node('span', day.jobs.length || '·', { class: 'day-count', 'aria-hidden': 'true' }));
    return item;
  }));
  const weekDetail = $('#week-detail');
  weekDetail.replaceChildren(node('h3', dayDate.format(focus.day) + ' · ' + focus.jobs.length + ' 条排期'));
  if (focus.jobs.length) {
    weekDetail.append(...focus.jobs.slice(0, 3).map(job =>
      jobItem(job, time.format(new Date(job.scheduledAt)) + ' · ' + platformName(job.platform), now)));
    if (focus.jobs.length > 3) weekDetail.append(button('查看当周全部排期', () => setView('calendar'), 'text-button'));
  } else weekDetail.append(node('p', focus.key === today ? '今天暂无排期。' : '这天暂无排期。', { class: 'muted' }));

  $('#attention-count').textContent = pending.length + ' 条待处理' + (overdue.length ? ' · ' + overdue.length + ' 条已过排期' : '');
  const attention = $('#attention-list');
  attention.replaceChildren(...(pending.length
    ? pending.slice(0, 4).map(job => jobItem(job,
      [platformName(job.platform), job.scheduledAt ? fmtDate(job.scheduledAt) : '未排期'].join(' · '), now))
    : [node('p', '入队后的任务会显示在这里。', { class: 'muted inset-empty' })]));

  const platformSummary = $('#platform-summary');
  platformSummary.replaceChildren(...Object.keys(platformList).map(id => {
    const all = jobs.filter(job => job.platform === id);
    const done = all.filter(job => job.status === 'published').length;
    const card = node('div', null, { class: 'platform-card' });
    const name = node('div', null, { class: 'platform-name' });
    name.append(node('span', null, { class: 'platform-dot platform-' + id, 'aria-hidden': 'true' }),
      node('strong', platformName(id)));
    const progress = node('progress', null, { max: all.length || 1, value: done, 'aria-label': platformName(id) + '已发布' });
    const details = node('div', null, { class: 'platform-details' });
    details.append(node('small', '待处理 ' + all.filter(isPending).length), node('small', '已发布 ' + done));
    card.append(name, progress, details);
    return card;
  }));
}

function renderCalendar(now) {
  const days = weekSchedule(shiftDay(now, 7 * weekOffset), jobs);
  $('#calendar-heading').textContent = formatWeek(days);
  $('#calendar-count').textContent = totalIn(days) + ' 条排期';
  $('#this-week').disabled = weekOffset === 0;
  const today = localDay(now);
  $('#calendar-days').replaceChildren(...days.map(({ day, key, jobs }) => {
    const column = node('section', null, { class: 'calendar-day' + (today === key ? ' is-today' : '') });
    const heading = node('h3');
    heading.append(node('span', weekday.format(day)), node('strong', dayDate.format(day)));
    column.append(heading);
    for (const job of jobs) {
      column.append(jobItem(job, time.format(new Date(job.scheduledAt)) + ' · ' + platformName(job.platform), now));
    }
    if (!jobs.length) column.append(node('p', '—', { class: 'calendar-empty', 'aria-label': '暂无排期' }));
    return column;
  }));
}

function render() {
  const now = new Date();
  $('#today-label').textContent = todayDate.format(now);
  $('#page-title').textContent = views[view];
  $('#overview').hidden = view !== 'overview' || !loaded;
  $('#calendar-view').hidden = view !== 'calendar' || !loaded;
  $('#list-panel').hidden = view === 'overview' || view === 'calendar' || !loaded;
  for (const tab of document.querySelectorAll('nav [data-view]')) {
    if (tab.dataset.view === view) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  if (!loaded) return;
  if (view === 'overview') renderOverview(now);
  else if (view === 'calendar') renderCalendar(now);
  else renderList(now);
}

function renderList(now) {
  const query = $('#search').value.trim().toLowerCase();
  const pf = $('#platform-filter').value;
  const kind = $('#kind-filter').value;
  const state = $('#status-filter').value;
  $('#status-field').hidden = view !== 'all';
  const filtered = jobs.filter(job => {
    if (view === 'pending' && !isPending(job)) return false;
    if (view === 'published' && job.status !== 'published') return false;
    if (view === 'all' && state && state !== job.status) return false;
    return (!pf || pf === job.platform) && (!kind || kind === job.kind) &&
      (job.title + ' ' + job.tags).toLowerCase().includes(query);
  });
  if (view === 'pending') filtered.sort(compareSchedule);
  if (view === 'published') filtered.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const list = $('#list');
  if (!filtered.length) {
    const div = node('div', null, { class: 'empty' });
    const filteredOut = query || pf || kind || (view === 'all' && state);
    const emptyMessages = { all: '还没有内容', pending: '队列里暂无任务', published: '还没有发布记录' };
    const emptyHints = {
      all: '新建图文或视频，添加素材后排入发布队列。',
      pending: '将草稿加入队列后，可在这里查看交接进度。',
      published: '确认发布后，可在这里找到作品记录。',
    };
    div.append(node('strong', filteredOut ? '没有匹配的内容' : emptyMessages[view]),
      node('p', filteredOut ? '可调整筛选条件。' : emptyHints[view]));
    list.replaceChildren(div);
    return;
  }
  const wrap = node('div', null, { class: 'table-wrap' });
  const table = node('table');
  const head = table.createTHead().insertRow();
  for (const label of ['内容', '平台', '类型', view === 'published' ? '回填时间' : '计划发布', '状态']) {
    head.append(node('th', label, { scope: 'col' }));
  }
  const rows = table.createTBody();
  for (const job of filtered) {
    const row = rows.insertRow();
    row.insertCell().append(button(job.title, () => openJob(job.id), 'title-link'));
    row.insertCell().textContent = platformName(job.platform);
    row.insertCell().textContent = types[job.kind];
    const schedule = row.insertCell();
    schedule.textContent = fmtDate(view === 'published' ? job.updatedAt : job.scheduledAt);
    if (isPastSchedule(job, now)) schedule.append(node('small', '已过排期', { class: 'late-note' }));
    row.insertCell().append(statusBadge(job));
  }
  wrap.append(table);
  list.replaceChildren(wrap);
}

async function refresh() {
  const id = ++requestId;
  if (!Object.keys(platformList).length) {
    ({ platforms: platformList } = await api('/api/config'));
    for (const [id, platform] of Object.entries(platformList)) {
      fields.platform.append(node('option', platform.label, { value: id }));
      $('#platform-filter').append(node('option', platform.label, { value: id }));
    }
  }
  const updated = await api('/api/jobs');
  if (id !== requestId) return;
  jobs = updated;
  loaded = true;
  $('#new').disabled = false;
  status('#notice', '');
  render();
}

async function requestRefresh() {
  if (refreshing) return;
  refreshing = true;
  const control = $('#refresh');
  control.disabled = true;
  control.textContent = '刷新中…';
  try { await refresh(); }
  catch (error) { status('#notice', '读取失败。' + error.message, true); }
  finally {
    refreshing = false;
    control.disabled = false;
    control.textContent = '刷新';
  }
}
function setKind(prefer = fields.kind.value) {
  const kinds = platformList[fields.platform.value]?.kinds ?? [];
  fields.kind.replaceChildren(...kinds.map(kind => node('option', types[kind], { value: kind })));
  if (kinds.includes(prefer)) fields.kind.value = prefer;
  $('#image-input').hidden = fields.kind.value !== 'images';
  $('#video-input').hidden = fields.kind.value !== 'video';
}
function toggleInputs(editable) {
  for (const el of [...form.querySelectorAll('input,select,textarea')]) el.disabled = !editable;
}
function localDate(value) {
  if (!value) return '';
  const time = new Date(value);
  return new Date(time.getTime() - time.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function refreshTitleCount() {
  const isXhs = fields.platform.value === 'xhs';
  const length = isXhs ? [...fields.title.value].length : fields.title.value.length;
  const max = isXhs ? 20 : 120;
  const output = $('#title-count');
  output.textContent = length + ' / ' + max + (isXhs ? ' · 小红书入队上限' : '');
  output.classList.toggle('error', length > max);
}

function renderJob() {
  const job = current;
  const draft = !job || job.status === 'draft';
  $('#job-state').textContent = statuses[job?.status ?? 'draft'];
  $('#edit-title').textContent = job ? '内容详情' : '新建内容';
  fields.platform.value = job?.platform ?? 'xhs';
  setKind(job?.kind ?? 'images');
  fields.title.value = job?.title ?? '';
  fields.body.value = job?.body ?? '';
  fields.tags.value = job?.tags ?? '';
  fields.scheduledAt.value = localDate(job?.scheduledAt);
  refreshTitleCount();
  toggleInputs(draft);
  const assets = $('#assets');
  assets.replaceChildren(...(job?.assets ?? []).map(it => {
    const item = node('div', null, { class: 'asset' });
    const role = { image: '正文图', cover: '封面', video: '成片' }[it.role];
    item.append(node('span', role), node('a', it.name, { href: '/api/media/' + it.id, download: it.name }),
      node('small', (it.bytes / 1024 ** 2).toFixed(2) + ' MB'));
    if (draft) item.append(button('移除', () => perform(async () => {
      current = await api(jobUrl(job.id) + '/assets/' + it.id, { method: 'DELETE' });
      renderJob();
      await refresh();
    })));
    return item;
  }));
  const actions = $('#actions');
  actions.replaceChildren();
  if (draft) {
    actions.append(node('button', '保存草稿', { type: 'submit', value: 'save' }),
      node('button', '加入发布队列', { type: 'submit', value: 'queue', class: 'primary' }));
  } else if (job.status !== 'published') {
    actions.append(button('打开创作者后台', () => window.open(editorUrl(job), '_blank', 'noopener,noreferrer')));
    actions.append(button('退回草稿', () => changeState('draft')));
    if (job.status === 'queued') actions.append(button('确认已交接', () => changeState('handoff'), 'primary'));
    else {
      const link = node('input', null, { type: 'url', placeholder: '粘贴平台作品链接', 'aria-label': '已发布作品链接' });
      actions.append(link, button('记录已发布', () => changeState('publish', link.value), 'primary'));
    }
  } else if (job.publicUrl) {
    actions.append(node('a', '打开已发布作品 ↗', { href: job.publicUrl, target: '_blank', rel: 'noopener noreferrer' }));
  } else {
    actions.append(node('span', '已人工确认发布。'));
  }
  $('#history-box').hidden = !job;
  $('#history').replaceChildren(...(job?.history ?? []).map(item => node('li', fmtDate(item.createdAt) + ' · ' + item.action)));
}

async function perform(run) {
  if (busy) return;
  busy = true;
  editor.setAttribute('aria-busy', 'true');
  status('#edit-notice', '处理中…');
  try {
    const note = await run();
    status('#edit-notice', note ?? '已保存');
  } catch (error) { status('#edit-notice', error.message, true); }
  finally { busy = false; editor.removeAttribute('aria-busy'); }
}
async function openJob(id) {
  if (!loaded || opening || editor.open) return;
  opening = true;
  try {
    current = id ? await api(jobUrl(id)) : null;
    form.reset();
    status('#edit-notice', '');
    renderJob();
    editor.showModal();
  } catch (error) { status('#notice', error.message, true); }
  finally { opening = false; }
}
function changeState(action, url) {
  return perform(async () => {
    current = await write(jobUrl(current.id) + '/state', { action, url });
    renderJob();
    await refresh();
  });
}
form.addEventListener('submit', e => {
  e.preventDefault();
  perform(async () => {
    const data = Object.fromEntries(['platform', 'kind', 'title', 'body', 'tags'].map(key => [key, fields[key].value]));
    const time = fields.scheduledAt.value;
    data.scheduledAt = time ? new Date(time).toISOString() : null;
    const uploads = data.kind === 'images'
      ? [...fields.images.files].map(file => ['image', file])
      : ['video', 'cover'].flatMap(role => fields[role].files[0] ? [[role, fields[role].files[0]]] : []);
    const url = current ? jobUrl(current.id) : '/api/jobs';
    current = await write(url, data, current ? 'PUT' : 'POST');
    const failed = [];
    for (const [index, [role, file]] of uploads.entries()) {
      status('#edit-notice', '上传 ' + (index + 1) + '/' + uploads.length + ' · ' + file.name);
      const params = new URLSearchParams({ role, name: file.name });
      try { current = await api(jobUrl(current.id) + '/assets?' + params, { method: 'POST', body: file }); }
      catch (error) { failed.push(file.name + '（' + error.message + '）'); }
    }
    for (const name of ['images', 'video', 'cover']) fields[name].value = '';
    renderJob();
    await refresh();
    if (failed.length) throw new Error('草稿已保存，请重选上传失败的素材。' + failed.join('、'));
    if (e.submitter?.value === 'queue') {
      current = await write(jobUrl(current.id) + '/state', { action: 'queue' });
      renderJob();
      await refresh();
      return '已加入发布队列。打开 Chrome 插件即可取用。';
    }
    return '草稿已保存';
  });
});
fields.platform.addEventListener('change', () => { setKind(); refreshTitleCount(); });
fields.kind.addEventListener('change', () => setKind());
fields.title.addEventListener('input', refreshTitleCount);
editor.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
for (const item of document.querySelectorAll('[data-close]')) item.addEventListener('click', () => {
  if (!busy || item.dataset.close !== 'editor') document.getElementById(item.dataset.close).close();
});
for (const item of document.querySelectorAll('button[data-view]')) item.addEventListener('click', () => setView(item.dataset.view));
for (const item of document.querySelectorAll('button[data-status]')) item.addEventListener('click', () => setView('all', item.dataset.status));
window.addEventListener('hashchange', () => setView(readView(), '', false));
for (const id of ['search', 'platform-filter', 'kind-filter', 'status-filter']) document.getElementById(id).addEventListener('input', render);
$('#previous-week').addEventListener('click', () => { weekOffset--; render(); });
$('#this-week').addEventListener('click', () => { weekOffset = 0; render(); });
$('#next-week').addEventListener('click', () => { weekOffset++; render(); });
$('#new').addEventListener('click', () => openJob());
$('#refresh').addEventListener('click', requestRefresh);
async function pairing(rotate = false) {
  const { token } = rotate ? await api('/api/pairing', { method: 'POST' }) : await api('/api/pairing');
  $('#pairing-value').value = location.origin + ' ' + token;
}
$('#pair').addEventListener('click', async () => {
  try { await pairing(); status('#pairing-notice', ''); $('#pairing').showModal(); }
  catch (error) { status('#notice', error.message, true); }
});
$('#copy-pair').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#pairing-value').value); status('#pairing-notice', '已复制'); }
  catch { $('#pairing-value').select(); status('#pairing-notice', '请手动复制已选中的配对信息。'); }
});
$('#rotate-pair').addEventListener('click', async () => {
  try { await pairing(true); status('#pairing-notice', '已生成新配对码。旧连接需要重新配对。'); }
  catch (error) { status('#pairing-notice', error.message, true); }
});
render();
await requestRefresh();
