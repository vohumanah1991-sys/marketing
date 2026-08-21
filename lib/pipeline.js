/**
 * ارکستراتور وُهو — کل مسیر، به ترتیب، با دروازه‌ها.
 *
 * این تنها جایی است که ترتیب مراحل تعریف شده. هیچ‌جای دیگری تصمیم نمی‌گیرد
 * چه چیزی بعد از چه چیزی می‌آید — که یعنی مسیر قابل تست و قابل پیش‌بینی است.
 *
 * `io` رابط گفتگو با کاربر است. برای CLI یک پیاده‌سازی، برای HTTP یکی دیگر.
 * پایپ‌لاین نمی‌داند در کدام محیط اجرا می‌شود.
 */

import { fetchPageText } from '../services/fetchPage.js';
import { callWithSchema } from '../services/vohuService.js';
import { loadRun, saveRun } from '../services/store.js';
import {
  EXTRACTION_PROMPT,        EXTRACTION_SCHEMA,
  COMPETITOR_PROMPT,        COMPETITOR_SCHEMA,
  CONTENT_ANALYSIS_PROMPT,  CONTENT_ANALYSIS_SCHEMA,
  MARKET_PROMPT,            MARKET_SCHEMA,
  CAMPAIGN_PROMPT,          CAMPAIGN_SCHEMA,
  PERFORMANCE_PROMPT,       PERFORMANCE_SCHEMA,
  FIRST_INSIGHT_PROMPT,     FIRST_INSIGHT_SCHEMA,
  QUESTIONS_PROMPT,         QUESTIONS_SCHEMA,
  STRATEGY_CARD_PROMPT,     STRATEGY_CARD_SCHEMA,
  EVIDENCE_GATE_PROMPT,     EVIDENCE_GATE_SCHEMA,
  LEARNING_PROMPT,          LEARNING_SCHEMA,
  mergeAnswers, GATES, MISSION, upcomingOccasions, realisticCapacity, countedBaseline, evidenceStrength, threadFatigue, condenseMemory, knowledgeFor
} from '../prompts/vohuPrompts.js';

