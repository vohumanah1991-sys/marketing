/**
 * ساخت «واحد محتوا» از خروجی خام Apify.
 *
 * ورودی: یک آیتم خام Apify.  خروجی: ContentItem با شکل ثابت.
 *
 * قاعده‌های ثابت این فایل:
 *   · هر عددی که در داده‌ی عمومی نبود → null. هیچ عددی ساخته یا حدس زده نمی‌شود.
 *     Save و Reach در داده‌ی عمومی اینستاگرام اصلاً وجود ندارند، پس همیشه null‌اند.
 *   · لینک صدا/ویدئو به‌عنوان متن پذیرفته نمی‌شود.
 *   · متن خالی «استخراج موفق» نیست — وضعیت failed می‌گیرد.
 *   · داده‌ی خام Apify همیشه نگه داشته می‌شود تا بعداً قابل بازبینی باشد.
 */

import path from 'node:path';
import { fetchComments } from '../services/apify.js';
import {
  capabilities, download, extractFrames, ocrImage,
  dedupeTexts, isRealText, textResult, withTempDir
} from '../services/media.js';

// ── کمک‌ها ───────────────────────────────────────────────────

/** اولین مقدار عددی معتبر از میان چند نام ممکن. نبود → null، نه صفر. */
const num = (x, ...keys) => {
  for (const k of keys) {
    const v = x?.[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
};

const str = (x, ...keys) => {
  for (const k of keys) {
    const v = x?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
};

const arr = (x, ...keys) => {
  for (const k of keys) if (Array.isArray(x?.[k]) && x[k].length) return x[k];
  return [];
};

export function extractTags(caption) {
  const c = String(caption || '');
  const uniq = re => [...new Set((c.match(re) || []).map(s => s.slice(1)))];
  return {
    hashtags: uniq(/#[\p{L}\p{N}_]+/gu),
    mentions: uniq(/@[A-Za-z0-9._]+/g)
  };
}

/** نوع محتوا از روی داده‌ی خام. */
export function contentType(raw) {
  const t = String(raw?.type || raw?.__typename || raw?.productType || '').toLowerCase();
  const kids = arr(raw, 'childPosts', 'sidecarItems', 'children');
  if (kids.length > 1) return 'carousel';
  if (/sidecar|carousel/.test(t)) return 'carousel';
  if (/clips|reel/.test(String(raw?.productType || ''))) return 'reel';
  if (/video/.test(t)) return raw?.videoDuration || raw?.videoUrl ? 'reel' : 'image';
  return 'image';
}

function toIso(v) {
  if (!v) return null;
  if (typeof v === 'number') return new Date(v * (v > 1e12 ? 1 : 1000)).toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ── متن گفتار ────────────────────────────────────────────────

/**
 * transcript از اکتور می‌آید. ولی گاهی به‌جای متن، لینک فایل می‌دهد —
 * و آن لینک متن نیست. اینجا همان‌جاست که این قاعده اعمال می‌شود.
 */
export function readTranscript(raw) {
  const t = str(raw, 'transcript', 'transcription', 'videoTranscript', 'audioTranscript', 'captions');
  if (t == null) return { text: '', status: 'not_available', error: 'اکتور transcript نداد' };
  if (!isRealText(t, { min: 4 }))
    return { text: '', status: 'failed', error: 'مقدار transcript متن نبود (احتمالاً لینک فایل)' };
  return { text: t, status: 'ok', error: null };
}

// ── OCR روی تصویر و ویدئو ────────────────────────────────────

async function ocrFromImageUrl(url, dir, tag) {
  if (!url) return { texts: [], status: 'failed', error: 'آدرس تصویر نبود' };
  const file = path.join(dir, `${tag}.jpg`);
  const d = await download(url, file);
  if (!d.ok) return { texts: [], status: 'failed', error: `دانلود تصویر: ${d.error}` };
  const o = await ocrImage(file);
  return o.status === 'ok'
    ? { texts: [{ text: o.text, at: 0 }], status: 'ok', error: null }
    : { texts: [], status: 'failed', error: o.error };
}

async function ocrFromVideoUrl(url, dir, tag, opts = {}) {
  if (!url) return { texts: [], status: 'failed', error: 'آدرس ویدئو نبود' };
  const file = path.join(dir, `${tag}.mp4`);
  const d = await download(url, file);
  if (!d.ok) return { texts: [], status: 'failed', error: `دانلود ویدئو: ${d.error}` };

  const fdir = path.join(dir, `${tag}-frames`);
  await (await import('node:fs/promises')).mkdir(fdir, { recursive: true });

  const fr = await extractFrames(file, fdir, opts);
  if (!fr.ok) return { texts: [], status: 'failed', error: fr.error };
  if (!fr.frames.length) return { texts: [], status: 'failed', error: 'فریمی استخراج نشد' };

  const got = [];
  for (const [i, f] of fr.frames.entries()) {
    const o = await ocrImage(f);
    if (o.status === 'ok') got.push({ text: o.text, at: i });
  }
  if (!got.length) return { texts: [], status: 'failed', error: `${fr.frames.length} فریم خوانده شد ولی متنی پیدا نشد` };
  return { texts: got, status: 'ok', error: null, frameCount: fr.frames.length };
}

const mediaUrlOf  = x => str(x, 'videoUrl', 'videoUrlBackup', 'downloadedVideoUrl', 'video_url');
const imageUrlOf  = x => str(x, 'displayUrl', 'imageUrl', 'display_url', 'thumbnailUrl');

// ── ساخت واحد محتوا ──────────────────────────────────────────

export async function buildContentItem(raw, { withMedia = true, frameOpts = {} } = {}) {
  const errors = [];
  const type   = contentType(raw);
  const caption = str(raw, 'caption', 'text') || '';
  const tags = extractTags(caption);

  const item = {
    type,
    sourceUrl:  str(raw, 'url', 'postUrl') ||
                (raw?.shortCode ? `https://www.instagram.com/${type === 'reel' ? 'reel' : 'p'}/${raw.shortCode}/` : null),
    shortCode:  str(raw, 'shortCode', 'shortcode', 'code', 'id'),
    ownerUsername: str(raw, 'ownerUsername', 'username', 'owner_username'),
    publishedAt: toIso(raw?.timestamp ?? raw?.takenAtTimestamp ?? raw?.taken_at_timestamp),

    caption,
    hashtags: arr(raw, 'hashtags').length ? arr(raw, 'hashtags') : tags.hashtags,
    mentions: arr(raw, 'mentions').length ? arr(raw, 'mentions') : tags.mentions,

    speechText: '',  speechStatus: 'not_attempted', speechError: null,
    imageText:  '',  imageTextStatus: 'not_attempted', imageTextError: null,
    slides: [],

    metrics: {
      likes:    num(raw, 'likesCount', 'likeCount', 'likes'),
      comments: num(raw, 'commentsCount', 'commentCount', 'comments'),
      shares:   num(raw, 'sharesCount', 'shareCount', 'reshareCount'),
      views:    num(raw, 'videoViewCount', 'viewsCount', 'video_view_count'),
      plays:    num(raw, 'videoPlayCount', 'playsCount', 'video_play_count'),
      // در داده‌ی عمومی اینستاگرام وجود ندارند — هرگز حدس زده نمی‌شوند
      saves: null,
      reach: null
    },

    comments: [],
    commentsStatus: 'not_attempted',

    raw,
    extraction: { status: 'pending', errors }
  };

  if (!withMedia) {
    item.extraction.status = 'metadata_only';
    return item;
  }

  const caps = await capabilities();
  if (!caps.ffmpeg)    errors.push('ffmpeg نصب نیست — نوشته‌های داخل ویدئو خوانده نشد');
  if (!caps.tesseract) errors.push('tesseract نصب نیست — OCR انجام نشد');
  else if (!caps.ocrPersian) errors.push('بسته‌ی زبان فارسی tesseract نصب نیست (tesseract-ocr-fas) — متن فارسی روی تصویر ضعیف خوانده می‌شود');

  await withTempDir(async (dir) => {
    // ── گفتار ──
    if (type === 'reel') {
      const tr = readTranscript(raw);
      item.speechText   = tr.text;
      item.speechStatus = tr.status === 'ok' ? 'ok' : 'failed';
      item.speechError  = tr.error;
      if (tr.status !== 'ok') errors.push(`گفتار: ${tr.error}`);
    }

    // ── اسلایدی ──
    const kids = arr(raw, 'childPosts', 'sidecarItems', 'children');
    if (type === 'carousel' && kids.length) {
      for (const [i, kid] of kids.entries()) {
        const isVideo = Boolean(mediaUrlOf(kid)) || /video/i.test(String(kid.type || ''));
        const slide = {
          n: i + 1,
          mediaType: isVideo ? 'video' : 'image',
          mediaUrl: isVideo ? mediaUrlOf(kid) : imageUrlOf(kid),
          imageText: '', imageTextStatus: 'not_attempted', imageTextError: null,
          speechText: '', speechStatus: 'not_attempted', speechError: null
        };

        const r = isVideo
          ? await ocrFromVideoUrl(slide.mediaUrl, dir, `s${i + 1}`, frameOpts)
          : await ocrFromImageUrl(slide.mediaUrl, dir, `s${i + 1}`);

        if (r.status === 'ok') {
          const dd = dedupeTexts(r.texts);
          slide.imageText = dd.map(d => d.text).join('\n');
          slide.imageTextStatus = 'ok';
        } else {
          slide.imageTextStatus = 'failed';
          slide.imageTextError  = r.error;
          errors.push(`اسلاید ${i + 1}: ${r.error}`);
        }

        if (isVideo) {
          const tr = readTranscript(kid);
          slide.speechText   = tr.text;
          slide.speechStatus = tr.status === 'ok' ? 'ok' : 'failed';
          slide.speechError  = tr.error;
        }

        item.slides.push(slide);
      }

      // متن کل پست از اسلایدها، با حذف تکرار ولی با حفظ شماره‌ی اسلاید
      const all = item.slides.flatMap(s =>
        s.imageText ? s.imageText.split('\n').map(t => ({ text: t, at: s.n })) : []);
      const dd = dedupeTexts(all);
      item.imageText = dd.map(d => `[اسلاید ${d.at}${d.alsoAt.length ? '،' + d.alsoAt.join('،') : ''}] ${d.text}`).join('\n');
      item.imageTextStatus = dd.length ? 'ok' : 'failed';
      if (!dd.length) item.imageTextError = 'در هیچ اسلایدی متنی خوانده نشد';

    } else {
      // ── تک‌عکس یا ریلز ──
      const v = mediaUrlOf(raw), im = imageUrlOf(raw);
      const r = (type === 'reel' && v)
        ? await ocrFromVideoUrl(v, dir, 'main', frameOpts)
        : await ocrFromImageUrl(im, dir, 'main');

      if (r.status === 'ok') {
        const dd = dedupeTexts(r.texts);
        item.imageText = dd.map(d =>
          d.at != null && type === 'reel' ? `[فریم ${d.at}] ${d.text}` : d.text).join('\n');
        item.imageTextStatus = 'ok';
      } else {
        item.imageTextStatus = 'failed';
        item.imageTextError  = r.error;
        errors.push(`متن روی تصویر: ${r.error}`);
      }
    }
  });

  // ── کامنت‌ها ──
  const inline = arr(raw, 'latestComments', 'comments').filter(c => typeof c === 'object');
  if (inline.length) {
    item.comments = inline.map(c => ({
      author: str(c, 'ownerUsername', 'owner', 'username'),
      text:   str(c, 'text', 'comment') || '',
      likes:  num(c, 'likesCount', 'likeCount')
    })).filter(c => isRealText(c.text));
    item.commentsStatus = item.comments.length ? 'ok' : 'failed';
  } else {
    item.commentsStatus = 'not_available';
  }

  const anyText = isRealText(item.caption) || isRealText(item.speechText) ||
                  isRealText(item.imageText) || item.slides.some(s => isRealText(s.imageText));
  item.extraction.status = errors.length === 0 ? 'ok' : (anyText ? 'partial' : 'failed');
  return item;
}

/** همه‌ی متن یک واحد محتوا، به‌ترتیب، برای فرستادن به مدل. */
export function itemToText(item) {
  const parts = [];
  if (isRealText(item.caption))    parts.push(`— کپشن —\n${item.caption}`);
  if (isRealText(item.speechText)) parts.push(`— گفتار داخل ویدئو —\n${item.speechText}`);
  if (item.slides.length) {
    for (const s of item.slides) {
      const bits = [];
      if (isRealText(s.imageText))  bits.push(s.imageText);
      if (isRealText(s.speechText)) bits.push(`(گفتار) ${s.speechText}`);
      if (bits.length) parts.push(`— اسلاید ${s.n} (${s.mediaType}) —\n${bits.join('\n')}`);
    }
  } else if (isRealText(item.imageText)) {
    parts.push(`— متن روی تصویر —\n${item.imageText}`);
  }
  if (item.comments.length)
    parts.push(`— کامنت‌ها (${item.comments.length}) —\n` +
               item.comments.slice(0, 20).map(c => `${c.author || '؟'}: ${c.text}`).join('\n'));
  return parts.join('\n\n');
}

/** چند واحد محتوا → متن خلاصه برای مرحله‌ی شناخت. */
export function itemsToText(items) {
  return items.map((it, i) => {
    const m = it.metrics || {};
    const stat = [m.likes != null ? `${m.likes} لایک` : null,
                  m.comments != null ? `${m.comments} کامنت` : null,
                  m.views != null ? `${m.views} بازدید` : null,
                  m.shares != null ? `${m.shares} اشتراک` : null].filter(Boolean).join(' · ');
    const head = `[${it.type || 'محتوا'} ${i + 1}`
               + (it.publishedAt ? ' · ' + it.publishedAt.slice(0, 10) : '')
               + (stat ? ' · ' + stat : '') + ']';
    const body = itemToText(it) || '(متنی استخراج نشد)';
    return `${head}\n${body}`;
  }).join('\n\n');
}

/** شکل ساده‌ی پست برای مرحله‌ی «شناخت محتوا» که از قبل وجود دارد. */
export function toLegacyPost(it) {
  const m = it.metrics || {};
  return {
    id: it.shortCode, url: it.sourceUrl, type: it.type,
    caption: it.caption || null,
    speech:  it.speechStatus === 'ok' ? it.speechText : null,
    onImage: it.imageTextStatus === 'ok' ? it.imageText : null,
    likes: m.likes, comments: m.comments, views: m.views, shares: m.shares,
    saves: null, reach: null,
    date: it.publishedAt, hashtags: it.hashtags || []
  };
}
