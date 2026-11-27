import http from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, readFile, rename, rm, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { openStore, RequestError } from './db.mjs';
import { assetTypes, checkMedia, platforms, uploadLimits } from './platforms.mjs';

const publicDir = fileURLToPath(new URL('../web/', import.meta.url));
const webFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);
const idPattern = '[a-f0-9-]{36}';
const jobPath = new RegExp('^/api/jobs/(' + idPattern + ')(?:/(state|assets)(?:/(' + idPattern + '))?)?$');
const mediaPath = new RegExp('^/(?:api|extension)/media/(' + idPattern + ')$');
const extStatePath = new RegExp('^/extension/jobs/(' + idPattern + ')/state$');

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function parseJSON(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw new RequestError(415, '请求需使用 JSON');
  }
  const buffers = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 128 * 1024) {
      req.resume();
      throw new RequestError(413, '请求内容过大');
    }
    buffers.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(buffers).toString('utf8')); }
  catch { throw new RequestError(400, 'JSON 内容无效'); }
}

function sameToken(actual, expected) {
  return typeof actual === 'string' && /^Bearer [a-f0-9]{48}$/.test(actual) &&
    timingSafeEqual(Buffer.from(actual.slice(7)), Buffer.from(expected));
}

async function saveUpload(store, jobId, url, req) {
  const job = store.required(jobId);
  if (job.status !== 'draft') throw new RequestError(409, '请先退回草稿再上传素材');
  const name = (url.searchParams.get('name') ?? '').normalize('NFC');
  const role = url.searchParams.get('role');
  if (!name || name.length > 170 || /[\\/:"<>|?*\x00-\x1f\x7f]/.test(name) || /[. ]$/.test(name)) {
    throw new RequestError(400, '素材文件名含不支持的字符');
  }
  const mime = assetTypes[extname(name).toLowerCase()];
  if (!mime || (role === 'video' ? !mime.startsWith('video/') : !mime.startsWith('image/'))) {
    throw new RequestError(415, '请上传 JPG、PNG、WebP 图片或 MP4、MOV、WebM 视频');
  }
  if ((job.kind === 'images' && role !== 'image') || (job.kind === 'video' && !['video', 'cover'].includes(role))) {
    throw new RequestError(400, '素材角色与任务类型不符');
  }
  const limit = role === 'video' ? uploadLimits.video : uploadLimits.image;
  const declared = Number(req.headers['content-length']);
  if (declared > limit) throw new RequestError(413, '素材大小超过工作台限制');
  if (!Number.isSafeInteger(declared) || declared <= 0) throw new RequestError(411, '请使用带文件大小的上传请求');
  const id = randomUUID();
  const file = join(store.mediaDir, id);
  const temp = file + '.part';
  let bytes = 0;
  try {
    const measure = new Transform({
      transform(chunk, _, cb) {
        bytes += chunk.length;
        cb(bytes > limit ? new RequestError(413, '素材大小超过工作台限制') : null, chunk);
      },
    });
    await pipeline(req, measure, createWriteStream(temp, { flags: 'wx' }));
    const handle = await open(temp, 'r');
    try {
      const buffer = Buffer.alloc(16);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (!checkMedia(buffer.subarray(0, bytesRead), mime)) throw new RequestError(415, '素材文件内容与扩展名不符');
    } finally { await handle.close(); }
    await rename(temp, file);
    return store.addAsset(jobId, { id, mime, name, role, bytes });
  } catch (error) {
    await Promise.allSettled([rm(temp, { force: true }), rm(file, { force: true })]);
    throw error;
  }
}

async function sendMedia(store, assetId, req, res) {
  const asset = store.asset(assetId);
  if (!asset) throw new RequestError(404, '素材不存在');
  const file = join(store.mediaDir, assetId);
  const size = (await stat(file).catch(() => null))?.size;
  if (!size) throw new RequestError(404, '本地素材文件缺失');
  const encoded = encodeURIComponent(asset.name).replace(/['()]/g, value => '%' + value.charCodeAt(0).toString(16));
  res.writeHead(200, {
    'Content-Type': asset.mime, 'Content-Length': size,
    'Content-Disposition': 'attachment; filename*=UTF-8\'\'' + encoded,
  });
  await pipeline(createReadStream(file), res);
}

export function createStudio({ directory }) {
  const store = openStore(directory);
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");

    try {
      const authority = '127.0.0.1:' + server.address().port;
      if (req.headers.host !== authority || !req.url?.startsWith('/') || req.url.startsWith('//')) {
        throw new RequestError(403, '请使用工作台提供的本地地址');
      }
      const origin = 'http://' + authority;
      const url = new URL(req.url, origin);
      const { pathname: route } = url;
      const method = req.method;
      const extension = route.startsWith('/extension/');
      if (extension) {
        if (!sameToken(req.headers.authorization, store.pairing())) throw new RequestError(401, '请重新复制并连接工作台配对码');
      } else {
        if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) {
          throw new RequestError(403, '此操作只允许在本地工作台进行');
        }
        if (req.headers.origin && req.headers.origin !== origin) throw new RequestError(403, '来源不符');
        if (method !== 'GET' && req.headers['x-doki-local'] !== '1') throw new RequestError(403, '缺少工作台请求标识');
      }

      if (method === 'GET' && webFiles.has(route)) {
        const [file, mime] = webFiles.get(route);
        const body = await readFile(join(publicDir, file));
        res.writeHead(200, { 'Content-Type': mime }).end(body);
        return;
      }
      if (method === 'GET' && route === '/api/config') return json(res, 200, { platforms, uploadLimits });
      if (method === 'GET' && route === '/api/pairing') return json(res, 200, { token: store.pairing() });
      if (method === 'POST' && route === '/api/pairing') return json(res, 200, { token: store.rotatePairing() });
      if (method === 'GET' && route === '/extension/jobs') {
        const jobs = store.list().filter(job => ['queued', 'handed_off'].includes(job.status));
        return json(res, 200, { platforms, jobs });
      }
      if (method === 'GET' && route === '/api/jobs') return json(res, 200, store.list());
      if (method === 'POST' && route === '/api/jobs') return json(res, 201, store.create(await parseJSON(req)));
      const media = route.match(mediaPath);
      if (method === 'GET' && media) { await sendMedia(store, media[1], req, res); return; }
      const extState = route.match(extStatePath);
      if (method === 'POST' && extState) {
        const input = await parseJSON(req);
        if (!['handoff', 'publish'].includes(input?.action)) throw new RequestError(400, '插件只能确认交接或记录已发布');
        return json(res, 200, store.transition(extState[1], input));
      }
      const job = route.match(jobPath);
      if (job) {
        const [, id, section, assetId] = job;
        if (!section && method === 'GET') return json(res, 200, store.required(id));
        if (!section && method === 'PUT') return json(res, 200, store.edit(id, await parseJSON(req)));
        if (section === 'state' && !assetId && method === 'POST') return json(res, 200, store.transition(id, await parseJSON(req)));
        if (section === 'assets' && !assetId && method === 'POST') return json(res, 201, await saveUpload(store, id, url, req));
        if (section === 'assets' && assetId && method === 'DELETE') {
          const updated = store.removeAsset(id, assetId);
          await rm(join(store.mediaDir, assetId), { force: true }).catch(error => console.error(error.message));
          return json(res, 200, updated);
        }
      }
      throw new RequestError(404, '未找到此页面或操作');
    } catch (error) {
      if (res.destroyed || res.headersSent) { res.destroy(); return; }
      if (!req.readableEnded) req.resume();
      if (error instanceof RequestError) return json(res, error.status, { error: error.message });
      console.error(error);
      json(res, 500, { error: '本地操作失败，请检查启动终端' });
    }
  });
  server.requestTimeout = 60 * 60 * 1000;
  server.on('close', () => store.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.DOKI_PORT || 8794);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('DOKI_PORT 必须在 1024 到 65535 之间');
  const directory = resolve(process.env.DOKI_DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url)));
  const server = createStudio({ directory });
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? 'Doki 端口已占用，请检查已有实例或设置 DOKI_PORT。' : error.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => console.log('Doki 工作台 http://127.0.0.1:' + port));
}
