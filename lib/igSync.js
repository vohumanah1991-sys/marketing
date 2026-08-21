/**
 * همگام‌سازی یک پیج اینستاگرام.
 *
 * بار اول: ۵۰ محتوای آخر.
 * بارهای بعد: فقط چیزی که از آخرین همگام‌سازی جدیدتر است.
 *
 * وضعیت هر پیج در .vohu/ig-<username>.json نگه داشته می‌شود.
 */

import { fetchPosts, fetchReels, classifyInstagramUrl, apifyEnabled, redact } from '../services/apify.js';
import { buildContentItem } from './instagram.js';
import { readDoc, writeDoc } from '../services/store.js';

// سقف پیش‌فرض هر بار: ۱۰ پست و ۱۰ ریلز، جدا از هم.
// هر بار می‌شود بیشتر خواست — با {posts: 25, reels: 5} در بدنه‌ی درخواست.
const DEF_POSTS = Number(process.env.IG_POSTS || 10);
const DEF_REELS = Number(process.env.IG_REELS || 10);
const MAX_EACH  = Number(process.env.IG_MAX || 200);
// تا این‌قدر ساعت، استخراج قبلی دوباره خوانده نمی‌شود — هر فراخوان Apify پول است.
// عدد در کد است نه در پرامپت؛ کهنگی تصمیم قطعی است، نه سلیقه‌ی مدل.
const HISTORY_TTL_H = Number(process.env.IG_HISTORY_TTL_H || 24);

/** سقف خواسته‌شده را با پیش‌فرض و حداکثر جمع می‌بندد. */
export function resolveLimits({ posts, reels } = {}) {
  const one = (v, d) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return d;
    return Math.min(Math.floor(n), MAX_EACH);
  };
  return { posts: one(posts, DEF_POSTS), reels: one(reels, DEF_REELS) };
}

const stateId = u => String(u).replace(/[^a-z0-9._-]/gi, '');

export async function loadState(username) {
  return (await readDoc('ig', stateId(username)))
      || { username, lastSyncAt: null, items: [], seen: [] };
}

export async function saveState(state) {
  state.updatedAt = new Date().toISOString();
  await writeDoc('ig', stateId(state.username), state);
  return state;
}

/**
 * @param target  آدرس پیج، ریلز یا پست
 * @param report  تابع گزارش پیشرفت (از صف کار می‌آید)
 */
