import { fillEditor } from './fill.js';

const $ = id => document.getElementById(id);
const local = chrome.storage.local;
let connection = null, jobs = [], platforms = {}, selected = '', running = false;

function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
}
function getConnection(value) {
  const match = value.trim().match(/^(http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4})\s+([a-f0-9]{48})$/);
  if (!match || !URL.canParse(match[1])) throw new Error('请粘贴工作台提供的完整配对信息');
  return { base: match[1], token: match[2] };
}
async function api(path, body, credentials = connection) {
  if (!credentials) throw new Error('请先连接工作台');
  const headers = { Authorization: 'Bearer ' + credentials.token };
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(credentials.base + path, {
    method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
    redirect: 'error', signal: AbortSignal.timeout(8000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? '工作台未响应');
  return data;
}
const activeJob = () => jobs.find(job => job.id === selected);
const text = job => [job.body, job.tags.split(/\s+/).filter(Boolean).map(tag => '#' + tag).join(' ')].filter(Boolean).join('\n\n');
const editor = job => platforms[job.platform].editors[job.kind] ?? platforms[job.platform].editors.any;
const kind = job => job.kind === 'images' ? '图文' : '视频';
const state = job => job.status === 'queued' ? '待交接' : '待回填';

async function download(asset) {
  await chrome.downloads.download({
    url: connection.base + '/extension/media/' + asset.id,
    headers: [{ name: 'Authorization', value: 'Bearer ' + connection.token }],
    conflictAction: 'uniquify',
  });
  return '已开始下载 ' + asset.name;
}

function renderJob() {
  const job = activeJob();
  $('job').hidden = !job;
  if (!job) return;
  $('title').textContent = job.title;
  $('meta').textContent = [platforms[job.platform].label, kind(job), state(job)].join(' · ');
  $('when').textContent = job.scheduledAt ? '计划 ' + new Date(job.scheduledAt).toLocaleString('zh-CN', { hour12: false }) : '';
  $('files').replaceChildren(...job.assets.map((asset, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'asset';
    button.textContent = '下载 ' + (asset.role === 'image' ? '图 ' + (index + 1) : asset.role === 'cover' ? '封面' : '成片') + ' · ' + asset.name;
    button.addEventListener('click', () => run(() => download(asset)));
    const row = document.createElement('div');
    row.append(button);
    return row;
  }));
  $('handoff').hidden = job.status !== 'queued';
  $('result').hidden = job.status !== 'handed_off';
  $('link').value = '';
  $('link').required = !platforms[job.platform].allowManualConfirmation;
}

async function refresh(data) {
  ({ jobs, platforms } = data ?? await api('/extension/jobs'));
  jobs.sort((a, b) => (a.scheduledAt ?? a.createdAt).localeCompare(b.scheduledAt ?? b.createdAt));
  $('jobs').replaceChildren(...jobs.map(job => new Option(
    platforms[job.platform].label + ' · ' + kind(job) + ' · ' + job.title, job.id)));
  $('active').hidden = false;
  $('refresh').hidden = false;
  $('disconnect').hidden = false;
  $('connection').textContent = '已连接本机工作台';
  if (!jobs.length) {
    $('jobs').append(new Option('暂无待发布任务', ''));
    $('jobs').disabled = true;
  } else $('jobs').disabled = false;
  if (!jobs.some(job => job.id === selected)) selected = jobs[0]?.id ?? '';
  $('jobs').value = selected;
  renderJob();
}

async function run(action) {
  if (running) return;
  running = true;
  document.body.setAttribute('aria-busy', 'true');
  notice('处理中…');
  try { notice(await action() ?? '已完成'); }
  catch (error) { notice(error.message === 'Failed to fetch' ? '无法连接，请确认 Doki 工作台正在运行。' : error.message, true); }
  finally { running = false; document.body.removeAttribute('aria-busy'); }
}
async function update(action, url) {
  const job = activeJob();
  await api('/extension/jobs/' + job.id + '/state', { action, url });
  await refresh();
  return action === 'publish' ? '已回填工作台' : '已交接，发布后请回填作品链接';
}

$('connect').addEventListener('click', () => run(async () => {
  const newConnection = getConnection($('pairing').value);
  const data = await api('/extension/jobs', undefined, newConnection);
  await local.set({ connection: newConnection });
  connection = newConnection;
  $('pairing').value = '';
  $('settings').open = false;
  await refresh(data);
  return '已连接';
}));
$('disconnect').addEventListener('click', () => run(async () => {
  await local.remove(['connection', 'selected']);
  connection = null;
  $('active').hidden = $('refresh').hidden = $('disconnect').hidden = true;
  $('connection').textContent = '等待连接';
  return '已断开';
}));
$('refresh').addEventListener('click', () => run(() => refresh()));
$('jobs').addEventListener('change', () => run(async () => {
  selected = $('jobs').value;
  await local.set({ selected });
  renderJob();
  return '';
}));
$('open').addEventListener('click', () => run(async () => {
  await local.set({ selected });
  await chrome.tabs.create({ url: editor(activeJob()) });
}));
$('copy-title').addEventListener('click', () => run(async () => { await navigator.clipboard.writeText(activeJob().title); return '标题已复制'; }));
$('copy-body').addEventListener('click', () => run(async () => { await navigator.clipboard.writeText(text(activeJob())); return '正文和话题已复制'; }));
$('fill').addEventListener('click', () => run(async () => {
  const job = activeJob();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || new URL(tab.url).hostname !== new URL(editor(job)).hostname) {
    throw new Error('请在对应的创作者后台标签页打开插件后再预填');
  }
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id }, func: fillEditor,
    args: [{ platform: job.platform, kind: job.kind, title: job.title, body: text(job) }],
  });
  if (!result || result.error) throw new Error(result?.error ?? '当前页面没有返回填写结果');
  return [result.title, result.body].join(' · ');
}));
$('handoff').addEventListener('click', () => run(() => update('handoff')));
$('result').addEventListener('submit', event => {
  event.preventDefault();
  run(() => update('publish', $('link').value));
});

await local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
({ connection, selected = '' } = await local.get(['connection', 'selected']));
if (connection) {
  $('settings').open = false;
  $('disconnect').hidden = false;
  await run(async () => { await refresh(); return ''; });
  if ($('active').hidden) $('settings').open = true;
} else $('settings').open = true;
