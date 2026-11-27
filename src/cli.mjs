import { openAsBlob } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assetTypes, checkMedia, uploadLimits } from './platforms.mjs';

export function createClient({ port = process.env.DOKI_PORT || '8794', request = fetch } = {}) {
  const origin = 'http://127.0.0.1:' + port;
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}$/.test(origin) || !URL.canParse(origin)) throw new Error('DOKI_PORT 无效');
  async function call(route, method = 'GET', data = null) {
    const headers = { 'X-Doki-Local': '1' };
    if (data && !(data instanceof Blob)) { headers['Content-Type'] = 'application/json'; data = JSON.stringify(data); }
    let response;
    try { response = await request(origin + route, { method, headers, body: data, redirect: 'error' }); }
    catch { throw new Error('无法连接 Doki，请先在另一个终端执行 npm start 并检查端口。'); }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? '操作失败');
    return result;
  }
  const state = (id, action, link) => call(url(id) + '/state', 'POST', { action, url: link });
  return { call, state, importJob: (file, options = []) => importJob(file, options, call, state) };
}
const url = id => {
  if (!/^[a-f0-9-]{36}$/.test(id ?? '')) throw new Error('任务 ID 无效');
  return '/api/jobs/' + id;
};

async function getMedia(folder, ref, role) {
  if (typeof ref !== 'string' || !ref || isAbsolute(ref)) throw new Error('素材路径必须相对清单所在目录');
  const target = await realpath(resolve(folder, ref));
  const fromFolder = relative(folder, target);
  if (!fromFolder || fromFolder === '..' || /^\.\.[\\/]/.test(fromFolder) || isAbsolute(fromFolder)) {
    throw new Error('素材必须在清单所在目录内');
  }
  const file = await stat(target);
  const type = assetTypes[extname(target).toLowerCase()];
  if (!file.isFile() || !type?.startsWith(role === 'video' ? 'video/' : 'image/')) throw new Error('不支持的素材 ' + ref);
  if (file.size <= 0 || file.size > uploadLimits[role === 'video' ? 'video' : 'image']) throw new Error('素材大小超限 ' + ref);
  const blob = await openAsBlob(target, { type });
  if (!checkMedia(Buffer.from(await blob.slice(0, 16).arrayBuffer()), type)) throw new Error('文件内容与扩展名不一致 ' + ref);
  return { name: basename(target), role, blob };
}
async function importJob(file, options, call, state) {
  if (!file) throw new Error('请提供任务清单路径');
  let queue = false, resume = null;
  for (let i = 0; i < options.length; i++) {
    if (options[i] === '--queue' && !queue) queue = true;
    else if (options[i] === '--resume' && !resume && options[i + 1]) resume = options[++i];
    else throw new Error('未知参数 ' + options[i]);
  }
  const manifest = await realpath(resolve(file));
  const raw = await readFile(manifest, 'utf8');
  const model = JSON.parse(raw.replace(/^\uFEFF/, ''));
  const fields = Object.fromEntries(['platform', 'kind', 'title', 'body', 'tags', 'scheduledAt'].map(key => [key, model[key]]));
  let assets = [];
  if (model.kind === 'images') {
    if (!Array.isArray(model.images) || model.images.length < 1 || model.images.length > uploadLimits.count || model.video || model.cover) {
      throw new Error('图文清单需有 1–18 张正文图');
    }
    assets = model.images.map(ref => [ref, 'image']);
  } else if (model.kind === 'video' && model.video && !model.images) {
    assets = [[model.video, 'video'], ...(model.cover ? [[model.cover, 'cover']] : [])];
  } else {
    throw new Error('视频清单需有 video 字段，可选 cover');
  }
  const media = await Promise.all(assets.map(([ref, role]) => getMedia(dirname(manifest), ref, role)));
  const queueKeys = media.map(item => item.role + ' ' + item.name);
  if (new Set(queueKeys).size !== queueKeys.length) throw new Error('每个素材都需要独立文件名');
  let job = resume ? await call(url(resume)) : await call('/api/jobs', 'POST', fields);
  const id = job.id;
  try {
    if (resume) {
      if (job.status !== 'draft' || job.platform !== model.platform || job.kind !== model.kind || job.title !== model.title?.trim() ||
          job.assets.some((item, index) => queueKeys[index] !== item.role + ' ' + item.name || item.bytes !== media[index].blob.size)) {
        throw new Error('任务与清单不匹配。请核对任务 ID 或先在工作台移除变更的素材。');
      }
      job = await call(url(id), 'PUT', fields);
    }
    for (const asset of media.slice(job.assets.length)) {
      const params = new URLSearchParams({ role: asset.role, name: asset.name });
      job = await call(url(id) + '/assets?' + params, 'POST', asset.blob);
    }
    return queue ? await state(id, 'queue') : job;
  } catch (error) {
    throw new Error(error.message + '\n草稿 ID ' + id + '。核对清单后可用 --resume ' + id + ' 继续。');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, value, ...options] = process.argv.slice(2);
  try {
    const client = createClient();
    let result;
    if (command === 'import') result = await client.importJob(value, options);
    else if (command === 'list') result = await client.call('/api/jobs');
    else if (command === 'status') result = await client.call(url(value));
    else if (['queue', 'draft', 'handoff', 'publish'].includes(command)) result = await client.state(value, command, options[0]);
    else {
      console.log('用法\n  npm run doki -- import <任务.json> [--queue] [--resume <ID>]\n  npm run doki -- list\n  npm run doki -- status|queue|draft|handoff <ID>\n  npm run doki -- publish <ID> <作品链接>');
      process.exitCode = command && !['--help', '-h'].includes(command) ? 1 : 0;
    }
    if (result) console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
