/**
 * خواندن نوشته‌های داخل تصویر و ویدئو.
 *
 * سه قاعده که در همه‌ی این فایل رعایت می‌شوند:
 *   ۱. لینک متن نیست. اگر چیزی که به‌عنوان «متن» درآمد فقط یک URL بود، رد می‌شود.
 *   ۲. متن خالی «استخراج موفق» نیست. وضعیت failed می‌گیرد، نه ok با رشته‌ی خالی.
 *   ۳. نبود ابزار (ffmpeg/tesseract) بی‌سروصدا رد نمی‌شود — وضعیت صریح می‌گیرد.
 *
 * نیازمندی‌های سیستم:
 *   apt install -y ffmpeg tesseract-ocr tesseract-ocr-fas
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);

// ── در دسترس بودن ابزارها ────────────────────────────────────

let _caps = null;
export async function capabilities() {
  if (_caps) return _caps;
  const has = async (cmd, args) => {
    try { await run(cmd, args, { timeout: 8000 }); return true; } catch { return false; }
  };
  const ffmpeg    = await has('ffmpeg', ['-version']);
  const tesseract = await has('tesseract', ['--version']);

  let langs = [];
  if (tesseract) {
    try {
      const { stdout } = await run('tesseract', ['--list-langs'], { timeout: 8000 });
      langs = stdout.split('\n').slice(1).map(s => s.trim()).filter(Boolean);
    } catch {}
  }
  _caps = { ffmpeg, tesseract, langs,
            ocrPersian: langs.includes('fas'), ocrEnglish: langs.includes('eng') };
  return _caps;
}

/** زبان‌هایی که به tesseract می‌دهیم — هرچه هست، به ترتیب اولویت. */
function langArg(caps) {
  const want = ['fas', 'eng'].filter(l => caps.langs.includes(l));
  return want.length ? want.join('+') : null;
}

// ── قاعده‌ی «لینک متن نیست» ──────────────────────────────────

const URL_ONLY = /^\s*(https?:\/\/|www\.)\S+\s*$/i;
const MEDIA_EXT = /\.(mp4|m3u8|mov|webm|mp3|m4a|wav|aac|jpg|jpeg|png|webp)(\?|$)/i;

/**
 * آیا این رشته را می‌شود «متن استخراج‌شده» حساب کرد؟
 * لینک، مسیر فایل رسانه، یا رشته‌ی خیلی کوتاه → نه.
 */
export function isRealText(s, { min = 2 } = {}) {
  const t = String(s ?? '').trim();
  if (!t) return false;
  if (URL_ONLY.test(t)) return false;
  if (MEDIA_EXT.test(t) && t.split(/\s+/).length <= 2) return false;
  // متنی که فقط علامت است
  if (!/[\p{L}\p{N}]/u.test(t)) return false;
  return t.replace(/\s+/g, '').length >= min;
}

/**
 * بسته‌بندی استاندارد نتیجه‌ی هر استخراج متنی.
 * خالی → failed. هیچ‌جا متن خالی به‌عنوان موفق ثبت نمی‌شود.
 */
export function textResult(text, { reason = null } = {}) {
  if (isRealText(text)) return { text: String(text).trim(), status: 'ok', error: null };
  return { text: '', status: 'failed', error: reason || (text ? 'خروجی متن معتبر نبود' : 'متنی به دست نیامد') };
}

// ── دانلود ───────────────────────────────────────────────────

export async function download(url, dest, { timeoutMs = 90000, maxBytes = 120 * 1024 * 1024 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) return { ok: false, error: `فایل بزرگ‌تر از حد مجاز (${buf.length} بایت)` };
    await writeFile(dest, buf);
    return { ok: true, path: dest, bytes: buf.length };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'دانلود تایم‌اوت شد' : e.message };
  } finally { clearTimeout(timer); }
}

// ── فریم‌گیری ────────────────────────────────────────────────

