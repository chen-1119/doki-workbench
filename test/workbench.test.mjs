import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { createStudio } from '../src/server.mjs';
import { createClient } from '../src/cli.mjs';
import { fillEditor } from '../extension/fill.js';
import { compareSchedule, isPastSchedule, shiftDay, weekSchedule } from '../web/schedule.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+GpQAAAAASUVORK5CYII=', 'base64');
const mp4Prefix = Buffer.from('000000186674797069736f6d00000001', 'hex');
const inMemory = process.env.DOKI_TEST_IN_MEMORY === '1';

test('排期按本地星期一至星期日分组，同日按时间排序', () => {
  const sunday = new Date(2026, 10, 29, 23, 45);
  const monday = shiftDay(sunday, -6);
  const early = new Date(2026, 10, 23, 0, 15);
  const later = new Date(2026, 10, 23, 20, 0);
  const outside = new Date(2026, 10, 30, 0, 15);
  const job = (id, scheduled) => ({ id, scheduledAt: scheduled?.toISOString(), createdAt: early.toISOString() });
  const entries = [job('late', later), job('none'), job('next', outside), job('first', early), job('last', sunday)];
  const days = weekSchedule(sunday, entries);
  assert.equal(days.length, 7);
  assert.equal(+days[0].day, +monday);
  assert.deepEqual(days[0].jobs.map(item => item.id), ['first', 'late']);
  assert.deepEqual(days[6].jobs.map(item => item.id), ['last']);
  assert.equal(days.flatMap(day => day.jobs).length, 3);
  assert.equal(weekSchedule(outside, entries)[0].jobs[0].id, 'next');
  assert.deepEqual(entries.sort(compareSchedule).map(item => item.id), ['first', 'late', 'last', 'next', 'none']);
});

test('已过排期只提示待交接和待回填的超时任务', () => {
  const now = new Date('2026-11-27T12:00:00.000Z');
  const past = '2026-11-27T11:59:59.000Z';
  for (const state of ['queued', 'handed_off']) {
    assert.equal(isPastSchedule({ status: state, scheduledAt: past }, now), true);
    assert.equal(isPastSchedule({ status: state, scheduledAt: null }, now), false);
    assert.equal(isPastSchedule({ status: state, scheduledAt: now.toISOString() }, now), false);
  }
  for (const state of ['draft', 'published']) {
    assert.equal(isPastSchedule({ status: state, scheduledAt: past }, now), false);
  }
});

async function simulatedRequest(server, url, options = {}) {
  const parts = new URL(url);
  const body = options.body instanceof Blob ? Buffer.from(await options.body.arrayBuffer()) :
    options.body ? Buffer.from(options.body) : null;
  const request = Readable.from(body ? [body] : []);
  const headers = new Headers(options.headers);
  headers.set('host', parts.host);
  if (body) headers.set('content-length', String(body.length));
  Object.assign(request, {
    url: parts.pathname + parts.search,
    method: options.method ?? 'GET',
    headers: Object.fromEntries(headers),
  });
  const response = new PassThrough();
  const responseHeaders = new Headers();
  response.setHeader = (name, value) => responseHeaders.set(name, value);
  response.writeHead = (code, entries) => {
    response.statusCode = code;
    for (const [name, value] of Object.entries(entries)) responseHeaders.set(name, value);
    response.headersSent = true;
    return response;
  };
  const output = [];
  response.on('data', part => output.push(part));
  const ended = once(response, 'end');
  server.emit('request', request, response);
  await ended;
  return new Response(Buffer.concat(output), { status: response.statusCode, headers: responseHeaders });
}

async function start(directory) {
  const server = createStudio({ directory });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = inMemory ? (url, options) => simulatedRequest(server, url, options) : fetch;
  return { server, base, request };
}

