/**
 * نیمه‌ی دوم حلقه: «چه شد؟»
 *
 * کارت تأیید می‌شود، کمپین ساخته می‌شود، و بعد… هیچ. تا امروز اجرا همان‌جا
 * تمام می‌شد: readPerformance و learn نوشته شده بودند ولی از هیچ‌جا صدا زده
 * نمی‌شدند. یعنی پیش‌بینیِ «دو هفته بعد همین را می‌پرسم» هرگز پرسیده نمی‌شد.
 *
 * چهار کار اینجا انجام می‌شود:
 *   ۱. وقتی کارت تأیید شد، پیش‌بینی و سررسیدش را روی اجرا می‌نشاند.
 *   ۲. می‌گوید سررسید رسیده یا نه.
 *   ۳. اگر اقدام کامنتی است، خودش می‌شمارد. اگر نه، از کاربر می‌پرسد.
 *   ۴. readPerformance → learn → حافظه‌ی کسب‌وکار.
 *
 * قاعده‌ی ۶ در تمام این فایل: **عددی که نداریم null می‌ماند.** صفر یعنی
 * «شمردم و هیچ نبود» و آن ادعای دیگری است.
 */

import { readPerformance, learn } from './pipeline.js';
import { loadMemory, saveMemory, mergeLearning } from '../services/memory.js';
import { quickInstagram } from './igSync.js';

export const FOLLOW_UP_DAYS = 14;

/**
 * لحظه‌ی تأیید کارت — تنها جایی که می‌دانیم چه چیزی قرار است سنجیده شود.
 *
 * بعد از این، کارت ممکن است عوض شود یا کمپین بازنویسی شود؛ آنچه اینجا ثبت
 * می‌شود همان چیزی است که کاربر رویش «تأیید» زد. سنجیدنِ چیزی جز این، تقلب است.
 */
export function startFollowUp(run, { now = Date.now() } = {}) {
  const card = run?.stages?.strategy;
  if (!card?.prediction?.observable) return null;

  const days = Number(card.prediction.checkAfterDays) || FOLLOW_UP_DAYS;
  const m = card.measurement || {};

  run.followUp = {
    startedAt:  new Date(now).toISOString(),
    dueAt:      new Date(now + days * 864e5).toISOString(),
    days,
    observable: card.prediction.observable,
    // از measurement — همان چیزی که قاعده‌ی «جواب داد باید شمردنی باشد» ساخت
    countable:  m.countable === true,
    metric:     m.metric || null,
    baseline:   m.baseline ?? null,
    blindSpot:  m.blindSpot || null,
    action:     card.cells?.action?.value || null,
    // کلیدواژه‌ی شمارش را از خود اقدام درمی‌آوریم؛ نبودش یعنی دستی می‌پرسیم
    keyword:    actionKeyword(card.cells?.action?.value),
    target:     run.stages?.insight?.chosen?.pattern || null,
    approach:   card.recommended?.title || null,
    answeredAt: null
  };
  return run.followUp;
}

/**
 * کلیدواژه‌ای که باید در کامنت‌ها دنبالش بگردیم.
 *
 * اقدام‌های شمردنی معمولاً یک کلمه‌ی مشخص دارند: «در کامنت بنویس **اصالت**».
 * همان داخل گیومه یا «کلمه‌ی X» است. اگر پیدا نشد null برمی‌گردد و شمارش
 * خودکار انجام نمی‌شود — حدس‌زدن کلیدواژه یعنی شمردن چیز اشتباه، که از
 * نشمردن بدتر است.
 */
export function actionKeyword(actionText) {
  const t = String(actionText || '');
  if (!/کامنت/.test(t)) return null;                 // اقدام کامنتی نیست
  const quoted = t.match(/[«"']([^»"']{2,24})[»"']/);
  if (quoted) return quoted[1].trim();
  const named = t.match(/کلمه(?:‌ی|ی)?\s+([^\s،.]{2,24})/);
  if (named) return named[1].trim();
  return null;
}

/** سررسید رسیده؟ سه حالت، نه دو تا — «هنوز نه» با «تمام شده» یکی نیست. */
export function followUpStatus(run, { now = Date.now() } = {}) {
  const f = run?.followUp;
  if (!f) return { state: 'none' };
  if (f.answeredAt) return { state: 'done', at: f.answeredAt, dueAt: f.dueAt };
  const due = new Date(f.dueAt).getTime();
  const daysLeft = Math.ceil((due - now) / 864e5);
  return {
    state: now >= due ? 'due' : 'waiting',
    dueAt: f.dueAt, daysLeft,
    observable: f.observable, countable: f.countable,
    metric: f.metric, baseline: f.baseline, blindSpot: f.blindSpot,
    action: f.action, keyword: f.keyword
  };
}

/**
 * شمارش خودکار کامنت‌های منطبق.
 *
 * فقط وقتی معنی دارد که اقدام کامنتی باشد و کلیدواژه‌ای داشته باشیم.
 * هر حالت دیگری `count: null` برمی‌گرداند با دلیلش — و رابط همان دلیل را
 * به کاربر می‌گوید و دستی می‌پرسد.
 *
 * ⚠ این یک فراخوان Apify است، یعنی پول. فقط وقتی صدا زده می‌شود که کاربر
 * روی صفحه‌ی «چه شد؟» باشد، نه در هر بار باز کردن اجرا.
 */
