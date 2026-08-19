/**
 * ماشین حالت وُهو — نسخه‌ی وب.
 *
 * فرق اصلی با CLI: به‌جای callback، هر بار تا جایی جلو می‌رود که
 * به چیزی از کاربر نیاز پیدا کند، بعد می‌ایستد و می‌گوید چه می‌خواهد.
 *
 *   advance(run) → { state, needs, data }
 *
 * needs یکی از این‌هاست: competitors | answers | approval | null
 */

import { fetchPageText } from '../services/fetchPage.js';
import { callWithSchema } from '../services/vohuService.js';
import { loadRun, saveRun } from '../services/store.js';
import {
  EXTRACTION_PROMPT, EXTRACTION_SCHEMA,
  COMPETITOR_PROMPT, COMPETITOR_SCHEMA,
  MARKET_PROMPT, MARKET_SCHEMA,
  FIRST_INSIGHT_PROMPT, FIRST_INSIGHT_SCHEMA,
  QUESTIONS_PROMPT, QUESTIONS_SCHEMA,
  STRATEGY_CARD_PROMPT, STRATEGY_CARD_SCHEMA,
  CAMPAIGN_PROMPT, CAMPAIGN_SCHEMA,
  mergeAnswers, knowledgeFor, condenseMemory, threadFatigue,
  realisticCapacity, upcomingOccasions, GATES, MISSION
} from '../prompts/vohuPrompts.js';

const call = (prompt, schema, toolName, maxTokens = 8000) =>
  callWithSchema({ prompt, schema, toolName, maxTokens }).then(r => r.data);

export async function startRun({ url, note }) {
  const run = { id: id(), url, note, mission: MISSION, stages: {}, input: {},
                createdAt: new Date().toISOString() };
  await saveRun(run);
  return run;
}

export async function getRun(url) { return loadRun(url); }

/**
 * یک قدم جلو می‌رود. هر بار که چیزی از کاربر لازم باشد می‌ایستد.
 * قابل صدا زدن چندباره — مرحله‌های انجام‌شده دوباره اجرا نمی‌شوند.
 */
export async function advance(run) {
  const S = run.stages;
  const done = n => n in S;

  // ── ۱ · خواندن صفحه ──
  if (!done('page')) {
    const p = await fetchPageText(run.url);
    S.page = p.ok ? p : { ok: false, error: p.error, text: '(صفحه خوانده نشد — ' + p.error + ')' };
    await saveRun(run);
  }

  // ── ۲ · شناخت ──
  if (!done('knowledge')) {
    S.knowledge = await call(
      EXTRACTION_PROMPT({ pageContent: S.page.text, userNote: run.note }),
      EXTRACTION_SCHEMA, 'business_knowledge', 12000);
    await saveRun(run);
  }

  // ── ۳ · رقبا — به ورودی کاربر نیاز دارد ──
  if (!done('competitors')) {
    if (!run.input.competitors) return stop(run, 'competitors');
    const urls = run.input.competitors;
    if (!urls.length) { S.competitors = null; }
    else {
      const fetched = [];
      for (const u of urls) {
        const p = await fetchPageText(u.startsWith('http') ? u : 'https://' + u);
        if (p.ok) fetched.push({ name: u, url: u, content: p.text.slice(0, 12000) });
      }
      S.competitors = fetched.length
        ? await call(COMPETITOR_PROMPT({ knowledge: S.knowledge, competitors: fetched }),
                     COMPETITOR_SCHEMA, 'playing_field', 12000)
        : null;
      S.competitorsUnread = urls.length - fetched.length;
    }
    await saveRun(run);
  }

  // ── ۴ · بازار ──
  if (!done('market')) {
    S.market = await call(MARKET_PROMPT({
      knowledge: knowledgeFor('market', S.knowledge),
      competitorMap: S.competitors, contentAnalysis: null,
      userSaid: (S.knowledge.userStated || []).map(u => u.value),
      today: new Date().toISOString().slice(0, 10)
    }), MARKET_SCHEMA, 'market', 12000);
    await saveRun(run);
  }

  // ── ۵ · جمله‌ی اول ──
  if (!done('insight')) {
    S.insight = await call(FIRST_INSIGHT_PROMPT({
      knowledge: S.knowledge, competitorMap: S.competitors,
      contentAnalysis: null, market: S.market
    }), FIRST_INSIGHT_SCHEMA, 'first_insight', 10000);
    S.insightGate = GATES.canShowInsight(S.insight);
    await saveRun(run);
  }
  if (!S.insightGate.pass) return stop(run, null, 'low_confidence');

  // ── ۶ · سؤال‌ها ──
  if (!done('questions')) {
    S.questions = await call(QUESTIONS_PROMPT({
      knowledge: knowledgeFor('questions', S.knowledge),
      mission: 'ساخت برنامه‌ی این ماه'
    }), QUESTIONS_SCHEMA, 'questions', 8000);
    await saveRun(run);
  }

  // ── ۷ · جواب کاربر ──
  if (!done('replies')) {
    if (!run.input.replies) return stop(run, 'answers');
    S.replies = run.input.replies;
    let k = mergeAnswers(S.knowledge, S.replies);
    const cm = condenseMemory(k);
    S.knowledge = cm.condensed ? cm.knowledge : k;
    S.condensed = cm.condensed || 0;
    await saveRun(run);
  }

  // ── ۸ · کارت استراتژی ──
  if (!done('strategy')) {
    const hist = S.knowledge.learningMemory?.campaignHistory || [];
    S.strategy = await call(STRATEGY_CARD_PROMPT({
      knowledge: knowledgeFor('strategy', S.knowledge),
      insight: S.insight.chosen.sentence,
      answers: S.replies.answers, constraints: S.replies.constraints || [],
      fatigue: [...new Set(hist.map(c => c.target))]
        .map(t => threadFatigue(hist, t)).filter(f => f.verdict)
    }), STRATEGY_CARD_SCHEMA, 'strategy_card', 14000);
    await saveRun(run);
  }

  // ── ۹ · تأیید ──
  if (!S.strategy.approvedAt) {
    if (!run.input.approved) return stop(run, 'approval');
    S.strategy.approvedAt = new Date().toISOString();
    await saveRun(run);
  }

  // ── ۱۰ · کمپین ──
  if (!done('campaign')) {
    const cap = realisticCapacity({
      statedPerWeek: Number(S.replies.answers?.piecesPerWeek) || 2, card: S.strategy });
    const c = await call(CAMPAIGN_PROMPT({
      card: S.strategy, knowledge: knowledgeFor('campaign', S.knowledge),
      contentAnalysis: null, market: S.market,
      occasions: upcomingOccasions(S.market), capacity: cap
    }), CAMPAIGN_SCHEMA, 'campaign', 12000);
    c.capacityCheck = { ...cap, planned: c.pieces?.length ?? 0 };
    S.campaign = c;
    await saveRun(run);
  }

  return stop(run, null, 'done');
}

function stop(run, needs, state) {
  return { run, needs: needs || null, state: state || 'waiting',
           stages: Object.keys(run.stages) };
}
function id() { return 'r' + Math.random().toString(36).slice(2, 9); }
