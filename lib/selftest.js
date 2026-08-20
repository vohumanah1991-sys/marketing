/**
 * ابزارهای خودآزمایی — همه‌شان دور یک قاعده می‌چرخند:
 *
 *   **خودآزمایی نباید خودش بشکند.**
 *
 * هر بررسی داخل try خودش است و خطایش نتیجه‌ی همان بررسی می‌شود، نه یک
 * استثنا که کل جواب را می‌برد. اگر یک بررسی بترکد و بقیه را هم با خودش
 * ببرد، کاربر یک ۵۰۰ خالی می‌بیند که نمی‌گوید بقیه سالم بودند یا نه —
 * دقیقاً همان‌جایی که خودآزمایی باید کمک کند، ساکت می‌ماند.
 *
 * باگی که این را نشان داد: یک نام تعریف‌نشده (openaiModel) داخل بررسی OpenAI.
 */
import { execFileSync } from 'node:child_process';

/** بررسی همگام. خروجی fn روی نتیجه می‌نشیند و می‌تواند ok را هم عوض کند. */
export function check(name, fn) {
  try {
    return { name, ok: true, ...fn() };
  } catch (e) {
    return { name, ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

/** بررسی ناهمگام، با مهلت — برای آن‌هایی که به بیرون زنگ می‌زنند. */
export async function timed(name, fn, ms = 20000) {
  const t0 = Date.now();
  try {
    const value = await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`بیش از ${ms / 1000}s طول کشید`)), ms))
    ]);
    return { name, ok: true, ms: Date.now() - t0, ...value };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - t0, error: String(e?.message || e).slice(0, 200) };
  }
}

/**
 * شناسه‌ی نسخه — مستقیم از خود git، نه از فایلی که باید دستی به‌روز شود.
 *
 * فایل BUILD همیشه یک کامیت عقب می‌ماند: نمی‌شود هش یک کامیت را پیش از
 * ساختنش داخلش نوشت. و شماره‌ی نسخه‌ی عقب‌مانده بدتر از نداشتن شماره است —
 * به‌جای «نمی‌دانم»، با اطمینان جواب غلط می‌دهد و دقیقاً همان چیزی را که
 * باید تشخیص بدهد (کد قدیمی در حال اجراست؟) پنهان می‌کند.
 *
 * اگر git نبود، null برمی‌گردد — «نمی‌دانم» جواب درستی است.
 */
export function buildId(cwd) {
  try {
    const git = (...a) =>
      execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const sha = git('rev-parse', '--short', 'HEAD');
    if (!sha) return null;
    // «تغییریافته» یعنی کدِ در حال اجرا با آن کامیت یکی نیست.
    //
    // فقط فایل‌های ردیابی‌شده (-uno): فایل‌های ردیابی‌نشده کدِ در حال اجرا را
    // عوض نمی‌کنند، و بدتر اینکه جوابشان به محیط بستگی دارد — git فهرست
    // ignoreهای سراسری را از $HOME می‌خواند و systemd آن را ست نمی‌کند، پس
    // همان درخت تمیز از داخل systemd «تغییریافته» دیده می‌شد.
    return sha + (git('status', '--porcelain', '-uno') ? ' · تغییریافته' : '');
  } catch { return null; }
}