async function studio(t) {
  const directory = await mkdtemp(join(tmpdir(), 'doki-test-'));
  const instance = await start(directory);
  t.after(async () => {
    if (instance.server.listening) await new Promise(resolve => instance.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  async function api(path, data, method = data ? 'POST' : 'GET', headers = { 'X-Doki-Local': '1' }) {
    const body = data && !Buffer.isBuffer(data) ? JSON.stringify(data) : data;
    const r = await instance.request(instance.base + path, {
      method, headers: data && typeof body === 'string' ? { ...headers, 'Content-Type': 'application/json' } : headers, body,
    });
    return { code: r.status, data: await r.json() };
  }
  const create = fields => api('/api/jobs', { title: '测试草稿', platform: 'xhs', kind: 'images', ...fields });
  const upload = (id, role, name, file) => api('/api/jobs/' + id + '/assets?' + new URLSearchParams({ role, name }), file);
  const transition = (id, action, url) => api('/api/jobs/' + id + '/state', { action, url });
  return { ...instance, directory, api, create, upload, transition };
}

test('图文从素材顺序到插件交接、作品链接回填', async t => {
  const app = await studio(t);
  const { code, data: draft } = await app.create({ tags: '#实测 实测 订阅', scheduledAt: '2026-12-01T20:00:00+08:00' });
  assert.equal(code, 201);
  assert.equal(draft.tags, '实测 订阅');
  assert.equal(draft.scheduledAt, '2026-12-01T12:00:00.000Z');
  assert.equal((await app.transition(draft.id, 'queue')).code, 400);
  const first = await app.upload(draft.id, 'image', '01-封面.png', png);
  assert.equal(first.code, 201);
  assert.equal((await app.upload(draft.id, 'image', '假图.png', Buffer.from('text'))).code, 415);
  const second = await app.upload(draft.id, 'image', '02-正文.png', png);
  assert.deepEqual(second.data.assets.map(item => item.name), ['01-封面.png', '02-正文.png']);
  assert.equal((await app.transition(draft.id, 'queue')).data.status, 'queued');
  assert.equal((await app.transition(draft.id, 'queue')).data.history.length, 4);
  assert.equal((await app.upload(draft.id, 'image', '03.png', png)).code, 409);
  assert.equal((await app.api('/extension/jobs')).code, 401);
  const { data: { token } } = await app.api('/api/pairing');
  const headers = { Authorization: 'Bearer ' + token };
  const queue = await app.api('/extension/jobs', undefined, 'GET', headers);
  assert.equal(queue.data.jobs[0].id, draft.id);
  const media = await app.request(app.base + '/extension/media/' + first.data.assets[0].id, { headers });
  assert.equal(media.headers.get('content-type'), 'image/png');
  assert.match(media.headers.get('content-disposition'), /filename\*=UTF-8/);
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), png);
  const route = '/extension/jobs/' + draft.id + '/state';
  assert.equal((await app.api(route, { action: 'handoff' }, 'POST', headers)).data.status, 'handed_off');
  assert.equal((await app.api(route, { action: 'publish', url: 'https://example.com/note' }, 'POST', headers)).code, 400);
  const published = await app.api(route, { action: 'publish', url: 'https://www.xiaohongshu.com/explore/example' }, 'POST', headers);
  assert.equal(published.data.status, 'published');
  assert.equal((await app.api('/extension/jobs', undefined, 'GET', headers)).data.jobs.length, 0);
  assert.equal((await app.transition(draft.id, 'draft')).code, 409);
  await app.api('/api/pairing', {}, 'POST');
  assert.equal((await app.api('/extension/jobs', undefined, 'GET', headers)).code, 401);
});

test('视频角色、封面替换、平台类型校验与 SQLite 重开', async t => {
  const app = await studio(t);
  assert.equal((await app.create({ platform: 'bilibili' })).code, 400);
  const { data: draft } = await app.create({ platform: 'channels', kind: 'video' });
  const cover = await app.upload(draft.id, 'cover', 'cover.png', png);
  assert.equal(cover.code, 201);
  assert.equal((await app.transition(draft.id, 'queue')).code, 400);
  assert.equal((await app.upload(draft.id, 'cover', 'duplicate.png', png)).code, 409);
  assert.equal((await app.upload(draft.id, 'image', 'bad-role.png', png)).code, 400);
  const removePath = '/api/jobs/' + draft.id + '/assets/' + cover.data.assets[0].id;
  assert.equal((await app.api(removePath, undefined, 'DELETE')).data.assets.length, 0);
  assert.equal((await app.upload(draft.id, 'video', 'video.mp4', mp4Prefix)).code, 201);
  assert.equal((await app.upload(draft.id, 'cover', 'new.png', png)).code, 201);
  assert.equal((await app.transition(draft.id, 'queue')).code, 200);
  await app.transition(draft.id, 'handoff');
  assert.equal((await app.transition(draft.id, 'publish')).data.status, 'published');
  await new Promise(resolve => app.server.close(resolve));
  const restarted = await start(app.directory);
  try {
    const restored = await (await restarted.request(restarted.base + '/api/jobs/' + draft.id)).json();
    assert.equal(restored.status, 'published');
    assert.deepEqual(restored.assets.map(asset => asset.role), ['video', 'cover']);
  } finally { await new Promise(resolve => restarted.server.close(resolve)); }
});

test('CLI 导入真实本地图片和恢复已有草稿', async t => {
  const app = await studio(t);
  const manifest = join(app.directory, 'note.json');
  await writeFile(join(app.directory, '01.png'), png);
  await writeFile(manifest, JSON.stringify({ title: 'CLI图文', kind: 'images', platform: 'xhs', images: ['01.png'] }));
  const client = createClient({ port: new URL(app.base).port, request: app.request });
  const draft = await client.importJob(manifest);
  assert.equal(draft.status, 'draft');
  const queued = await client.importJob(manifest, ['--resume', draft.id, '--queue']);
  assert.equal(queued.id, draft.id);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.assets.length, 1);
});