export async function runPipeline({ url, note, posts = [], io, resume = true }) {
  const run = resume ? await loadRun(url) : { url, stages: {} };
  run.mission = MISSION;
  const usage = [];

  const step = async (name, fn) => {
    // `in` نه truthy — مرحله‌ای که به‌درستی null برگردانده (مثلاً رقیبی داده نشد)
    // هم انجام‌شده حساب می‌شود، وگرنه هر بار دوباره از کاربر می‌پرسد.
    if (name in run.stages) { io.log(`↺ ${name} — از قبل انجام شده`); return run.stages[name]; }
    io.log(`▶ ${name}`);
    const t0 = Date.now();
    const out = await fn();
    run.stages[name] = out;
    usage.push({ name, ms: Date.now() - t0 });
    await saveRun(run);
    return out;
  };

  // ═══ ۱ · خواندن صفحه ═══
  const page = await step('page', async () => {
    const p = await fetchPageText(url);
    if (!p.ok) throw new Error(`صفحه خوانده نشد: ${p.error}`);
    return p;
  });

  // ═══ ۲ · شناخت کسب‌وکار ═══
  let knowledge = await step('knowledge', async () =>
    (await callWithSchema({
      prompt: EXTRACTION_PROMPT({ pageContent: page.text, userNote: note }),
      schema: EXTRACTION_SCHEMA, toolName: 'business_knowledge'
    })).data);

  // ═══ ۳ · رقبا — تنها سؤالی که پرسیدنش هیچ دافعه‌ای ندارد ═══
  const competitorMap = await step('competitors', async () => {
    const urls = await io.askCompetitors();
    if (!urls?.length) { io.log('  رقیبی داده نشد — دو الگو خاموش می‌مانند'); return null; }

    const fetched = [];
    for (const u of urls) {
      const p = await fetchPageText(u);
      if (p.ok) fetched.push({ name: u, url: u, content: p.text.slice(0, 12000) });
      else io.log(`  ! ${u} خوانده نشد: ${p.error}`);
    }
    if (!fetched.length) return null;

    return (await callWithSchema({
      prompt: COMPETITOR_PROMPT({ knowledge, competitors: fetched }),
      schema: COMPETITOR_SCHEMA, toolName: 'playing_field'
    })).data;
  });

  // ═══ ۴ · محتوای قبلی — اختیاری ═══
  const contentAnalysis = posts.length
    ? await step('content', async () =>
        (await callWithSchema({
          prompt: CONTENT_ANALYSIS_PROMPT({ knowledge, posts, hasMetrics: posts.some(p => p.likes != null) }),
          schema: CONTENT_ANALYSIS_SCHEMA, toolName: 'content_analysis'
        })).data)
    : null;

  // ═══ ۵ · شناخت بازار — کِی و چه نگویم ═══
  // بعد از رقبا و محتوا، چون بیشترش از همان‌ها استنباط می‌شود نه از تحقیق تازه.
  const market = await step('market', async () =>
    (await callWithSchema({
      prompt: MARKET_PROMPT({
        knowledge: knowledgeFor('market', knowledge), competitorMap, contentAnalysis,
        userSaid: (knowledge.userStated || []).map(u => u.value),
        today: new Date().toISOString().slice(0, 10)
      }),
      schema: MARKET_SCHEMA, toolName: 'market', maxTokens: 12000
    })).data);

  // فاصله تا مناسبت‌ها را کد حساب می‌کند، نه مدل
  const soon = upcomingOccasions(market).filter(o => o.daysUntil <= 60);
  if (soon.length) io.log(`  نزدیک‌ترین مناسبت: ${soon[0].occasion} — ${soon[0].daysUntil} روز دیگر`);

  // ═══ ۶ · جمله‌ی اول ═══
  const insight = await step('insight', async () =>
    (await callWithSchema({
      prompt: FIRST_INSIGHT_PROMPT({ knowledge, competitorMap, contentAnalysis, market }),
      schema: FIRST_INSIGHT_SCHEMA, toolName: 'first_insight'
    })).data);

  // ── دروازه: آیا اصلاً نشانش بدهیم؟ ──
  const insightGate = GATES.canShowInsight(insight);
  if (!insightGate.pass) {
    io.log(`\n⛔ اطمینان ${insight.confident} زیر آستانه است. جمله نشان داده نمی‌شود.`);
    io.show({ type: 'need_more', message: insight.fallback });
    return { run, knowledge, stopped: 'low_confidence' };
  }
  io.show({ type: 'insight', ...insight.chosen, supporting: insight.supporting, scope: insight.scope });

  // ═══ ۷ · سؤال‌ها و حدس‌ها ═══
  const q = await step('questions', async () =>
    (await callWithSchema({
      prompt: QUESTIONS_PROMPT({ knowledge: knowledgeFor('questions', knowledge), mission: 'ساخت برنامه‌ی یک ماه آینده' }),
      schema: QUESTIONS_SCHEMA, toolName: 'questions'
    })).data);

  // جواب‌ها هم یک مرحله‌اند — وگرنه در ادامه‌ی اجرا دوباره از کاربر پرسیده می‌شوند
  const replies = await step('replies', async () => io.askQuestions(q));

  // ⚠️ حیاتی — بدون این، دروازه‌ی شواهد گفته‌های خود کاربر را بی‌پشتوانه می‌داند
  knowledge = mergeAnswers(knowledge, replies);

  // فشرده‌سازی قطعی، در کد — قبل از مرحله‌های سنگین
  const cm = condenseMemory(knowledge);
  if (cm.condensed) {
    io.log(`  حافظه فشرده شد: ${cm.condensed} گزاره‌ی قدیمی → ۱ خلاصه`);
    knowledge = cm.knowledge;
  }
  run.stages.knowledge = knowledge;
  await saveRun(run);

  // ═══ ۸ · کارت استراتژی ═══
  // خط پایه را کد می‌شمارد و به مدل می‌دهد — نه برعکس. بدون این، کارت هیچ
  // عددی جلوی چشمش ندارد و «خط پایه» همیشه null می‌ماند.
  const baselines = countedBaseline(posts);
  const card = await step('strategy', async () => {
    const c = (await callWithSchema({
      prompt: STRATEGY_CARD_PROMPT({
        knowledge: knowledgeFor('strategy', knowledge), insight: insight.chosen.sentence,
        answers: replies.answers, constraints: replies.constraints || [],
        // شمارش کار کد است — مدل فقط حکم را می‌گیرد
        fatigue: [...new Set((knowledge.learningMemory?.campaignHistory || []).map(c => c.target))]
          .map(t => threadFatigue(knowledge.learningMemory.campaignHistory, t))
          .filter(f => f.verdict),
        baselines
      }),
      schema: STRATEGY_CARD_SCHEMA, toolName: 'strategy_card', maxTokens: 12000
    })).data;
    const bl = GATES.fillBaseline(c, baselines);
    if (bl.filled)
      io.log(`  خط پایه از آمار پست‌ها پر شد: ${bl.filled.value} ${bl.filled.metric} در هر پست (${bl.filled.scope})`);
    else if (baselines) io.log(`  ⚠ خط پایه پر نشد با اینکه عدد داشتیم — ${bl.reason}`);
    if (bl.trend) io.log(`  ⚠ ${bl.trend}`);

    // توضیحِ رقیب — اگر رسیدن افت کرده و واکنش ثابت مانده، «چه چیزی ابطال می‌شود»
    // باید خودش بگوید که فقط محتوا سنجیده نمی‌شود. این را کد می‌نویسد، نه ادبِ مدل.
    const ce = GATES.addCompetingExplanation(c, baselines);
    if (ce.added) io.log(`  ⚠ توضیح رقیب به «چه چیزی ابطال می‌شود» اضافه شد: ${ce.confound.reach.recent} در برابر ${ce.confound.reach.all} بازدید در هر پست`);
    return c;
  });

  // برچسب fact بدون نقل‌قولِ پیدا‌شدنی، به قول برمی‌گردد — قبل از نمایش،
  // نه بعدش. کاربر نباید یک لحظه هم «واقعیت» ببیند که واقعیت نیست.
  const cellFix = GATES.checkCellOrigins(card, run.stages.page?.text || '');
  if (!cellFix.pass) {
    card.originFixes = cellFix.changed;
    io.log('  ⚠ برچسب اصلاح شد: '
      + cellFix.changed.map(c => `${c.cell} ${c.from}→${c.to} (${c.why})`).join(' · '));
  }

  io.show({ type: 'strategy', card });

  // ── دروازه: بدون تأیید، محتوا ساخته نمی‌شود ──
  const approved = await io.approveCard(card);
  if (!approved) return { run, knowledge, card, stopped: 'not_approved' };

  card.approvedAt = new Date().toISOString();
  run.stages.strategy = card;
  await saveRun(run);

  // ═══ ۹ · طراحی کمپین ═══
  // ظرفیت در کد حساب می‌شود، نه در مدل. پنجره از خود کارت می‌آید.
  const capacity = realisticCapacity({
    statedPerWeek: replies.answers?.piecesPerWeek ?? io.statedPerWeek ?? 2,
    card,
    history: run.history || []
  });
  io.log(`  ظرفیت: ${capacity.statedTotal} قطعه اگر حرف کاربر درست باشد → ${capacity.realisticTotal} واقع‌بینانه`);

  const campaign = await step('campaign', async () => {
    const out = (await callWithSchema({
      prompt: CAMPAIGN_PROMPT({
        card, knowledge: knowledgeFor('campaign', knowledge), contentAnalysis, market,
        occasions: upcomingOccasions(market), capacity
      }),
      schema: CAMPAIGN_SCHEMA, toolName: 'campaign', maxTokens: 12000
    })).data;
    // عددهایی که کد می‌داند را خودش می‌گذارد، از مدل نمی‌پرسد
    out.capacityCheck = { ...capacity, planned: out.pieces?.length ?? 0 };

    // و هر برشی که خورده، نوشته می‌شود — کدام و چرا
    const cuts = GATES.checkCuts(out, capacity);
    out.cuts = cuts.cuts;
    out.cutsUnexplained = cuts.unexplained;
    for (const x of cuts.cuts)
      io.log(`  ✂ ${x.what}: ${x.from} → ${x.to} (${x.count} کمتر) — ${x.why || 'دلیل نوشته نشد'}`);
    for (const x of cuts.unexplained) io.log(`  ⚠ برشِ بی‌دلیل — ${x.what}: ${x.why}`);
    return out;
  });

  io.show({ type: 'campaign', campaign });

  io.log(`\n✓ آماده. حالا برای هر قطعه محتوا بساز — با جریان خودت.`);
  io.log(`  قبل از انتشار حتماً checkContent() را صدا بزن.`);

  return { run, knowledge, card, campaign, market, soon, usage };
}

