const $ = selector => document.querySelector(selector);
const editor = $('#editor');
const form = $('#edit-form');
const fields = form.elements;
const statuses = { draft: '草稿', queued: '待交接', handed_off: '待回填', published: '已发布' };
const views = { all: '全部内容', pending: '发布队列', published: '已发布' };
const types = { images: '图文', video: '视频' };
const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', hour12: false });
let platformList = {}, jobs = [], current = null, view = 'all', busy = false;

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

function render() {
  for (const name of Object.keys(statuses)) {
    $('#stat-' + name).textContent = jobs.filter(job => job.status === name).length;
  }
  $('#page-title').textContent = views[view];
  for (const tab of document.querySelectorAll('nav [data-view]')) {
    if (tab.dataset.view === view) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  const query = $('#search').value.trim().toLowerCase();
  const pf = $('#platform-filter').value;
  const kind = $('#kind-filter').value;
  const filtered = jobs.filter(job => {
    if (view === 'pending' && !['queued', 'handed_off'].includes(job.status)) return false;
    if (view === 'published' && job.status !== 'published') return false;
    return (!pf || pf === job.platform) && (!kind || kind === job.kind) &&
      (job.title + ' ' + job.tags).toLowerCase().includes(query);
  });
  if (view === 'pending') {
    filtered.sort((a, b) => (a.scheduledAt ?? a.createdAt).localeCompare(b.scheduledAt ?? b.createdAt));
  }
  const list = $('#list');
  if (!filtered.length) {
    const div = node('div', null, { class: 'empty' });
    div.append(node('strong', jobs.length ? '没有匹配的内容' : '还没有内容'),
      node('p', jobs.length ? '可调整筛选条件或切换视图。' : '新建图文或视频，添加素材后排入发布队列。'));
    list.replaceChildren(div);
    return;
  }
  const wrap = node('div', null, { class: 'table-wrap' });
  const table = node('table');
  const head = table.createTHead().insertRow();
  for (const label of ['内容', '平台', '类型', '计划发布', '状态']) head.append(node('th', label, { scope: 'col' }));
  const rows = table.createTBody();
  for (const job of filtered) {
    const row = rows.insertRow();
    row.insertCell().append(button(job.title, () => openJob(job.id), 'title-link'));
    row.insertCell().textContent = platformList[job.platform].label;
    row.insertCell().textContent = types[job.kind];
    row.insertCell().textContent = fmtDate(job.scheduledAt);
    row.insertCell().append(node('span', statuses[job.status], { class: 'pill ' + job.status }));
  }
  wrap.append(table);
  list.replaceChildren(wrap);
}

async function refresh() {
  jobs = await api('/api/jobs');
  render();
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
  try {
    current = id ? await api(jobUrl(id)) : null;
    form.reset();
    status('#edit-notice', '');
    renderJob();
    editor.showModal();
  } catch (error) { status('#notice', error.message, true); }
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
fields.platform.addEventListener('change', () => setKind());
fields.kind.addEventListener('change', () => setKind());
editor.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
for (const item of document.querySelectorAll('[data-close]')) item.addEventListener('click', () => {
  if (!busy || item.dataset.close !== 'editor') document.getElementById(item.dataset.close).close();
});
for (const item of document.querySelectorAll('nav [data-view]')) item.addEventListener('click', () => { view = item.dataset.view; render(); });
for (const id of ['search', 'platform-filter', 'kind-filter']) document.getElementById(id).addEventListener('input', render);
$('#new').addEventListener('click', () => openJob());
$('#refresh').addEventListener('click', () => refresh().catch(error => status('#notice', error.message, true)));
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
try {
  ({ platforms: platformList } = await api('/api/config'));
  for (const [id, platform] of Object.entries(platformList)) {
    fields.platform.append(node('option', platform.label, { value: id }));
    $('#platform-filter').append(node('option', platform.label, { value: id }));
  }
  await refresh();
} catch (error) { status('#notice', error.message, true); }
