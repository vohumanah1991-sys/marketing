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
import { GATES } from '../prompts/vohuPrompts.js';

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
    // برشِ پنجره همراه عدد سفر می‌کند — دو هفته بعد، دقیقاً همان‌جاست که
    // بدون این جمله هر عددی موفقیت به نظر می‌رسد.
    baselineTrend: m.baselineTrend || null,
    // رسیدن، جدا از واکنش. بدون این، دو هفته بعد «کامنت ثابت ماند» را به پای
    // محتوا می‌نویسیم در حالی که شاید فقط کمتر دیده شده باشد.
    reach:      reachBaseline(m),
    competingExplanation: card.prediction?.reachConfound?.sentence || null,
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
 * خط پایه‌ی **رسیدن** — از همان عددهایی که کد شمرده بود.
 *
 * جدا از metric کارت نگه داشته می‌شود، حتی وقتی خودِ کارت دارد بازدید را
 * می‌سنجد: دو هفته بعد باید بشود این دو را کنار هم گذاشت، نه یکی‌شان را.
 * null یعنی هیچ پستی بازدید نداشت — صفر ساخته نمی‌شود.
 */
function reachBaseline(m) {
  const c = m?.countedFrom;
  if (!c) return null;
  const fromRecent = c.recent?.views != null;
  const block = fromRecent ? c.recent : c.all;
  if (block?.views == null) return null;
  return {
    metric: 'views', fa: 'بازدید',
    perPost: block.views,
    posts:   block.n?.views ?? block.posts,
    fromRecent
  };
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
    metric: f.metric, baseline: f.baseline, baselineTrend: f.baselineTrend || null,
    reach: f.reach || null, competingExplanation: f.competingExplanation || null,
    blindSpot: f.blindSpot,
    action: f.action, keyword: f.keyword
  };
}

/**
 * شمارش خودکار — کامنتِ منطبق **و** بازدید هر پست.
 *
 * چرا هر دو: با کامنتِ تنها، نتیجه قابل تفسیر نیست. «کامنت ثابت ماند» وقتی
 * بازدید نصف شده یعنی محتوا به‌ازای هر بیننده بهتر شده؛ همان عدد وقتی بازدید
 * ثابت مانده یعنی هیچ‌چیز عوض نشده. یک عدد، دو معنی — پس هر دو خوانده می‌شود.
 *
 * بازدید کلیدواژه لازم ندارد، پس حتی وقتی اقدام کلیدواژه ندارد باز هم خوانده
 * می‌شود: `count: null` با دلیلش برمی‌گردد ولی `reach` عدد دارد.
 *
 * ⚠ این یک فراخوان Apify است، یعنی پول. فقط وقتی صدا زده می‌شود که کاربر
 * روی صفحه‌ی «چه شد؟» باشد، نه در هر بار باز کردن اجرا. هر دو عدد از **همان
 * یک فراخوان** درمی‌آید — خواندن بازدید چیزی به هزینه اضافه نمی‌کند.
 */
export async function countComments(run, { limit = 12 } = {}) {
  const f = run?.followUp;
  if (!f) return { count: null, reach: null, why: 'پیش‌بینی‌ای ثبت نشده' };

  const src = (run.stages?.page?.sources || []).find(s => s.kind === 'instagram');
  if (!src?.url) return { count: null, reach: null, why: 'پیج اینستاگرامی برای خواندن نداریم' };

  let items = [];
  try {
    const r = await quickInstagram(src.url, { limit });
    items = r?.items || [];
  } catch (e) {
    return { count: null, reach: null, why: `خواندن دوباره‌ی پیج نشد: ${e.message}` };
  }
  if (!items.length) return { count: null, reach: null, why: 'این بار چیزی از پیج برنگشت' };

  const reach = reachNow(items, f.reach);

  // بدون کلیدواژه شمارشِ کامنت معنی ندارد — ولی بازدید معنی دارد و برمی‌گردد
  if (!f.keyword)
    return { count: null, reach, scanned: items.length,
             why: 'اقدام کلیدواژه‌ی مشخصی ندارد که بشود شمرد — ولی بازدید خوانده شد' };

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
    return { count: null, reach, why: `از ${scanned} محتوا، کامنتی خوانده نشد — عدد ساخته نمی‌شود`, scanned };

  return { count: matched, reach, scanned, withComments, keyword: f.keyword };
}

/**
 * بازدیدِ **امروز**، به‌ازای هر پست — و مقایسه‌اش با خط پایه‌ی همان لحظه‌ی تأیید.
 *
 * `was` همان چیزی است که startFollowUp ثبت کرده بود. اگر نداشتیمش، عدد امروز
 * تنها برمی‌گردد بدون حکم — مقایسه با چیزی که نداریم، حدس است نه سنجش.
 */
function reachNow(items, was) {
  const vs = items.map(i => i.metrics?.views)
                  .filter(v => v != null && Number.isFinite(Number(v))).map(Number);
  if (!vs.length) return null;                      // هیچ پستی بازدید نداشت — صفر ساخته نمی‌شود

  const perPost = Math.round(vs.reduce((a, b) => a + b, 0) / vs.length);
  const out = { perPost, posts: vs.length, was: was?.perPost ?? null };
  if (out.was == null) return { ...out, note: 'خط پایه‌ی بازدید ثبت نشده بود — فقط عدد امروز' };

  const ratio = out.was === 0 ? null : Number((perPost / out.was).toFixed(2));
  const dir = perPost > out.was ? 'up' : perPost < out.was ? 'down' : 'flat';
  return { ...out, ratio, direction: dir,
           note: `بازدید هر پست: ${perPost} امروز در برابر ${out.was} در زمان تأیید`
               + (dir === 'down' ? ' — کمتر دیده شده، پس واکنشِ ثابت یعنی محتوا بهتر شده نه بدتر'
                : dir === 'up'   ? ' — بیشتر دیده شده، پس بخشی از رشدِ واکنش می‌تواند از رسیدن باشد'
                :                  ' — رسیدن تکان نخورده، پس واکنش را می‌شود به محتوا نسبت داد') };
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

  // «تقصیرِ رسیدن بود» فقط با عددی که واقعاً شمرده شده — وگرنه به weakened
  // برمی‌گردد. بدون این سد، هر شکستی می‌تواند پشت افت رسیدن پنهان شود.
  const attr = GATES.checkAttribution(learned?.data, observations);
  if (attr.downgraded?.length)
    console.log('  ⚠ انتساب بی‌پشتوانه برگردانده شد: '
      + attr.downgraded.map(d => `${d.hypothesis} → weakened`).join(' · '));

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

  if (attr.downgraded?.length) f.attributionDowngraded = attr.downgraded;

  await saveMemory(run.url, merged);
  return { outcome, performance: perf.report, learning: learned?.data || null, memory: merged,
           attributionDowngraded: attr.downgraded || [] };
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
