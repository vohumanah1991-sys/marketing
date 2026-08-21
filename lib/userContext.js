/**
 * کاربرِ درخواست جاری — یک لایه، تا مسیرهای روی دیسک از همان اول جدا باشند.
 *
 * چرا AsyncLocalStorage و نه یک متغیر محیطی: متغیر محیطی سراسری پروسه است و
 * وقتی پنج تستر هم‌زمان درخواست می‌دهند، درخواست دوم مسیر درخواست اول را
 * عوض می‌کند. این اشکال بی‌سروصداست — داده‌ی یک نفر در پوشه‌ی دیگری می‌نشیند
 * و هیچ خطایی هم نمی‌دهد.
 *
 * الان احراز هویتی در کار نیست و همه «default» می‌شوند. مهم این است که
 * *شکل* مسیرها از حالا درست باشد: `.vohu/<user>/…`. وقتی این مغز روی
 * spark-saas سوار شود، فقط جایی که runAsUser صدا زده می‌شود عوض می‌شود
 * (میدل‌ور تنانت به‌جای مقدار پیش‌فرض) — نه هیچ‌کدام از خواننده‌ها.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

export const DEFAULT_USER = 'default';

/** همه‌ی کارهای داخل fn به این کاربر نسبت داده می‌شوند. */
export function runAsUser(user, fn) {
  return storage.run({ user: safeUser(user) }, fn);
}

/** کاربر جاری، یا «default» اگر بیرون از هر context باشیم (CLI و تست‌ها). */
export function currentUser() {
  return storage.getStore()?.user || DEFAULT_USER;
}

/**
 * نام کاربر به یک تکه‌ی امنِ مسیر تبدیل می‌شود.
 *
 * ورودی می‌تواند ایمیل یا شناسه‌ی عددی باشد. هرچه اسلش یا نقطه‌نقطه باشد
 * باید برود، وگرنه یک کاربر می‌تواند با نامی مثل «../other» به پوشه‌ی
 * کاربر دیگری برسد. خالی‌شدن کامل هم به default برمی‌گردد، نه به رشته‌ی
 * خالی که یعنی «همان ریشه».
 */
export function safeUser(user) {
  const s = String(user ?? '').trim().toLowerCase()
    .replace(/[^a-z0-9._@-]+/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  return s || DEFAULT_USER;
}