export async function countComments(run, { limit = 12 } = {}) {
  const f = run?.followUp;
  if (!f) return { count: null, why: 'پیش‌بینی‌ای ثبت نشده' };
  if (!f.keyword) return { count: null, why: 'اقدام کلیدواژه‌ی مشخصی ندارد که بشود شمرد' };

  const src = (run.stages?.page?.sources || []).find(s => s.kind === 'instagram');
  if (!src?.url) return { count: null, why: 'پیج اینستاگرامی برای خواندن نداریم' };

  let items = [];
  try {
    const r = await quickInstagram(src.url, { limit });
    items = r?.items || [];
  } catch (e) {
    return { count: null, why: `خواندن دوباره‌ی پیج نشد: ${e.message}` };
  }
  if (!items.length) return { count: null, why: 'این بار چیزی از پیج برنگشت' };

  const needle = normFa(f.keyword);
  let matched = 0, scanned = 0, withComments = 0;
  for (const it of items) {
    const list = it.comments || [];
    scanned++;
    if (list.length) withComments++;
    for (const c of list) if (normFa(c.text).includes(needle)) matched++;
  }

  // پستی که کامنتش خوانده نشده با پستی که کامنت ندارد یکی نیست.
  // اگر هیچ پستی کامنت نداشت، «۰» یک ادعای بی‌پشتوانه است.
  if (!withComments)
    return { count: null, why: `از ${scanned} محتوا، کامنتی خوانده نشد — عدد ساخته نمی‌شود`, scanned };

  return { count: matched, scanned, withComments, keyword: f.keyword };
}

/**
 * بستن حلقه: مشاهده‌ها → readPerformance → learn → حافظه‌ی کسب‌وکار.
 *
 * ورودی `observations` همان شکلی است که PERFORMANCE_PROMPT می‌شناسد:
 * `{ what, note, how }` که how یکی از counted/user_said/guess است.
 *
 * campaignHistory را **کد** می‌سازد، نه مدل: threadFatigue روی همین حساب
 * می‌کند و اگر مدل هر بار جور دیگری اسم بگذارد، هیچ نخی هرگز خسته نمی‌شود.
 */
export async function closeLoop(run, { observations = [], userAnswer = null, userReason = null,
                                       edits = [], now = Date.now() } = {}) {
  const card = run?.stages?.strategy;
  const f = run?.followUp;
  if (!card || !f) throw new Error('این اجرا پیش‌بینی ثبت‌شده‌ای ندارد — اول کارت را تأیید کن');

  const mem = await loadMemory(run.url);

  const perf = await readPerformance({
    campaign: run.stages?.campaign,
    observations,
    previousPatterns: mem.contentPatterns || []
  });

  // «چیزی خواندنی نبود» یعنی فرضیه‌ای جابه‌جا نمی‌شود — ولی تاریخچه ثبت
  // می‌شود. آزمایشی که نتیجه نداد هم یک بار امتحان‌شدن است.
  const learned = perf.report?.nothingToRead
    ? { skipped: true, reason: 'خروجی خواندنی نبود' }
    : await learn({ card, prediction: f.observable, userAnswer, userReason, edits,
                    hypothesisHistory: mem.hypotheses || [], performance: perf });

  const outcome = outcomeOf(perf.report, learned?.data);

  const merged = mergeLearning(mem, {
    learning: learned?.data || null,
    campaignEntry: {
      target:   f.target || 'نامعلوم',
      approach: f.approach || 'نامعلوم',
      outcome,                                   // ← حتی وقتی جواب نداده
      observable: f.observable,
      countedMetric: f.metric || null,
      at: new Date(now).toISOString()
    },
    askedQuestions: askedFrom(run)
  });

  f.answeredAt = new Date(now).toISOString();
  f.outcome = outcome;

  await saveMemory(run.url, merged);
  return { outcome, performance: perf.report, learning: learned?.data || null, memory: merged };
}

/**
 * حکم یک دور — از احکام فرضیه‌ها، نه از حس.
 * هیچ‌کدام supported نبود ولی چیزی خوانده شد → inconclusive، نه شکست.
 */
function outcomeOf(report, learning) {
  if (report?.nothingToRead) return 'inconclusive';
  const verdicts = (learning?.hypothesisUpdates || []).map(u => u.verdict);
  if (verdicts.includes('supported')) return 'supported';
  if (verdicts.includes('contradicted')) return 'contradicted';
  if (verdicts.includes('weakened')) return 'weakened';
  return 'inconclusive';
}

/** سؤال‌های همین دور، با جوابشان — تا دور بعد دوباره پرسیده نشوند. */
function askedFrom(run) {
  const qs = run.stages?.questions?.questions || [];
  const answers = run.stages?.replies?.answers || run.input?.replies?.answers || {};
  return qs.map((q, i) => ({ question: q.question, answer: answers['q' + (i + 1)] ?? null }));
}

const normFa = (s) => String(s ?? '')
  .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک')
  .replace(/[‌‎‏]/g, ' ')
  .replace(/\s+/g, ' ').trim().toLowerCase();
