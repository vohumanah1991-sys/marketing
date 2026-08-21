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

// هیچ fs مستقیمی اینجا نیست: انبار پشت readDoc/writeDoc/listDocs است تا
// همین فایل عیناً روی هر انباری (فایل یا SQLite) کار کند.
import { readDoc, writeDoc, listDocs } from './store.js';

const queue    = [];
const handlers = new Map();
let running    = false;

export function registerHandler(type, fn) { handlers.set(type, fn); }

async function persist(job) {
  const { _resolve, ...clean } = job;
  await writeDoc('job', job.id, clean);
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
  return readDoc('job', id);
}

export async function listJobs({ limit = 20 } = {}) {
  // سندِ خراب را خود listDocs رد می‌کند — یکی نباید کل فهرست را بیندازد
  const all = (await listDocs('job')).filter(x => x && x.createdAt);
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
  let n = 0;
  for (const j of await listDocs('job')) {
    if (j.status === 'running' || j.status === 'queued') {
      j.status = 'interrupted';
      j.error  = 'سرور وسط کار ری‌استارت شد';
      j.finishedAt = new Date().toISOString();
      await writeDoc('job', j.id, j);
      n++;
    }
  }
  return n;
}