export async function syncInstagram({ target, withMedia = true, force = false, posts: wantPosts, reels: wantReels } = {}, report = async () => {}) {
  if (!apifyEnabled()) throw new Error('APIFY_TOKEN تعریف نشده — استخراج اینستاگرام خاموش است');

  const c = classifyInstagramUrl(target);
  if (c.kind === 'unknown') throw new Error(`لینک اینستاگرام شناخته نشد: ${target}`);

  // ── یک پست یا ریلز مشخص ──
  if (c.kind === 'post' || c.kind === 'reel') {
    await report({ note: 'خواندن از Apify', total: 1 });
    const r = await fetchPosts([target], { limit: 1,
      onProgress: q => { report({ note: `خواندن از Apify — ${q.note || ''}`.trim() }).catch(() => {}); } });
    if (!r.ok) throw new Error(redact(r.error + (r.detail ? ' · ' + r.detail : '')));
    if (!r.items.length) throw new Error('Apify چیزی برنگرداند — شاید پیج خصوصی است');

    await report({ note: 'استخراج متن و OCR' });
    const item = await buildContentItem(r.items[0], { withMedia });
    await report({ done: 1, total: 1, note: 'تمام' });
    return { username: item.ownerUsername, newItems: [item], skipped: 0, mode: 'single' };
  }

  // ── کل پیج ──
  const username = c.username;
  const state = await loadState(username);
  const first = force || !state.lastSyncAt;
  const newerThan = first ? null : state.lastSyncAt;
  const lim = resolveLimits({ posts: wantPosts, reels: wantReels });

  await report({ note: `${lim.posts} پست + ${lim.reels} ریلز`
                     + (first ? ' · اولین همگام‌سازی' : ` · فقط جدیدتر از ${newerThan}`) });

  // پست و ریلز موازی می‌روند و هیچ‌کدام مهلت ندارند — ریلز ذاتاً کند است.
  // پس وضعیت هر دو در یک خط با هم گزارش می‌شود تا معلوم باشد کجای کاریم.
  const fetchNote = { posts: null, reels: null };
  const sayFetch = () => {
    const bits = [];
    if (fetchNote.posts) bits.push(`پست‌ها: ${fetchNote.posts}`);
    if (fetchNote.reels) bits.push(`ریلز: ${fetchNote.reels}`);
    if (bits.length) report({ note: bits.join(' · ') }).catch(() => {});
  };
  const track = which => q => {
    // درصد فقط وقتی گفته می‌شود که واقعاً شمرده شده باشد
    fetchNote[which] = (q.note || '')
      + (q.percent != null ? ` — ${q.done ?? 0} از ${q.total} (${q.percent}٪)` : '');
    sayFetch();
  };

  const jobs = [];
  if (lim.posts > 0) jobs.push(fetchPosts([`https://www.instagram.com/${username}/`],
                                          { limit: lim.posts, newerThan, onProgress: track('posts') }));
  else jobs.push(Promise.resolve({ ok: true, items: [], skippedByLimit: true }));

  if (lim.reels > 0) jobs.push(fetchReels(username, { limit: lim.reels, newerThan, onProgress: track('reels') }));
  else jobs.push(Promise.resolve({ ok: true, items: [], skippedByLimit: true }));

  const [posts, reels] = await Promise.all(jobs);

  const raws = [];
  const notes = [];
  if (posts.ok) raws.push(...posts.items); else notes.push(`پست‌ها: ${redact(posts.error)}`);
  if (reels.ok) raws.push(...reels.items); else notes.push(`ریلز: ${redact(reels.error)}`);
  if (!raws.length) throw new Error(notes.join(' · ') || 'هیچ محتوایی برنگشت');

  // اگر اکتور دقیقاً به سقف رسید، یعنی احتمالاً بیشتر هم هست — صریح بگو
  if (posts.ok && posts.items.length >= lim.posts && lim.posts > 0)
    notes.push(`پست‌ها به سقف ${lim.posts} رسید — احتمالاً بیشتر هم هست`);
  if (reels.ok && reels.items.length >= lim.reels && lim.reels > 0)
    notes.push(`ریلز به سقف ${lim.reels} رسید — احتمالاً بیشتر هم هست`);

  // تکراری‌ها بین دو اکتور و نسبت به همگام‌سازی قبلی
  const seen = new Set(state.seen || []);
  const uniq = [];
  const inBatch = new Set();
  for (const r of raws) {
    const key = r.shortCode || r.shortcode || r.id || r.url;
    if (!key || inBatch.has(key)) continue;
    inBatch.add(key);
    if (!force && seen.has(key)) continue;
    uniq.push({ key, raw: r });
  }

  await report({ total: uniq.length, done: 0,
                 note: `${uniq.length} محتوای جدید · ${raws.length - uniq.length} تکراری رد شد` });

  const items = [];
  for (const [i, { key, raw }] of uniq.entries()) {
    try {
      items.push(await buildContentItem(raw, { withMedia }));
      seen.add(key);
    } catch (e) {
      items.push({ shortCode: key, extraction: { status: 'failed', errors: [redact(e.message)] } });
    }
    await report({ done: i + 1, note: `${i + 1} از ${uniq.length}` });
  }

  state.username   = username;
  state.lastSyncAt = new Date().toISOString();
  state.seen       = [...seen].slice(-2000);
  state.items      = [...items, ...(state.items || [])].slice(0, 500);
  await saveState(state);

  return { username, newItems: items, skipped: raws.length - uniq.length,
           mode: first ? 'first' : 'incremental',
           limits: lim,
           fetched: { posts: posts.items.length, reels: reels.items.length },
           notes };
}

/**
 * آیا استخراج قبلی همین پیج هنوز قابل استفاده است؟
 *
 * «قابل استفاده» یعنی هم تازه باشد هم به‌اندازه — نه اینکه صرفاً چیزی آنجا باشد.
 * اگر دفعه‌ی قبل خودِ پیج کمتر از خواسته داشت (`exhausted`)، کم‌بودنش عیب نیست
 * و دوباره پول‌دادن چیزی اضافه نمی‌کند.
 *
 * برمی‌گرداند { items, at } یا null. هیچ‌وقت نیمه‌کاره جواب نمی‌دهد.
 */
export async function historyFor(username, limit, { ttlH = HISTORY_TTL_H } = {}) {
  const state = await loadState(username).catch(() => null);
  const at = state?.lastSyncAt;
  if (!state || !at || !Array.isArray(state.items) || !state.items.length) return null;

  const ageH = (Date.now() - new Date(at).getTime()) / 3600000;
  if (!Number.isFinite(ageH) || ageH > ttlH) return null;

  const enough = state.items.length >= limit || state.exhausted === true;
  if (!enough) return null;

  return { items: state.items.slice(0, limit), at, ageH: Math.round(ageH * 10) / 10 };
}

