/**
 * ذخیره‌سازی وضعیت اجرا.
 *
 * فعلاً فایل JSON — برای شروع کافی است و بدون دیتابیس هم کار می‌کند.
 * وقتی به پستگرس رسیدی، فقط این فایل عوض می‌شود:
 *
 *   create table vohu_runs (
 *     id          text primary key,
 *     user_id     int,
 *     url         text,
 *     state       jsonb not null,
 *     updated_at  timestamptz default now()
 *   );
 *
 * اهمیتش این است که اجرا قابل ادامه باشد: اگر وسط کار قطع شد،
 * از مرحله‌ای که تمام شده ادامه می‌دهد، نه از اول.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const DIR = process.env.VOHU_STORE_DIR || '.vohu';

function slug(url) {
  return String(url).replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').slice(0, 60);
}

export async function loadRun(url) {
  const file = path.join(DIR, `${slug(url)}.json`);
  if (!existsSync(file)) return { url, stages: {}, input: {}, createdAt: new Date().toISOString() };
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function saveRun(run) {
  if (!existsSync(DIR)) await mkdir(DIR, { recursive: true });
  run.updatedAt = new Date().toISOString();
  await writeFile(path.join(DIR, `${slug(run.url)}.json`), JSON.stringify(run, null, 2));
  return run;
}