test('本机客户端边界与页面入口', async t => {
  const app = await studio(t);
  const unauthorized = await app.api('/api/pairing', undefined, 'GET', { Origin: 'https://other.example' });
  assert.equal(unauthorized.code, 403);
  assert.equal((await app.api('/api/jobs', { title: '外部请求' }, 'POST', {})).code, 403);
  for (const path of ['/', '/style.css', '/app.js', '/schedule.js']) assert.equal((await app.request(app.base + path)).status, 200);
  assert.match((await app.api('/api/config')).data.platforms.xhs.editors.images, /target=image$/);
});

test('插件回读填写结果、保留已有标题、拒绝非创作者域', async t => {
  class FakeInput {
    constructor(value) { this.value = value; this.maxLength = -1; this.isConnected = true; }
    get value() { return this.text; }
    set value(value) { this.text = value; }
    getClientRects() { return [1]; }
    closest() { return null; }
    focus() {}
    dispatchEvent() {}
  }
  class FakeTextArea extends FakeInput {
    get value() { return super.value; }
    set value(value) { super.value = value; }
  }
  const title = new FakeInput('');
  const body = new FakeTextArea('');
  const globals = {
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: FakeTextArea,
    InputEvent: Event,
    document: { querySelectorAll: selector => selector.startsWith('input') ? [title] : selector.startsWith('textarea') ? [body] : [] },
    location: new URL('https://creator.xiaohongshu.com/publish/publish'),
  };
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
  const job = { platform: 'xhs', kind: 'images', title: 'Doki示例', body: '说明\n#测试' };
  assert.deepEqual(await fillEditor(job), { title: '标题已填写', body: '正文已填写' });
  assert.equal(body.value, job.body);
  assert.equal((await fillEditor({ ...job, title: '其他标题' })).title, '标题已有内容，已保留');
  assert.equal(title.value, job.title);
  globalThis.location = new URL('https://creator.xiaohongshu.com/publish/publish?target=video');
  assert.match((await fillEditor(job)).error, /图文或视频/);
  globalThis.location = new URL('https://other.example/publish');
  assert.ok((await fillEditor(job)).error);
});
