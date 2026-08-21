/**
 * تحلیل محتوای استخراج‌شده با مدل.
 *
 * ترتیب اجباری: استخراج (Apify + transcript + OCR) → بعد تحلیل.
 * مدل هیچ‌وقت مستقیم با اینستاگرام حرف نمی‌زند و هیچ‌وقت چیزی را که
 * استخراج نشده «حدس» نمی‌زند — در پرامپت صریح آمده که نخوانده ≠ نبوده.
 *
 * مدل همان VOHU_MODEL است (تصمیم امروز: Sonnet 5).
 */

import { callWithSchema } from '../services/vohuService.js';
import { CONTENT_ITEM_PROMPT, CONTENT_ITEM_SCHEMA } from '../prompts/vohuPrompts.js';
import { itemToText } from './instagram.js';

/** میانه‌ی آمار پیج — برای اینکه «خوب بود» معنی داشته باشد. */
export function pageMedians(items) {
  const med = key => {
    const v = items.map(i => i.metrics?.[key]).filter(x => typeof x === 'number').sort((a, b) => a - b);
    if (v.length < 5) return null;               // نمونه‌ی کم = مقایسه‌ی بی‌اعتبار
    return v[Math.floor(v.length / 2)];
  };
  const out = { likes: med('likes'), comments: med('comments'), views: med('views'), shares: med('shares') };
  return Object.values(out).some(x => x != null) ? { ...out, sampleSize: items.length } : null;
}

export async function analyzeItem(item, { medians = null } = {}) {
  const text = itemToText(item);
  if (!text.trim()) {
    return { skipped: true, reason: 'هیچ متنی استخراج نشده بود — تحلیل بی‌معنی است' };
  }
  const { data } = await callWithSchema({
    prompt: CONTENT_ITEM_PROMPT({ item: { ...item, __text: text }, metricsContext: medians }),
    schema: CONTENT_ITEM_SCHEMA,
    toolName: 'content_item',
    maxTokens: 6000
  });
  return data;
}

/**
 * چند تحلیل روی اجرا می‌ماند. سقف است، نه سلیقه: هر تحلیل چند صد بایت است و
 * استخراج‌ها روی هم جمع می‌شوند — بدون سقف، فایل اجرا بی‌حساب بزرگ می‌شود.
 */
export const KEEP_ANALYSES = 20;

/**
 * تحلیل یک دسته، یکی‌یکی، با گزارش پیشرفت.
 *
 * `run` که داده شود، تحلیل‌ها روی خود اجرا هم می‌نشینند — تا امروز خروجی این
 * تابع فقط در نتیجه‌ی یک کار پس‌زمینه می‌ماند و با آن کار هم می‌رفت. چیزی که
 * مدل درباره‌ی محتوای این کسب‌وکار فهمیده، باید در رکورد همان کسب‌وکار بماند.
 *
 * فقط **۲۰ تای آخر** نگه داشته می‌شود، و آنچه می‌افتد بی‌صدا نمی‌افتد:
 * `run.contentAnalysesDropped` می‌شمارد چند تا از رکورد بیرون رفته‌اند.
 */
export async function analyzeItems(items, report = async () => {}, { run = null } = {}) {
  const medians = pageMedians(items);
  const out = [];
  for (const [i, it] of items.entries()) {
    try {
      out.push({ shortCode: it.shortCode, analysis: await analyzeItem(it, { medians }) });
    } catch (e) {
      out.push({ shortCode: it.shortCode, error: e.message });
    }
    await report({ done: i + 1, total: items.length, note: `تحلیل ${i + 1} از ${items.length}` });
  }

  if (run) {
    const at = new Date().toISOString();
    const all = [...(run.contentAnalyses || []), ...out.map(r => ({ at, medians, ...r }))];
    run.contentAnalyses = all.slice(-KEEP_ANALYSES);
    if (all.length > KEEP_ANALYSES)
      run.contentAnalysesDropped = (run.contentAnalysesDropped || 0) + (all.length - KEEP_ANALYSES);
    const { saveRun } = await import('../services/store.js');
    await saveRun(run);
  }

  return { medians, results: out };
}
