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

async function runActor(actor, input, { timeoutMs } = {}) {
  const token = process.env.APIFY_TOKEN;
  if (!token) return { ok: false, error: 'APIFY_TOKEN تعریف نشده', skipped: true };

  const ms    = Number(timeoutMs || process.env.APIFY_TIMEOUT_MS || 240000);
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);

  try {
    const res = await fetch(`${BASE}/actors/${actor}/runs?sync=1&collect=dataset`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`      // در هدر، نه در URL
      },
      body: JSON.stringify(input)
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `Apify HTTP ${res.status}`, detail: redact(body).slice(0, 400) };
    }

    const items = await res.json();
    if (!Array.isArray(items)) return { ok: false, error: 'خروجی Apify آرایه نبود' };
    return { ok: true, items };

  } catch (e) {
    return { ok: false,
             error: e.name === 'AbortError' ? `Apify در ${Math.round(ms / 1000)}s جواب نداد`
                                            : redact(e.message) };
  } finally {
    clearTimeout(timer);
  }
}

// ── پست‌ها (تک‌عکس و اسلایدی) ─────────────────────────────────

/**
 * پست‌ها با directUrls — همان‌طور که خواسته شد.
 * newerThan: ISO یا null. اگر داده شود فقط جدیدترها می‌آیند.
 */
export async function fetchPosts(urls, { limit = 50, newerThan = null, timeoutMs = null } = {}) {
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
  return runActor(actor, input, { timeoutMs });
}

// ── ریلز ─────────────────────────────────────────────────────

/**
 * ریلز با username — این اکتور directUrls ندارد، فقط username می‌گیرد.
 * سه افزونه‌ی خواسته‌شده اینجا روشن می‌شوند. هر سه پولی‌اند.
 */
export async function fetchReels(username, { limit = 50, newerThan = null } = {}) {
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
  return runActor(actor, input);
}

// ── کامنت‌ها (اختیاری) ────────────────────────────────────────

export async function fetchComments(postUrls, { limit = 20 } = {}) {
  if (process.env.APIFY_COMMENTS !== '1')
    return { ok: false, skipped: true, error: 'APIFY_COMMENTS=1 نیست — کامنت‌ها خوانده نشدند' };

  const actor = process.env.APIFY_ACTOR_COMMENTS || 'apify~instagram-comment-scraper';
  log(`  → Apify comments: ${postUrls.length} پست · حداکثر ${limit} کامنت`);
  return runActor(actor, {
    directUrls: postUrls,
    resultsLimit: limit
  });
}
