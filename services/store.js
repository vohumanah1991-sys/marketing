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

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * انبار کجاست — تنها جایی که این تصمیم گرفته می‌شود.
 *
 * حالت خشک انبار جدا دارد. دلیلش فقط مرتب‌بودن نیست: داده‌ی ساختگی اگر در
 * تاریخچه‌ی واقعی بنشیند، دفعه‌ی بعد **دوباره استفاده می‌شود** و جای استخراج
 * واقعی را می‌گیرد. یعنی تحلیل روی پستی می‌نشیند که هرگز وجود نداشته.
 *
 * VOHU_STORE_DIR صریح، همیشه برنده است — تست‌ها به آن تکیه دارند.
 * تابع است نه ثابت، تا اگر متغیر محیطی بعد از import عوض شد هم درست بماند.
 */
export function storeDir() {
  if (process.env.VOHU_STORE_DIR) return process.env.VOHU_STORE_DIR;
  return process.env.VOHU_DRY_RUN ? '.vohu-dry' : '.vohu';
}

/**
 * نوشتن اتمی: اول در فایل کناری، بعد rename.
 *
 * writeFile اتمی نیست. هر کسی که همان لحظه بخواند می‌تواند فایل نیمه‌نوشته
 * ببیند و JSON.parse بترکد — این واقعاً دیده شد، در listJobs. برای تاریخچه‌ی
 * استخراج بدتر است: فایل خراب یعنی باید دوباره به Apify پول داد.
 * rename در همان فایل‌سیستم اتمی است.
 */
export async function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, file);
}

function slug(url) {
  return String(url).replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').slice(0, 60);
}

export async function loadRun(url) {
  const file = path.join(storeDir(), `${slug(url)}.json`);
  const run = existsSync(file)
    ? JSON.parse(await readFile(file, 'utf8'))
    : { url, stages: {}, createdAt: new Date().toISOString() };

  // شکل حداقلی همیشه تضمین شود.
  // بدون این، اجرای تازه input نداشت و اولین نوشتن روی run.input منفجر می‌شد —
  // و چون داخل try سرور بود، فقط یک پیام مبهم به کاربر می‌رسید.
  run.url    = run.url || url;
  run.stages = run.stages || {};
  run.input  = run.input  || {};
  return run;
}

export async function saveRun(run) {
  const DIR = storeDir();
  if (!existsSync(DIR)) await mkdir(DIR, { recursive: true });
  run.updatedAt = new Date().toISOString();
  await writeJsonAtomic(path.join(DIR, `${slug(run.url)}.json`), run);
  return run;
}