/**
 * فریم در تغییر صحنه + فریم در فاصله‌ی ثابت.
 *
 * چرا هر دو: تغییر صحنه جای برش‌ها را می‌گیرد، ولی ریلزی که یک پلان ثابت است
 * و متن روی آن عوض می‌شود هیچ تغییر صحنه‌ای ندارد. فاصله‌ی ثابت آن را می‌گیرد.
 */
export async function extractFrames(videoPath, outDir, {
  sceneThreshold = 0.30, everySeconds = 2.5, maxFrames = 24
} = {}) {
  const caps = await capabilities();
  if (!caps.ffmpeg) return { ok: false, error: 'ffmpeg نصب نیست', frames: [] };

  const filter = `select='gt(scene,${sceneThreshold})+not(mod(t,${everySeconds}))',scale=1280:-2`;
  try {
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', videoPath,
      '-vf', filter,
      '-vsync', 'vfr',
      '-frames:v', String(maxFrames),
      '-q:v', '2',
      path.join(outDir, 'f-%03d.jpg')
    ], { timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  } catch (e) {
    return { ok: false, error: `ffmpeg: ${String(e.stderr || e.message).slice(0, 200)}`, frames: [] };
  }

  const files = (await readdir(outDir)).filter(f => f.startsWith('f-') && f.endsWith('.jpg')).sort();
  return { ok: true, frames: files.map(f => path.join(outDir, f)) };
}

// ── OCR ──────────────────────────────────────────────────────

export async function ocrImage(file) {
  const caps = await capabilities();
  if (!caps.tesseract) return textResult('', { reason: 'tesseract نصب نیست' });

  const lang = langArg(caps);
  if (!lang) return textResult('', { reason: 'هیچ بسته‌ی زبانی برای tesseract نصب نیست' });

  try {
    const { stdout } = await run('tesseract', [file, 'stdout', '-l', lang, '--psm', '6'],
                                 { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    return textResult(cleanOcr(stdout));
  } catch (e) {
    return textResult('', { reason: `tesseract: ${String(e.stderr || e.message).slice(0, 160)}` });
  }
}

function cleanOcr(s) {
  return String(s)
    .replace(/[ \t]+/g, ' ')
    .split('\n').map(l => l.trim())
    .filter(l => l && /[\p{L}\p{N}]/u.test(l))
    .join('\n')
    .trim();
}

// ── حذف تکرار، با حفظ اینکه هر متن مال کجاست ─────────────────

// کلید مقایسه: فاصله و نیم‌فاصله و نقطه‌گذاری کلاً حذف می‌شوند،
// چون OCR «دست‌ساز» را گاهی «دست ساز» و گاهی «دستساز» می‌خواند.
const norm = s => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * ورودی: [{ text, at }]  →  خروجی: [{ text, at, alsoAt[] }]
 * متن تکراری حذف می‌شود ولی جای اولین ظهورش و جاهای دیگرش ثبت می‌ماند.
 * «تکراری» یعنی یکی زیرمجموعه‌ی دیگری باشد — نه فقط برابری دقیق،
 * چون OCR هر فریم چند حرف کم‌وزیاد می‌کند.
 */
export function dedupeTexts(items) {
  const out = [];
  for (const it of items) {
    const t = String(it.text || '').trim();
    if (!isRealText(t)) continue;
    const n = norm(t);
    if (!n) continue;

    const hit = out.find(o => o._n === n || o._n.includes(n) || n.includes(o._n));
    if (hit) {
      if (n.length > hit._n.length) { hit.text = t; hit._n = n; }   // نسخه‌ی کامل‌تر بماند
      if (it.at != null && !hit.alsoAt.includes(it.at) && it.at !== hit.at) hit.alsoAt.push(it.at);
      continue;
    }
    out.push({ text: t, at: it.at ?? null, alsoAt: [], _n: n });
  }
  return out.map(({ _n, ...rest }) => rest);
}

// ── پوشه‌ی موقت ──────────────────────────────────────────────

export async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vohu-'));
  try { return await fn(dir); }
  finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}
