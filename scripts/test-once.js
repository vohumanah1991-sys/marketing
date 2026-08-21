/**
 * تست تکرارنشدن فراخوان Apify — کاملاً خشک، بدون شبکه و بدون هزینه.
 *
 *   npm run test:once
 *
 * دو چیز را ثابت می‌کند:
 *   ۱. در یک اجرای موفق، هرچقدر advance() صدا زده شود، Apify یک بار صدا می‌خورد.
 *   ۲. در اجرایی که خواندن منابع شکست می‌خورد — همان حالتی که پول می‌سوزاند —
 *      باز هم فقط یک بار. قبلاً هر advance() یک فراخوان تازه بود.
 */

process.env.VOHU_DRY_RUN = '1';
process.env.APIFY_TOKEN  = 'apify_api_FAKE_FOR_TEST';   // فقط برای روشن‌بودن مسیر؛ دست خشک به شبکه نمی‌زند
process.env.VOHU_MODEL   = 'dry';

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (c, m) => c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`));

// انبارِ خالیِ تازه — روی هر میزبانی به شکل خودش. بدون این، تست حالتِ اجرای
// قبلی را ارث می‌برد و به‌جای اینکه چیزی را ثابت کند، چیزی را پنهان می‌کند.
const { enterFreshStore } = await import('../services/store.js');
await enterFreshStore();

const { apifyCalls, resetApifyCalls } = await import('../services/apify.js');
const { startRun, advance } = await import('../lib/session.js');

// ── ۱ · منابع خوانده می‌شوند ──────────────────────────────────
process.env.VOHU_FIXTURES = './fixtures';
resetApifyCalls();

let run = await startRun({ url: 'https://www.instagram.com/dryrun', note: 'تست' });
let r = await advance(run);
ok(apifyCalls() === 1, `اولین advance: ${apifyCalls()} فراخوان Apify (باید ۱ باشد)`);
ok(Boolean(run.stages.page), 'مرحله‌ی منابع در run.stages علامت خورد');
ok(Boolean(run.igFetch), 'نتیجه‌ی Apify روی خود اجرا ذخیره شد');

for (let i = 0; i < 4; i++) r = await advance(run);
ok(apifyCalls() === 1, `بعد از ۵ بار advance: ${apifyCalls()} فراخوان (باید هنوز ۱ باشد)`);
ok(r.needs === 'competitors', `اجرا ایستاد و گفت چه می‌خواهد: ${r.needs}`);

// ── ۲ · منابع شکست می‌خورند — همان حالتی که پول می‌سوزاند ─────
const empty = mkdtempSync(path.join(tmpdir(), 'vohu-empty-'));
mkdirSync(empty, { recursive: true });
writeFileSync(path.join(empty, 'apify-posts.json'), '[]');   // Apify چیزی برنگرداند
process.env.VOHU_FIXTURES = empty;                            // page.txt هم نیست → متن کوتاه
resetApifyCalls();

const bad = await startRun({ url: 'https://www.instagram.com/nothing' });
let last;
for (let i = 0; i < 5; i++) last = await advance(bad);
ok(apifyCalls() === 1, `شکست، ۵ بار advance: ${apifyCalls()} فراخوان (قبلاً ۵ تا بود، باید ۱ باشد)`);
ok(last.state === 'page_failed', `حالت برگشتی «${last.state}» است، نه انتظار بی‌پایان`);
ok(Boolean(bad.stages.pageError?.why?.text), 'دلیل شکست برای نمایش به کاربر آماده است');

// ── ۳ · ترمز دستی ────────────────────────────────────────────
process.env.APIFY_MAX_CALLS = '2';            // ترمز قبل از حالت خشک و قبل از شبکه چک می‌شود
const { fetchPosts } = await import('../services/apify.js');
resetApifyCalls();
await fetchPosts(['https://www.instagram.com/x'], { limit: 1, timeoutMs: 1 }).catch(() => {});
await fetchPosts(['https://www.instagram.com/x'], { limit: 1, timeoutMs: 1 }).catch(() => {});
const capped = await fetchPosts(['https://www.instagram.com/x'], { limit: 1, timeoutMs: 1 });
ok(capped.capped === true && capped.ok === false, 'بعد از سقف APIFY_MAX_CALLS دیگر شبکه‌ای زده نمی‌شود');

// ── ۴ · تاریخچه — کاری که یک بار انجام شده دوباره پول نمی‌گیرد ──
delete process.env.APIFY_MAX_CALLS;                 // ترمز بخش ۳ را بردار
const { historyFor, quickInstagram, saveState } = await import('../lib/igSync.js');

const three = [{ shortCode: 'a' }, { shortCode: 'b' }, { shortCode: 'c' }];
const HOUR  = 3600 * 1000;

await saveState({ username: 'histtest', lastSyncAt: new Date().toISOString(),
                  items: three, seen: ['a', 'b', 'c'] });

const hit = await historyFor('histtest', 3);
ok(hit?.items?.length === 3, 'تاریخچه‌ی تازه و به‌اندازه، استفاده می‌شود');
ok(hit?.at != null, 'تاریخ خواندن با تاریخچه می‌آید — شاهد مال امروز وانمود نمی‌شود');

ok(await historyFor('histtest', 10) === null,
   'تاریخچه‌ی کم‌تعداد از خواسته، استفاده نمی‌شود — کم‌بودن شاهد پنهان نمی‌ماند');

await saveState({ username: 'histtest', lastSyncAt: new Date().toISOString(),
                  items: three, seen: ['a', 'b', 'c'], exhausted: true });
ok((await historyFor('histtest', 10))?.items?.length === 3,
   'ولی اگر خودِ پیج کمتر داشت (exhausted)، همان کم هم بس است');

await saveState({ username: 'oldtest', lastSyncAt: new Date(Date.now() - 100 * HOUR).toISOString(),
                  items: three, seen: [] });
ok(await historyFor('oldtest', 3) === null, 'تاریخچه‌ی کهنه‌تر از سقف، استفاده نمی‌شود');

resetApifyCalls();
const fromHist = await quickInstagram('https://www.instagram.com/histtest', { limit: 3 });
ok(fromHist.ok && fromHist.via === 'history' && apifyCalls() === 0,
   `خواندن از تاریخچه صفر فراخوان Apify دارد (شد ${apifyCalls()})`);

process.env.VOHU_FIXTURES = './fixtures';
resetApifyCalls();
const forced = await quickInstagram('https://www.instagram.com/histtest', { limit: 3, refetch: true });
ok(forced.ok && forced.via === 'apify' && apifyCalls() === 1,
   `refetch تاریخچه را دور می‌زند و تازه می‌خواند (${apifyCalls()} فراخوان)`);

const after = await historyFor('histtest', 3);
ok(after?.items?.length === 3, 'استخراج تازه در تاریخچه ماند تا دفعه‌ی بعد از آنجا ادامه دهد');

// ── ۵ · انبار حالت خشک جداست ──────────────────────────────────
// داده‌ی ساختگی اگر در تاریخچه‌ی واقعی بنشیند دفعه‌ی بعد دوباره استفاده
// می‌شود و جای استخراج واقعی را می‌گیرد — یعنی تحلیل روی پستی که نبوده.
const { storeDir, storeKind } = await import('../services/store.js');

// این سه ادعا به *سازوکار* انبار کار دارند، نه به مغز: پوشه کجاست و چه
// نامی دارد. روی انبار SQLite تنانت پوشه‌ای در کار نیست، پس سنجیدنشان
// بی‌معناست — رد می‌شوند و همین‌جا گفته می‌شود.
if (storeKind() !== 'files') {
  console.log('  ⓘ ۳ ادعای پوشه‌ی انبار رد شد — این میزبان انبارش '
            + `«${storeKind()}» است، نه فایل`);
} else {
  const keep = process.env.VOHU_STORE_DIR;

  delete process.env.VOHU_STORE_DIR;
  ok(storeDir() === '.vohu-dry', `در حالت خشک انبار جداست: ${storeDir()}`);

  const dry = process.env.VOHU_DRY_RUN;
  delete process.env.VOHU_DRY_RUN;
  ok(storeDir() === '.vohu', `در حالت واقعی انبار .vohu است: ${storeDir()}`);
  process.env.VOHU_DRY_RUN = dry;

  process.env.VOHU_STORE_DIR = keep;
  ok(storeDir() === keep, 'VOHU_STORE_DIR صریح همیشه برنده است');
}

console.log(`\n  ${pass} قبول · ${fail} رد\n`);
process.exit(fail ? 1 : 0);
