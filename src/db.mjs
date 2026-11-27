import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { platforms, publicLink, uploadLimits } from './platforms.mjs';

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fail = (message, status = 400) => { throw new RequestError(status, message); };
const timestamp = () => new Date().toISOString();

function cleanText(value, field, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    fail(field + '需' + (required ? '填写且' : '') + '不超过 ' + max + ' 字符');
  }
  return value.trim();
}

function draftFields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('请输入任务对象');
  const { platform, kind } = input;
  if (!Object.hasOwn(platforms, platform) || !platforms[platform].kinds.includes(kind)) fail('当前平台不支持此内容类型');
  const labels = cleanText(input.tags ?? '', '话题', 400).split(/[\s,，]+/).filter(Boolean);
  const tags = [...new Set(labels.map(tag => tag.replace(/^#+/, '')).filter(Boolean))].join(' ');
  if (input.scheduledAt && (typeof input.scheduledAt !== 'string' ||
    !/(?:Z|[+-]\d{2}:\d{2})$/.test(input.scheduledAt) || !Number.isFinite(Date.parse(input.scheduledAt)))) {
    fail('排期必须包含时区');
  }
  return {
    platform, kind, tags,
    title: cleanText(input.title, '标题', 120, true),
    body: cleanText(input.body ?? '', '正文', 10_000),
    scheduledAt: input.scheduledAt ? new Date(input.scheduledAt).toISOString() : null,
  };
}

export function openStore(directory) {
  const mediaDir = join(directory, 'media');
  mkdirSync(mediaDir, { recursive: true });
  const db = new DatabaseSync(join(directory, 'doki.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 4000;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, platform TEXT NOT NULL, kind TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL, tags TEXT NOT NULL,
      scheduledAt TEXT, status TEXT NOT NULL DEFAULT 'draft',
      publicUrl TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY, jobId TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      name TEXT NOT NULL, mime TEXT NOT NULL, role TEXT NOT NULL, bytes INTEGER NOT NULL,
      position INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY, jobId TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      action TEXT NOT NULL, createdAt TEXT NOT NULL
    );
  `);
  const setting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const set = db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const event = db.prepare('INSERT INTO events(jobId,action,createdAt) VALUES (?,?,?)');
  const find = db.prepare('SELECT * FROM jobs WHERE id=?');
  const forJob = db.prepare('SELECT * FROM assets WHERE jobId=? ORDER BY position');
  const audit = db.prepare('SELECT action,createdAt FROM events WHERE jobId=? ORDER BY id DESC');
  const safeJob = row => row ? { ...row, assets: forJob.all(row.id), history: audit.all(row.id) } : null;
  const get = id => safeJob(find.get(id));
  function required(id) {
    const job = get(id);
    if (!job) fail('任务不存在', 404);
    return job;
  }
  function atomic(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function ensureEditable(job) {
    if (job.status !== 'draft') fail('请先退回草稿再编辑或更换素材', 409);
  }
  if (!setting.get('pairing')) set.run('pairing', randomBytes(24).toString('hex'));

  return {
    mediaDir, close: () => db.close(), get, required,
    pairing: () => setting.get('pairing').value,
    rotatePairing() {
      const key = randomBytes(24).toString('hex');
      set.run('pairing', key);
      return key;
    },
    list: () => db.prepare('SELECT * FROM jobs ORDER BY createdAt DESC, rowid DESC').all().map(safeJob),
    create(input) {
      const fields = draftFields(input);
      const id = randomUUID();
      return atomic(() => {
        db.prepare('INSERT INTO jobs(id,platform,kind,title,body,tags,scheduledAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(id, fields.platform, fields.kind, fields.title, fields.body, fields.tags, fields.scheduledAt, timestamp(), timestamp());
        event.run(id, '创建草稿', timestamp());
        return required(id);
      });
    },
    edit(id, input) {
      const fields = draftFields(input);
      return atomic(() => {
        const job = required(id);
        ensureEditable(job);
        if (job.kind !== fields.kind && job.assets.length) fail('请先移除旧素材再更换类型', 409);
        db.prepare('UPDATE jobs SET platform=?,kind=?,title=?,body=?,tags=?,scheduledAt=?,updatedAt=? WHERE id=?')
          .run(fields.platform, fields.kind, fields.title, fields.body, fields.tags, fields.scheduledAt, timestamp(), id);
        event.run(id, '修改草稿', timestamp());
        return required(id);
      });
    },
    asset(id) {
      return db.prepare('SELECT * FROM assets WHERE id=?').get(id);
    },
    addAsset(id, item) {
      return atomic(() => {
        const job = required(id);
        ensureEditable(job);
        if ((job.kind === 'images' && item.role !== 'image') || (job.kind === 'video' && !['video', 'cover'].includes(item.role))) {
          fail('素材角色与任务类型不符');
        }
        if (job.assets.length >= (job.kind === 'images' ? uploadLimits.count : 2) ||
            (item.role !== 'image' && job.assets.some(asset => asset.role === item.role))) {
          fail('素材数量达到上限，请移除旧素材后重试', 409);
        }
        const position = (job.assets.at(-1)?.position ?? 0) + 1;
        db.prepare('INSERT INTO assets(id,jobId,name,mime,role,bytes,position) VALUES (?,?,?,?,?,?,?)')
          .run(item.id, id, item.name, item.mime, item.role, item.bytes, position);
        db.prepare('UPDATE jobs SET updatedAt=? WHERE id=?').run(timestamp(), id);
        event.run(id, '加入素材 ' + item.name, timestamp());
        return required(id);
      });
    },
    removeAsset(jobId, assetId) {
      return atomic(() => {
        const job = required(jobId);
        ensureEditable(job);
        if (!job.assets.some(asset => asset.id === assetId)) fail('素材不存在', 404);
        db.prepare('DELETE FROM assets WHERE id=?').run(assetId);
        db.prepare('UPDATE jobs SET updatedAt=? WHERE id=?').run(timestamp(), jobId);
        event.run(jobId, '移除素材', timestamp());
        return required(jobId);
      });
    },
    transition(id, input) {
      const actions = { queue: '加入发布队列', draft: '退回草稿', handoff: '确认已交接', publish: '记录已发布' };
      const command = input?.action;
      if (!Object.hasOwn(actions, command)) fail('不支持此状态操作');
      return atomic(() => {
        const job = required(id);
        let next, url = null;
        if (command === 'queue') {
          if (job.status === 'queued') return job;
          if (job.status !== 'draft') fail('只能将草稿加入发布队列', 409);
          if (job.kind === 'images' && !job.assets.some(asset => asset.role === 'image')) fail('图文任务至少需要一张正文图');
          if (job.kind === 'video' && !job.assets.some(asset => asset.role === 'video')) fail('视频任务需要一份成片');
          if (job.platform === 'xhs' && [...job.title].length > 20) fail('小红书标题请控制在 20 字以内');
          next = 'queued';
        } else if (command === 'draft') {
          if (job.status === 'draft') return job;
          if (job.status === 'published') fail('已发布记录不能退回', 409);
          next = 'draft';
        } else if (command === 'handoff') {
          if (job.status === 'handed_off') return job;
          if (job.status !== 'queued') fail('请先将任务加入队列', 409);
          next = 'handed_off';
        } else {
          if (job.status === 'published') return job;
          if (job.status !== 'handed_off') fail('请先确认已交接', 409);
          try { url = publicLink(job.platform, input.url); } catch (error) { fail(error.message); }
          next = 'published';
        }
        db.prepare('UPDATE jobs SET status=?,publicUrl=?,updatedAt=? WHERE id=?').run(next, url, timestamp(), id);
        event.run(id, actions[command], timestamp());
        return required(id);
      });
    },
  };
}
