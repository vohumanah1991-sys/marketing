/**
 * همگام‌سازی یک پیج اینستاگرام.
 *
 * بار اول: ۵۰ محتوای آخر.
 * بارهای بعد: فقط چیزی که از آخرین همگام‌سازی جدیدتر است.
 *
 * وضعیت هر پیج در .vohu/ig-<username>.json نگه داشته می‌شود.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fetchPosts, fetchReels, classifyInstagramUrl, apifyEnabled, redact } from '../services/apify.js';
import { buildContentItem } from './instagram.js';

const DIR = process.env.VOHU_STORE_DIR || '.vohu';
// سقف پیش‌فرض هر بار: ۱۰ پست و ۱۰ ریلز، جدا از هم.
// هر بار می‌شود بیشتر خواست — با {posts: 25, reels: 5} در بدنه‌ی درخواست.
const DEF_POSTS = Number(process.env.IG_POSTS || 10);
const DEF_REELS = Number(process.env.IG_REELS || 10);
const MAX_EACH  = Number(process.env.IG_MAX || 200);

/** سقف خواسته‌شده را با پیش‌فرض و حداکثر جمع می‌بندد. */
export function resolveLimits({ posts, reels } = {}) {
  const one = (v, d) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return d;
    return Math.min(Math.floor(n), MAX_EACH);
  };
  return { posts: one(posts, DEF_POSTS), reels: one(reels, DEF_REELS) };
}

const stateFile = u => path.join(DIR, `ig-${String(u).replace(/[^a-z0-9._-]/gi, '')}.json`);

export async function loadState(username) {
  const f = stateFile(username);
  if (!existsSync(f)) return { username, lastSyncAt: null, items: [], seen: [] };
  return JSON.parse(await readFile(f, 'utf8'));
}

export async function saveState(state) {
  if (!existsSync(DIR)) await mkdir(DIR, { recursive: true });
  state.updatedAt = new Date().toISOString();
  await writeFile(stateFile(state.username), JSON.stringify(state, null, 2));
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
    const r = await fetchPosts([target], { limit: 1 });
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

  const jobs = [];
  if (lim.posts > 0) jobs.push(fetchPosts([`https://www.instagram.com/${username}/`],
                                          { limit: lim.posts, newerThan }));
  else jobs.push(Promise.resolve({ ok: true, items: [], skippedByLimit: true }));

  if (lim.reels > 0) jobs.push(fetchReels(username, { limit: lim.reels, newerThan }));
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
 * خواندن سریع، فقط متادیتا — بدون دانلود ویدئو و بدون OCR.
 * این همان چیزی است که مرحله‌ی اول اجرا (advance) استفاده می‌کند،
 * تا کاربر پشت یک استخراج بیست‌دقیقه‌ای منتظر نماند.
 * استخراج عمیق کار پس‌زمینه است.
 */
export async function quickInstagram(profileUrl, { limit = 12, timeoutMs = null } = {}) {
  if (!apifyEnabled()) return { ok: false, error: 'APIFY_TOKEN تعریف نشده', skipped: true };
  const c = classifyInstagramUrl(profileUrl);
  if (c.kind === 'unknown') return { ok: false, error: 'لینک اینستاگرام شناخته نشد' };

  // سقف کوتاه: کاربر در مرحله‌ی اول نباید پشت Apify منتظر بماند.
  // اگر دیر کرد، اینستاگرام «خوانده نشد» می‌شود و بقیه‌ی کار ادامه پیدا می‌کند —
  // استخراج عمیق کار پس‌زمینه است و دکمه‌ی خودش را دارد.
  const r = await fetchPosts([profileUrl], {
    limit,
    timeoutMs: timeoutMs || Number(process.env.IG_QUICK_TIMEOUT_MS || 60000)
  });
  if (!r.ok) return { ok: false, error: r.error, detail: r.detail };
  if (!r.items.length) return { ok: false, error: 'چیزی برنگشت — شاید پیج خصوصی است یا خالی' };

  const items = [];
  for (const raw of r.items) items.push(await buildContentItem(raw, { withMedia: false }));
  return { ok: true, items };
}
