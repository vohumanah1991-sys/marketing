/**
 * لایه‌ی Apify — تنها جایی از برنامه که توکن Apify را می‌شناسد.
 *
 * قاعده‌های امنیتی (تست هم دارند):
 *   · توکن فقط از process.env.APIFY_TOKEN خوانده می‌شود.
 *   · هرگز در پاسخ API، در خروجی هیچ تابعی، یا در لاگ ظاهر نمی‌شود.
 *   · هرگز داخل query string نمی‌رود (سرورها query را لاگ می‌کنند) — فقط هدر Authorization.
 *   · توکن در .env است و .env در .gitignore.
 *
 * اکتورها:
 *   پست/اسلایدی/پروفایل → apify~instagram-scraper      (ورودی directUrls)
 *   ریلز                → apify~instagram-reel-scraper (ورودی username)
 *   کامنت‌ها            → apify~instagram-comment-scraper (اختیاری، هزینه‌ی جدا)
 */

const BASE = 'https://api.apify.com/v2';

export const apifyEnabled = () => Boolean(process.env.APIFY_TOKEN);

/**
 * هر رشته‌ای که ممکن است توکن داشته باشد از این رد می‌شود، بعد لاگ/برگردانده می‌شود.
 * هیچ‌جای دیگری اجازه ندارد متن خام Apify را مستقیم چاپ کند.
 */
