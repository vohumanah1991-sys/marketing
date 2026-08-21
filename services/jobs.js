/**
 * صف کار پس‌زمینه.
 *
 * چرا لازم است: استخراج یک پیج ۵۰تایی با دانلود ویدئو و OCR می‌تواند
 * ده‌ها دقیقه طول بکشد. اگر داخل درخواست HTTP انجام شود، مرورگر و پراکسی
 * هر دو قطع می‌کنند. پس درخواست فقط کار را ثبت می‌کند و شناسه می‌دهد.
 *
 * ساده و بدون وابستگی: یک صف در حافظه + ذخیره‌ی وضعیت روی دیسک.
 * وقتی به پستگرس/Redis رسیدی فقط همین فایل عوض می‌شود.
 *
 * محدودیت صریح: اگر پروسه وسط کار ری‌استارت شود، کارِ در جریان
 * «interrupted» علامت می‌خورد — نه اینکه وانمود شود تمام شده.
 */

import { mkdir, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { userDir, writeJsonAtomic } from './store.js';

const DIR = () => path.join(userDir(), 'jobs');

const queue    = [];
const handlers = new Map();
let running    = false;

export function registerHandler(type, fn) { handlers.set(type, fn); }

async function persist(job) {
  if (!existsSync(DIR())) await mkdir(DIR(), { recursive: true });
  const { _resolve, ...clean } = job;
  await writeJsonAtomic(path.join(DIR(), `${job.id}.json`), clean);
}

export async function createJob(type, payload = {}) {
  const job = {
    id: 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type, payload,
    status: 'queued',
    progress: { done: 0, total: null, note: 'در صف' },
    result: null, error: null,
    createdAt: new Date().toISOString(), startedAt: null, finishedAt: null
  };
  await persist(job);
  queue.push(job);
  tick();
  return job;
}

export async function getJob(id) {
  const live = queue.find(j => j.id === id);
  if (live) return live;
  const f = path.join(DIR(), `${id}.json`);
  if (!existsSync(f)) return null;
  return JSON.parse(await readFile(f, 'utf8'));
}

export async function listJobs({ limit = 20 } = {}) {
  if (!existsSync(DIR())) return [];
  const files = (await readdir(DIR())).filter(f => f.endsWith('.json'));
  // یک فایل خراب نباید کل فهرست را بیندازد — رد می‌شود، نه اینکه ۵۰۰ بدهد
  const all = (await Promise.all(files.map(async f => {
    try { return JSON.parse(await readFile(path.join(DIR(), f), 'utf8')); }
    catch { return null; }
  }))).filter(x => x && x.createdAt);
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)
            .map(({ result, ...rest }) => ({ ...rest, hasResult: Boolean(result) }));
}

async function tick() {
  if (running) return;
  const job = queue.find(j => j.status === 'queued');
  if (!job) return;

  running = true;
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  await persist(job);

  const report = async (patch) => {
    Object.assign(job.progress, patch);
    await persist(job);
  };

  try {
    const fn = handlers.get(job.type);
    if (!fn) throw new Error(`کار ناشناخته: ${job.type}`);
    job.result = await fn(job.payload, report);
    job.status = 'done';
  } catch (e) {
    job.status = 'failed';
    job.error  = e.message;
  } finally {
    job.finishedAt = new Date().toISOString();
    await persist(job);
    const i = queue.indexOf(job);
    if (i >= 0) queue.splice(i, 1);
    running = false;
    setImmediate(tick);
  }
}

/** موقع بالا آمدن: کارهایی که وسط کار قطع شده‌اند را صادقانه علامت بزن. */
export async function markInterrupted() {
  if (!existsSync(DIR())) return 0;
  let n = 0;
  for (const f of (await readdir(DIR())).filter(x => x.endsWith('.json'))) {
    const p = path.join(DIR(), f);
    const j = JSON.parse(await readFile(p, 'utf8'));
    if (j.status === 'running' || j.status === 'queued') {
      j.status = 'interrupted';
      j.error  = 'سرور وسط کار ری‌استارت شد';
      j.finishedAt = new Date().toISOString();
      await writeJsonAtomic(p, j);
      n++;
    }
  }
  return n;
}