/**
 * دروازه‌ی شواهد — جدا از پایپ‌لاین، چون بعد از تولید محتوا صدا زده می‌شود.
 * این آخرین ایست است و هرگز نباید دور زده شود.
 *
 * و چون آخرین ایست است، حکمش **بخشی از رکورد اجراست** — نه چیزی که یک بار
 * روی صفحه دیده می‌شود و می‌رود. تا امروز همین بود: گزارش برمی‌گشت، رابط
 * نشانش می‌داد، و بعد هیچ‌جا نمی‌ماند. یعنی دو هفته بعد نمی‌شد گفت این متن
 * اصلاً از دروازه رد شده بود یا نه، و اگر رد شده با چه ادعاهایی.
 *
 * `run` که داده شود، هر بررسی در `run.evidenceChecks` می‌نشیند: متن ورودی،
 * حکم، و زمان. `report` دست‌نخورده ذخیره می‌شود — همان شکلی که مدل داده،
 * چون همین شکل است که بعداً به درد بازبینی (و fixture) می‌خورد.
 */
/**
 * چند بررسی روی اجرا می‌ماند.
 *
 * برخلاف تحلیل محتوا، این سقف برای «کم‌کردن» نیست: با پنج تستر هیچ اجرایی
 * به دویست بررسی نمی‌رسد. سقف فقط برای آن است که اگر روزی حلقه‌ای اشتباه
 * دروازه را پشت سر هم صدا زد، فایل اجرا بی‌نهایت رشد نکند.
 *
 * پس عمداً بزرگ است: حکمِ دروازه رکورد است و رکورد باید بماند.
 */