export function redact(s) {
  return String(s ?? '')
    .replace(/apify_api_[A-Za-z0-9]+/g, 'apify_api_***')
    .replace(/(token=)[^&\s"']+/gi, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1***');
}

const log = (...a) => console.log(...a.map(x => (typeof x === 'string' ? redact(x) : x)));

// ── شمارش فراخوان‌ها و ترمز دستی ──────────────────────────────
//
// هر فراخوان اکتور پول است. دو محافظ اینجاست:
//   · شمارنده — تا در تست بشود ثابت کرد یک کار، یک فراخوان است و نه بیشتر.
//   · APIFY_MAX_CALLS — سقف مطلق در عمر یک پروسه. رسیدن به سقف یعنی
//     دیگر هیچ درخواستی زده نمی‌شود، حتی در حالت خشک.
let CALLS = 0;
export const apifyCalls      = () => CALLS;
export const resetApifyCalls = () => { CALLS = 0; };

// ── تشخیص نوع لینک ───────────────────────────────────────────

/**
 * لینک اینستاگرام → { kind, username, shortCode }
 *   kind: profile | reel | post | unknown
 * «پست» ممکن است تک‌عکس باشد یا اسلایدی — این را فقط بعد از خواندن می‌فهمیم،
 * پس اینجا حدس نمی‌زنیم.
 */
export function classifyInstagramUrl(raw) {
  let u;
  try { u = new URL(String(raw).startsWith('http') ? raw : 'https://' + raw); }
  catch { return { kind: 'unknown' }; }

  if (!/(^|\.)instagram\.com$/.test(u.hostname.replace(/^www\./, ''))) return { kind: 'unknown' };

  const seg = u.pathname.split('/').filter(Boolean);
  if (!seg.length) return { kind: 'unknown' };

  if (seg[0] === 'reel' || seg[0] === 'reels')
    return { kind: 'reel', shortCode: seg[1] || null };
  if (seg[0] === 'p')
    return { kind: 'post', shortCode: seg[1] || null };
  if (seg[0] === 'tv')
    return { kind: 'post', shortCode: seg[1] || null };

  // /username/ یا /username/reels/
  const reserved = new Set(['explore', 'accounts', 'direct'
                           , 'stories', 'about', 'legal']);
  if (reserved.has(seg[0])) return { kind: 'unknown' };
  return { kind: 'profile', username: seg[0] };
}

// ── فراخوانی اکتور ───────────────────────────────────────────

/**
 * وضعیت‌های پایانی Apify — بعد از اینها دیگر چیزی عوض نمی‌شود.
 */
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);

const FA_STATUS = {
  'READY':     'در صف Apify',
  'RUNNING':   'در حال خواندن از اینستاگرام',
  'SUCCEEDED': 'تمام شد',
  'FAILED':    'شکست خورد',
  'ABORTING':  'در حال قطع',
  'ABORTED':   'قطع شد',
  'TIMING-OUT':'در حال اتمام مهلت',
  'TIMED-OUT': 'مهلت Apify تمام شد'
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * اکتور را ناهمگام اجرا می‌کند و تا وضعیت پایانی نظرسنجی می‌کند.
 *
 * چرا ناهمگام و نه run-sync-get-dataset-items؟ چون آن یک درخواست بلوکه است:
 * تا تمام نشود هیچ خبری نمی‌دهد. ریلز و پست دقیقه‌ها طول می‌کشند و کاربر
 * باید ببیند کجای کار است. اینجا هر چند ثانیه وضعیت و شمار آیتم‌ها را می‌پرسیم.
 *
 * onProgress({ phase, note, done, total, percent, elapsed }) — همه‌ی عددها واقعی‌اند:
 * `done` شمار آیتم‌های واقعاً نوشته‌شده در دیتاست است، نه تخمین. اگر ندانیم، null.
 *
 * timeoutMs: اگر عدد مثبت بدهی مهلت می‌گذارد و در پایانش اجرا را روی Apify هم
 * قطع می‌کند (تا پول نسوزد). اگر ندهی — که حالت پیش‌فرض است — مهلتی در کار نیست.
 */
async function runActor(actor, input, { timeoutMs = null, onProgress = null,
                                        expected = null, fixture = 'apify-posts.json' } = {}) {
  const token = process.env.APIFY_TOKEN;
  if (!token) return { ok: false, error: 'APIFY_TOKEN تعریف نشده', skipped: true };

  // ترمز دستی — قبل از حالت خشک و قبل از شبکه. سقف که پر شد، تمام.
  const maxCalls = Number(process.env.APIFY_MAX_CALLS || 0);
  if (maxCalls > 0 && CALLS >= maxCalls) {
    log(`  ⛔ سقف APIFY_MAX_CALLS=${maxCalls} پر شد — فراخوانی زده نشد`);
    return { ok: false, capped: true,
             error: `سقف APIFY_MAX_CALLS=${maxCalls} پر شد — فراخوان تازه‌ای زده نشد` };
  }

  CALLS++;

  // حالت خشک: از fixtures خوانده می‌شود، نه از شبکه. بدون توکن واقعی، بدون هزینه.
  if (process.env.VOHU_DRY_RUN) {
    const { readFile } = await import('node:fs/promises');
    const { existsSync } = await import('node:fs');
    const f = `${process.env.VOHU_FIXTURES || './fixtures'}/${fixture}`;
    if (!existsSync(f)) return { ok: false, error: `اجرای خشک — فایل نمونه‌ی ${fixture} پیدا نشد` };
    try {
      const items = JSON.parse(await readFile(f, 'utf8'));
      if (!Array.isArray(items)) return { ok: false, error: `اجرای خشک — ${fixture} آرایه نبود` };
      onProgress?.({ phase: 'SUCCEEDED', note: 'اجرای خشک', done: items.length,
                     total: expected || items.length, percent: 100, elapsed: 0 });
      return { ok: true, items, dry: true };
    } catch (e) {
      return { ok: false, error: `اجرای خشک — ${fixture} خوانده نشد: ${e.message}` };
    }
  }

  const head = () => ({ 'content-type': 'application/json',
                        authorization: `Bearer ${token}` });   // در هدر، نه در URL

  const ms       = Number(timeoutMs);
  const deadline = ms > 0 ? Date.now() + ms : null;            // بدون عدد = بدون مهلت
  const pollMs   = Number(process.env.APIFY_POLL_MS || 3000);
  const t0       = Date.now();

  const say = patch => {
    if (!onProgress) return;
    try { onProgress({ elapsed: Math.round((Date.now() - t0) / 1000), ...patch }); } catch {}
  };

  const getJson = async path => {
    const r = await fetch(`${BASE}${path}`, { headers: head() });
    const t = await r.text();
    try { return { ok: r.ok, body: JSON.parse(t) }; } catch { return { ok: r.ok, body: null, text: t }; }
  };

  const pct = (done, total) =>
    (total > 0 && done != null) ? Math.min(99, Math.round((done / total) * 100)) : null;

  try {
    // ── ۱ · اجرا را شروع کن ──
    say({ phase: 'starting', note: 'راه‌اندازی اکتور', done: 0, total: expected, percent: 0 });

    const start = await fetch(`${BASE}/acts/${actor}/runs`, {
      method: 'POST', headers: head(), body: JSON.stringify(input)
    });
    const startText = await start.text();

    if (!start.ok) {
      let msg = `Apify HTTP ${start.status}`;
      try { const e = JSON.parse(startText); if (e?.error?.message) msg += ` — ${e.error.message}`; } catch {}
      return { ok: false, error: redact(msg), detail: redact(startText).slice(0, 400) };
    }

    let started;
    try { started = JSON.parse(startText); }
    catch { return { ok: false, error: 'خروجی Apify JSON نبود', detail: redact(startText).slice(0, 200) }; }

    const runId = started?.data?.id;
    const dsId  = started?.data?.defaultDatasetId || null;
    if (!runId)
      return { ok: false, error: 'Apify شناسه‌ی اجرا برنگرداند',
               detail: redact(`کلیدها: ${Object.keys(started?.data || started || {}).join(', ') || '(خالی)'}`) };

    // ── ۲ · تا وضعیت پایانی نظرسنجی کن ──
    let status = started?.data?.status || 'READY';
    let done   = null;

    say({ phase: status, note: FA_STATUS[status] || status, done: 0, total: expected, percent: 0 });

    while (!TERMINAL.has(status)) {
      if (deadline && Date.now() > deadline) {
        // مهلت داده شده و تمام شد — اجرا را روی Apify هم قطع کن تا هزینه ادامه پیدا نکند
        await fetch(`${BASE}/actor-runs/${runId}/abort`, { method: 'POST', headers: head() }).catch(() => {});
        return { ok: false, error: `Apify در ${Math.round(ms / 1000)}s جواب نداد` };
      }

      await sleep(pollMs);

      const r = await getJson(`/actor-runs/${runId}`);
      status  = r.body?.data?.status || status;

      // شمار آیتم‌های واقعاً نوشته‌شده — عدد ساخته نمی‌شود؛ اگر ندانیم null می‌ماند
      if (dsId) {
        const d = await getJson(`/datasets/${dsId}`);
        const c = d.body?.data?.itemCount;
        if (typeof c === 'number') done = c;
      }

      say({ phase: status, note: FA_STATUS[status] || status,
            done, total: expected, percent: pct(done, expected) });
    }

    if (status !== 'SUCCEEDED') {
      const fa = FA_STATUS[status] || status;
      return { ok: false, error: redact(`اجرای Apify ${fa} (${status})`) };
    }

    // ── ۳ · آیتم‌ها را از دیتاست بردار ──
    const finalDs = dsId || (await getJson(`/actor-runs/${runId}`)).body?.data?.defaultDatasetId;
    if (!finalDs) return { ok: false, error: 'اجرای Apify تمام شد ولی دیتاستی نداشت' };

    const items = (await getJson(`/datasets/${finalDs}/items?clean=true&format=json`)).body;
    if (!Array.isArray(items)) return { ok: false, error: 'دیتاست Apify آرایه برنگرداند' };

    say({ phase: 'SUCCEEDED', note: FA_STATUS.SUCCEEDED,
          done: items.length, total: expected || items.length, percent: 100 });

    return { ok: true, items };

  } catch (e) {
    return { ok: false, error: redact(e.message) };
  }
}

// ── پست‌ها (تک‌عکس و اسلایدی) ─────────────────────────────────

/**
 * پست‌ها با directUrls — همان‌طور که خواسته شد.
 * newerThan: ISO یا null. اگر داده شود فقط جدیدترها می‌آیند.
 */
export async function fetchPosts(urls, { limit = 50, newerThan = null, timeoutMs = null, onProgress = null } = {}) {
  const input = {
    directUrls:   Array.isArray(urls) ? urls : [urls],
    resultsType:  'posts',
    resultsLimit: limit,
    addParentData: false
  };
  if (newerThan) input.onlyPostsNewerThan = newerThan;

  const actor = process.env.APIFY_ACTOR_POSTS || 'apify~instagram-scraper';
  log(`  → Apify posts: ${input.directUrls.join(', ')} · حداکثر ${limit}`
      + (newerThan ? ` · جدیدتر از ${newerThan}` : ''));
  return runActor(actor, input, { timeoutMs, onProgress, expected: limit,
                                  fixture: 'apify-posts.json' });
}

// ── ریلز ─────────────────────────────────────────────────────

/**
 * ریلز با username — این اکتور directUrls ندارد، فقط username می‌گیرد.
 * سه افزونه‌ی خواسته‌شده اینجا روشن می‌شوند. هر سه پولی‌اند.
 */
export async function fetchReels(username, { limit = 50, newerThan = null, timeoutMs = null, onProgress = null } = {}) {
  const input = {
    username: Array.isArray(username) ? username : [username],
    resultsLimit: limit,
    includeTranscript:      true,
    includeDownloadedVideo: true,
    includeSharesCount:     true,
    skipPinnedPosts: false
  };
  if (newerThan) input.onlyPostsNewerThan = newerThan;

  const actor = process.env.APIFY_ACTOR_REELS || 'apify~instagram-reel-scraper';
  log(`  → Apify reels: ${input.username.join(', ')} · حداکثر ${limit}`
      + (newerThan ? ` · جدیدتر از ${newerThan}` : ''));
  return runActor(actor, input, { timeoutMs, onProgress, expected: limit,
                                  fixture: 'apify-reels.json' });
}

// ── کامنت‌ها (اختیاری) ────────────────────────────────────────

export async function fetchComments(postUrls, { limit = 20, onProgress = null } = {}) {
  if (process.env.APIFY_COMMENTS !== '1')
    return { ok: false, skipped: true, error: 'APIFY_COMMENTS=1 نیست — کامنت‌ها خوانده نشدند' };

  const actor = process.env.APIFY_ACTOR_COMMENTS || 'apify~instagram-comment-scraper';
  log(`  → Apify comments: ${postUrls.length} پست · حداکثر ${limit} کامنت`);
  return runActor(actor, {
    directUrls: postUrls,
    resultsLimit: limit
  }, { onProgress, fixture: 'apify-comments.json' });
}