/**
 * استخراج تازه را در همان تاریخچه‌ای می‌نویسد که استخراج عمیق استفاده می‌کند،
 * تا اجرای بعدی — و حتی بعد از ریست سرور — از همین‌جا ادامه بدهد.
 */
async function rememberQuick(username, items, requested) {
  const state = await loadState(username).catch(() => ({ username, items: [], seen: [] }));
  const seen  = new Set(state.seen || []);
  const fresh = [];
  for (const it of items) {
    const key = it.shortCode || it.id || it.sourceUrl;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    fresh.push(it);
  }
  state.username   = username;
  state.lastSyncAt = new Date().toISOString();
  state.seen       = [...seen].slice(-2000);
  state.items      = [...fresh, ...(state.items || [])].slice(0, 500);
  // پیج کمتر از خواسته داشت؟ پس دفعه‌ی بعد کم‌بودنِ تاریخچه دلیل پول‌دادن نیست.
  state.exhausted  = items.length < requested;
  await saveState(state).catch(() => {});
}

/**
 * خواندن سریع، فقط متادیتا — بدون دانلود ویدئو و بدون OCR.
 * این همان چیزی است که مرحله‌ی اول اجرا (advance) استفاده می‌کند،
 * تا کاربر پشت یک استخراج بیست‌دقیقه‌ای منتظر نماند.
 * استخراج عمیق کار پس‌زمینه است.
 */
export async function quickInstagram(profileUrl, { limit = 12, timeoutMs = null,
                                                   onProgress = null, refetch = false } = {}) {
  if (!apifyEnabled()) return { ok: false, error: 'APIFY_TOKEN تعریف نشده', skipped: true };
  const c = classifyInstagramUrl(profileUrl);
  if (c.kind === 'unknown') return { ok: false, error: 'لینک اینستاگرام شناخته نشد' };

  // ── اول تاریخچه، بعد پول ──
  // اگر همین پیج تازگی خوانده شده — چه اینجا چه با استخراج عمیق — از همان‌جا
  // ادامه می‌دهیم. تاریخِ خواندن با خودش می‌آید تا مرحله‌های بعد بدانند شاهد
  // مال کِی است؛ «تازه خوانده شد» وانمود نمی‌شود.
  if (c.kind === 'profile' && !refetch) {
    const h = await historyFor(c.username, limit);
    if (h) {
      onProgress?.({ phase: 'history', note: `از تاریخچه‌ی ${h.ageH} ساعت پیش`,
                     done: h.items.length, total: limit, percent: 100, elapsed: 0 });
      return { ok: true, items: h.items, via: 'history', readAt: h.at, ageH: h.ageH };
    }
  }

  // مهلتی گذاشته نمی‌شود. خواندن اینستاگرام — به‌ویژه ریلز — دقیقه‌ها طول می‌کشد
  // و قطع‌کردنش یعنی پولِ اجرای Apify خرج شده ولی هیچ شاهدی به دست نیامده.
  // به‌جای مهلت، پیشرفت واقعی گزارش می‌شود: مرحله و شمار آیتم‌های جمع‌شده.
  // اگر جایی واقعاً مهلت لازم شد، IG_QUICK_TIMEOUT_MS را صریح تعریف کن.
  const r = await fetchPosts([profileUrl], {
    limit,
    onProgress,
    timeoutMs: timeoutMs || Number(process.env.IG_QUICK_TIMEOUT_MS) || null
  });
  if (!r.ok) return { ok: false, error: r.error, detail: r.detail };
  if (!r.items.length) return { ok: false, error: 'چیزی برنگشت — شاید پیج خصوصی است یا خالی' };

  const items = [];
  for (const raw of r.items) {
    items.push(await buildContentItem(raw, { withMedia: false }));
    onProgress?.({ phase: 'building', note: 'ساخت محتوا از خروجی خام',
                   done: items.length, total: r.items.length,
                   percent: Math.round((items.length / r.items.length) * 100) });
  }
  // در تاریخچه بماند تا اجرای بعدی از همین‌جا ادامه بدهد و دوباره پول ندهد
  if (c.kind === 'profile') await rememberQuick(c.username, items, limit);

  return { ok: true, items, via: 'apify', readAt: new Date().toISOString() };
}