export const KEEP_EVIDENCE_CHECKS = 200;

export async function checkContent({ content, knowledge, market, run = null }) {
  const { data } = await callWithSchema({
    prompt: EVIDENCE_GATE_PROMPT({ content, knowledge, market, today: new Date().toISOString().slice(0, 10) }),
    schema: EVIDENCE_GATE_SCHEMA, toolName: 'evidence_gate', maxTokens: 12000
  });
  const gate = GATES.canPublish(data);

  if (run) {
    // متن کامل می‌ماند، بریده نمی‌شود: رکوردی که نگوید *چه چیزی* سنجیده شده،
    // حکمش هم قابل بازخوانی نیست.
    const all = [...(run.evidenceChecks || []),
      { at: new Date().toISOString(), content, verdict: data.verdict, gate, report: data }];
    run.evidenceChecks = all.slice(-KEEP_EVIDENCE_CHECKS);
    // و اگر روزی به سقف خورد، همان‌جا نوشته می‌شود که چند حکم از رکورد افتاد
    if (all.length > KEEP_EVIDENCE_CHECKS)
      run.evidenceChecksDropped =
        (run.evidenceChecksDropped || 0) + (all.length - KEEP_EVIDENCE_CHECKS);
    await saveRun(run);
  }

  return { report: data, gate };
}

/**
 * خواندن نتیجه — بعد از انتشار، قبل از یادگیری.
 *
 * حکم کفایت شواهد را کد صادر می‌کند و به مدل می‌دهد.
 * مدل خودش تشخیص نمی‌دهد که چه ادعایی مجاز است — این ریاضی است نه قضاوت.
 */
export async function readPerformance({ campaign, observations, previousPatterns = [] }) {
  const counted = (observations || []).filter(o => o.how === 'counted');

  const nums = counted
    .map(o => Number(String(o.note).match(/\d+/)?.[0]))
    .filter(n => Number.isFinite(n) && n > 0);
  const gap = nums.length >= 2 ? Math.max(...nums) / Math.min(...nums) : 1;

  const strength = evidenceStrength({
    samples: campaign?.pieces?.length || 0,
    variantsCompared: campaign?.varies ? 1 : 2,
    biggestGapRatio: gap
  });

  const { data } = await callWithSchema({
    prompt: PERFORMANCE_PROMPT({ campaign, observations, strength, previousPatterns }),
    schema: PERFORMANCE_SCHEMA, toolName: 'performance', maxTokens: 12000
  });

  return { report: data, strength };
}

/**
 * یادگیری — ورودی‌اش خروجی readPerformance است، نه مشاهده‌ی خام.
 * اگر عملکرد گفته چیزی خواندنی نیست، اصلاً صدا زده نمی‌شود.
 */
export async function learn({ card, prediction, userAnswer, userReason, edits,
                              hypothesisHistory = [], performance, operationalLevelAtRun }) {
  if (performance?.report?.nothingToRead) {
    return { skipped: true, reason: 'هیچ داده‌ای برای خواندن نبود — حافظه دست‌نخورده ماند' };
  }
  const { data, meta } = await callWithSchema({
    prompt: LEARNING_PROMPT({ card, prediction, userAnswer, userReason, edits,
                              hypothesisHistory, operationalLevelAtRun }),
    schema: LEARNING_SCHEMA, toolName: 'learning', maxTokens: 8000
  });
  // حافظه‌ی یادگیری هم مهر سازنده‌اش را با خود می‌برد — یک درس که با مدل دیگری
  // نوشته شده باید بعداً قابل تشخیص باشد. (callWithSchema خودش data را مهر
  // می‌زند؛ اینجا فقط صریح می‌ماند که این قاعده برای یادگیری هم هست.)
  if (data && typeof data === 'object' && !data.producedBy)
    data.producedBy = { provider: meta?.provider, model: meta?.model, at: new Date().toISOString() };
  return { data };
}
