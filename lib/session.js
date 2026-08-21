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
import { apifyEnabled } from '../services/apify.js';
import { quickInstagram } from './igSync.js';
import { itemsToText, toLegacyPost } from './instagram.js';
import { callWithSchema, activeEngine } from '../services/vohuService.js';
import { loadRun, saveRun } from '../services/store.js';
import {
  EXTRACTION_PROMPT, EXTRACTION_SCHEMA,
  COMPETITOR_PROMPT, COMPETITOR_SCHEMA,
  MARKET_PROMPT, MARKET_SCHEMA,
  FIRST_INSIGHT_PROMPT, FIRST_INSIGHT_SCHEMA,
  QUESTIONS_PROMPT, QUESTIONS_SCHEMA,
  STRATEGY_CARD_PROMPT, STRATEGY_CARD_SCHEMA,
  CAMPAIGN_PROMPT, CAMPAIGN_SCHEMA,
  CONTENT_ANALYSIS_PROMPT, CONTENT_ANALYSIS_SCHEMA,
  mergeAnswers, knowledgeFor, condenseMemory, threadFatigue,
  realisticCapacity, upcomingOccasions, GATES, MISSION
} from '../prompts/vohuPrompts.js';

const STAGE_FA = {
  business_knowledge: 'شناخت کسب‌وکار', playing_field: 'زمین بازی (رقبا)',
  market: 'بازار و مشتری', first_insight: 'جمله‌ی اول',
  content_analysis: 'شناخت محتوا', questions: 'سؤال‌ها', strategy_card: 'کارت استراتژی', campaign: 'کمپین'
};

/**
 * قیمت هر میلیون توکن، دلار. از docs.claude.com — بررسی‌شده ۲۰۲۶-۰۸-۱۹.
 * قیمت‌ها عوض می‌شوند؛ اگر عدد مشکوک دیدی اول این جدول را چک کن.
 */
const PRICE = {
  'claude-opus-5':          { in: 5,  out: 25 },
  'claude-sonnet-5':        { in: 2,  out: 10 },
  'claude-haiku-4-5':       { in: 1,  out: 5  },
  'claude-haiku-4-5-20251001': { in: 1, out: 5 }
};

export function costOf(model, inTok = 0, outTok = 0) {
  const p = PRICE[model];
  if (!p) return null;                                   // مدل ناشناخته → عدد نساز
  return (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
}
// مدل‌های جایگزین (OpenAI) عمداً در PRICE نیستند: قیمتشان را اینجا مطمئن
// نمی‌دانیم و عدد ساختگی بدتر از عدد نداشتن است. به‌جایش شمرده می‌شود که
// چند فراخوان قیمت‌نخورده مانده و همان به کاربر گفته می‌شود.

const call = async (prompt, schema, toolName, maxTokens = 8000, run = null) => {
  const t0 = Date.now();
  const fa = STAGE_FA[toolName] || toolName;
  console.log(`  … ${fa} — ${Math.round(prompt.length / 1024)}KB ورودی`);

  if (run) {
    run.progress = { stage: toolName, label: fa, startedAt: new Date().toISOString(),
                     inputKB: Math.round(prompt.length / 1024),
                     model: run?.engine?.model || process.env.VOHU_MODEL || null };
    await saveRun(run).catch(() => {});
  }
  try {
    // سرویس از خود اجرا می‌آید، نه از .env — تا وسط کار عوض نشود
    const r = await callWithSchema({ prompt, schema, toolName, maxTokens, engine: run?.engine });
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    const inT = r.meta?.inputTokens || 0, outT = r.meta?.outputTokens || 0;
    const c = costOf(r.meta?.model, inT, outT);

    console.log(`  ✓ ${fa} — ${sec}s · ${inT}→${outT} توکن`
              + (c != null ? ` · $${c.toFixed(3)}` : '')
              + `  · ${r.meta?.provider}/${r.meta?.model}`);

    if (run) {
      run.progress = { ...(run.progress || {}), stage: toolName, label: fa, done: true };
      run.usage = run.usage || { calls: 0, inputTokens: 0, outputTokens: 0, seconds: 0, usd: 0, unpriced: 0, model: r.meta?.model };
      run.usage.calls++;
      run.usage.inputTokens  += inT;
      run.usage.outputTokens += outT;
      run.usage.seconds      += Number(sec);
      // مدلی که واقعاً جواب داده، نه مدلی که خواسته بودیم
      run.usage.model = r.meta?.model || run.usage.model;
      if (c != null) run.usage.usd += c;
      else run.usage.unpriced = (run.usage.unpriced || 0) + 1;
    }
    return r.data;
  } catch (e) {
    console.log(`  ✗ ${fa} — ${((Date.now() - t0) / 1000).toFixed(1)}s · ${e.message}`);
    throw e;
  }
};

export async function startRun({ url, note }) {
  const run = { id: id(), url, note, mission: MISSION, stages: {}, input: {},
                createdAt: new Date().toISOString() };
  await saveRun(run);
  return run;
}

export async function getRun(url) { return loadRun(url); }

/**
 * «آنچه می‌بینی همین حالا ساخته نشد» — هرچه رابط برای گفتن این جمله لازم دارد.
 *
 * اجرای ذخیره‌شده بی‌سروصدا برگردانده می‌شود و این سه بار کاربر را گمراه کرد:
 * او فکر می‌کرد نتیجه‌ی همین حالاست، درحالی‌که خروجی چند روز پیش را می‌دید و
 * تنها راهش پاک‌کردن دستی .vohu بود.
 *
 * `restoredAt` را صداکننده می‌دهد، چون فقط او می‌داند این درخواست اجرای تازه
 * ساخت یا از انبار خواند. null یعنی تازه — بنری هم در کار نیست.
 *
 * سرویس/مدل از مهرِ producedBy خودِ مرحله‌ها خوانده می‌شود، نه از run.engine:
 * مهر روی همان چیزی نشسته که کاربر روی صفحه می‌بیند. run.engine فقط وقتی
 * جانشین می‌شود که هنوز هیچ مرحله‌ای مهر نخورده باشد.
 */
export function restoredInfo(run, restoredAt) {
  if (!restoredAt || !run) return null;

  const made = newestStamp(run) || run.engine || null;

  // VOHU_PROVIDER نامعتبر یک خطای دیگر است و جای گفتنش اینجا نیست —
  // بنرِ «قدیمی است» نباید به‌خاطر آن کلاً ناپدید شود.
  let now = null;
  try { now = activeEngine(); } catch {}

  // فرق مدل فقط وقتی معنی دارد که هر دو طرف را بدانیم. یک طرفِ نامعلوم،
  // «فرق دارد» نیست — قاعده‌ی ۶: چیزی که نمی‌دانیم ادعا نمی‌شود.
  const differs = made && now
    && (made.provider !== now.provider
        || (made.model && now.model && made.model !== now.model));

  return {
    at:       made?.at || restoredAt,
    provider: made?.provider || null,
    model:    made?.model || null,
    mismatch: differs ? { provider: now.provider, model: now.model } : null
  };
}

/**
 * ترتیب مشاهده‌ها: اطمینان × اهمیت — نه فقط اطمینان.
 *
 * دو عدد جدا از مدل خواسته می‌شود چون دو چیز جدااند: مشاهده‌ای که صددرصد
 * قطعی است ولی هیچ‌چیز را عوض نمی‌کند، نباید بالای فهرست بنشیند.
 *
 * مرتب‌سازی اینجا انجام می‌شود، نه با اعتماد به ترتیبی که مدل برگردانده —
 * قاعده‌ی ۲. هر دو عدد بیرون می‌روند تا در رابط معلوم باشد چرا این اول آمده.
 *
 * اهمیتِ نبوده (کارت‌های قبل از این قاعده) ساخته نمی‌شود: null می‌ماند و
 * امتیاز همان اطمینان است — قاعده‌ی ۶.
 */
export function rankCandidates(candidates) {
  return (candidates || [])
    .map(c => {
      const s = num01(c?.strength);
      const i = num01(c?.impact);
      return { p: c?.pattern, s, i, score: s == null ? null : (i == null ? s : s * i) };
    })
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

const num01 = v => (typeof v === 'number' && isFinite(v) ? Math.min(1, Math.max(0, v)) : null);

/** تازه‌ترین مهر producedBy در میان مرحله‌ها — همان که کاربر می‌بیندش. */
function newestStamp(run) {
  let best = null;
  for (const stage of Object.values(run.stages || {})) {
    const p = stage && typeof stage === 'object' ? stage.producedBy : null;
    if (p?.at && (!best || p.at > best.at)) best = p;
  }
  return best;
}

/**
 * یک قدم جلو می‌رود. هر بار که چیزی از کاربر لازم باشد می‌ایستد.
 * قابل صدا زدن چندباره — مرحله‌های انجام‌شده دوباره اجرا نمی‌شوند.
 */
export async function advance(run) {
  // کمربند ایمنی: هر اجرا از هر مسیری که آمده باشد، شکل حداقلی داشته باشد
  run.stages = run.stages || {};
  run.input  = run.input  || {};

  // ── قفلِ سرویس ──
  // اولین بار که این اجرا جلو می‌رود، سرویس فعال روی خودش می‌نشیند و تا آخر
  // همان می‌ماند. اگر .env بعداً عوض شود، callWithSchema صریح می‌ایستد —
  // اجرا نصفه با یک سرویس و نصفه با سرویس دیگر ساخته نمی‌شود.
  if (!run.engine) {
    run.engine = activeEngine();
    console.log(`  · سرویس این اجرا: ${run.engine.provider}/${run.engine.model || '؟'}`);
  }

  const S = run.stages;
  const done = n => n in S;

  // ── ۱ · خواندن منابع ──
  //
  // چند منبع، نه یکی. سایت و اینستاگرام و کانال با هم — هر کدام که به دست آمد.
  // شکست یک منبع کل کار را متوقف نمی‌کند؛ فقط ثبت می‌شود که خوانده نشد.
  // فقط اگر هیچ منبعی خوانده نشد می‌ایستیم — چون آن‌وقت واقعاً شاهدی نداریم.
  if (!done('page')) {
    const list = sourceList(run);
    const read = [];
    run.progress = { stage: 'sources', label: 'خواندن منابع',
                     startedAt: new Date().toISOString(),
                     model: process.env.VOHU_MODEL || null };
    await saveRun(run).catch(() => {});

    for (const src of list) {
      if (src.pasted) { read.push({ ...src, ok: true, text: src.pasted, source: 'paste' }); continue; }
      const t0 = Date.now();
      run.progress = { ...(run.progress || {}), label: `خواندن ${src.label}` };
      await saveRun(run).catch(() => {});

      // اینستاگرام فقط از راه Apify باز می‌شود — و فقط اگر توکن باشد
      if (src.kind === 'instagram' && apifyEnabled()) {
        // خواندن اینستاگرام مهلت ندارد، پس باید دیده شود کجای کار است.
        // هر خبری که از Apify می‌رسد روی run نوشته می‌شود و مرورگر از
        // /api/run/progress می‌خواندش. عددها واقعی‌اند: شمار آیتم‌های جمع‌شده.
        let saving = false;
        const onProgress = p => {
          run.progress = { ...(run.progress || {}),
                           stage:      'sources',
                           label:      `خواندن ${src.label} — ${p.note || ''}`.trim(),
                           phase:      p.phase   ?? null,
                           percent:    p.percent ?? null,
                           itemsDone:  p.done    ?? null,
                           itemsTotal: p.total   ?? null };
          if (saving) return;                       // نوشتن‌ها روی هم سوار نشوند
          saving = true;
          saveRun(run).catch(() => {}).finally(() => { saving = false; });
        };

        // یک کار = یک فراخوان Apify. advance() چندبار صدا زده می‌شود
        // (هر بار که کاربر جواب می‌دهد) و بدون این حافظه هر بار دوباره پول می‌داد.
        // شکست هم ثبت می‌شود — همان حالتی بود که بیشترین پول را می‌سوزاند.
        run.igFetch = run.igFetch || {};
        let r = run.igFetch[src.url];
        const fromMemo = Boolean(r);

        if (!r) {
          r = await quickInstagram(src.url, { onProgress, refetch: Boolean(run.input.refetch) });
          run.igFetch[src.url] = r;
          run.input.refetch = false;                    // یک‌بارمصرف، نه یک حالت ماندگار
          await saveRun(run).catch(() => {});
        }

        const sec = ((Date.now() - t0) / 1000).toFixed(1);
        if (r.ok) {
          const posts = r.items.map(toLegacyPost);
          // از کجا آمد: فراخوان تازه، تاریخچه‌ی همین اجرا، یا تاریخچه‌ی روی دیسک
          const src_ = fromMemo ? 'همین اجرا' : (r.via === 'history' ? 'تاریخچه' : `${sec}s`);
          console.log(`  ✓ ${src.label} (${r.via === 'history' ? 'تاریخچه' : 'Apify'}) — ${src_}`
                    + ` · ${posts.length} محتوا · ${posts.filter(x => x.likes != null).length} با آمار`
                    + (r.readAt ? ` · خوانده‌شده در ${r.readAt}` : ''));
          read.push({ ...src, ok: true, text: itemsToText(r.items), posts, items: r.items,
                      via: r.via === 'history' ? 'history' : 'apify', readAt: r.readAt || null });
        } else {
          console.log(`  ✗ ${src.label} (Apify) — ${fromMemo ? 'همین اجرا' : sec + 's'} · ${r.error}`);
          const slow = /جواب نداد/.test(r.error || '');
          if (r.detail) console.log(`     جزئیات: ${String(r.detail).slice(0, 300)}`);
          read.push({ ...src, ok: false, error: r.error + (r.detail ? ` — ${String(r.detail).slice(0, 120)}` : ''),
                      why: { kind: 'apify',
                             text: slow
                               ? `Apify در مهلت مقرر جواب نداد. کار ادامه پیدا کرد بدون اینستاگرام.`
                               : `Apify نتوانست بخواند: ${r.error}`,
                             fix: slow
                               ? 'از دکمه‌ی «استخراج عمیق اینستاگرام» استفاده کن — آن در پس‌زمینه اجرا می‌شود و عجله‌ای ندارد.'
                               : (r.detail ? String(r.detail).slice(0, 200) : 'توکن و اعتبار حساب Apify را چک کن.') } });
        }
        run.progress = { ...(run.progress || {}),
                         phase: null, percent: null, itemsDone: null, itemsTotal: null };
        continue;
      }

      const p = await fetchPageText(src.url);
      console.log(`  ${p.ok ? '✓' : '✗'} ${src.label} — ${((Date.now() - t0) / 1000).toFixed(1)}s`
                + (p.ok ? ` · ${(p.text || '').length} نویسه` : ` · ${p.error}`));
      read.push(p.ok
        ? { ...src, ok: true, text: p.text, rawLength: p.rawLength }
        : { ...src, ok: false, error: p.error, why: whyBlocked(src.url, p.error) });
    }

    const got = read.filter(r => r.ok && (r.text || '').trim().length > 100);

    if (!got.length) {
      run.stages.pageError = {
        url: run.url,
        error: read.map(r => r.error).filter(Boolean).join(' · ') || 'متن قابل استفاده‌ای نبود',
        why: read.find(r => r.why)?.why || whyBlocked(run.url, 'خالی'),
        tried: read.map(r => ({ label: r.label, ok: r.ok, error: r.error || null }))
      };
      await saveRun(run);
      return stop(run, 'pageText', 'page_failed');
    }

    S.page = {
      ok: true,
      url: run.url,
      // متن برچسب‌دار — مدل باید بداند هر تکه از کجا آمده
      text: got.map(g => `\n=== ${g.label} (${g.kind}) — ${g.url} ===\n${g.text}`).join('\n'),
      sources: read.map(r => ({ label: r.label, kind: r.kind, url: r.url,
                                ok: r.ok, error: r.error || null, via: r.via || 'fetch',
                                why: r.why || null, chars: r.ok ? (r.text || '').length : 0,
                                posts: r.posts ? r.posts.length : null,
                                // اگر از تاریخچه آمده، تاریخ خواندنش شاهد است نه امروز
                                readAt: r.readAt || null })),
      readCount: got.length,
      missedCount: read.length - got.length,
      posts: got.flatMap(g => g.posts || [])
    };
    delete run.stages.pageError;
    await saveRun(run);
  }

  // ── ۲ · شناخت ──
  if (!done('knowledge')) {
    S.knowledge = await call(
      EXTRACTION_PROMPT({ pageContent: S.page.text, userNote: run.note,
                          sources: S.page.sources || [] }),
      EXTRACTION_SCHEMA, 'business_knowledge', 12000, run);
    S.knowledge.sourcesRead  = (S.page.sources || []).filter(x => x.ok).map(x => x.label);
    S.knowledge.sourcesMissed = (S.page.sources || []).filter(x => !x.ok).map(x => x.label);
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
                     COMPETITOR_SCHEMA, 'playing_field', 12000, run)
        : null;
      S.competitorsUnread = urls.length - fetched.length;
    }
    await saveRun(run);
  }

  // ── ۳.۵ · شناخت محتوا ──
  //
  // تا امروز این مرحله در نسخه‌ی وب اصلاً اجرا نمی‌شد و contentAnalysis همه‌جا null بود،
  // چون منبعی برای پست‌ها نداشتیم. حالا با Apify داریم.
  // اگر پستی نبود، null می‌ماند — ولی صریح، نه بی‌سروصدا.
  if (!done('content')) {
    const posts = S.page.posts || [];
    if (posts.length < 3) {
      S.content = null;
      S.contentSkipped = posts.length
        ? `فقط ${posts.length} پست — کمتر از ۳ تا الگو نمی‌شود`
        : 'پستی در دست نبود';
      console.log(`  – شناخت محتوا رد شد: ${S.contentSkipped}`);
    } else {
      S.content = await call(CONTENT_ANALYSIS_PROMPT({
        knowledge: knowledgeFor('content', S.knowledge),
        posts,
        hasMetrics: posts.some(p => p.likes != null)
      }), CONTENT_ANALYSIS_SCHEMA, 'content_analysis', 12000, run);
    }
    await saveRun(run);
  }

  // ── ۴ · بازار ──
  if (!done('market')) {
    S.market = await call(MARKET_PROMPT({
      knowledge: knowledgeFor('market', S.knowledge),
      competitorMap: S.competitors, contentAnalysis: S.content,
      userSaid: (S.knowledge.userStated || []).map(u => u.value),
      today: new Date().toISOString().slice(0, 10)
    }), MARKET_SCHEMA, 'market', 12000, run);
    await saveRun(run);
  }

  // ── ۵ · جمله‌ی اول ──
  if (!done('insight')) {
    S.insight = await call(FIRST_INSIGHT_PROMPT({
      knowledge: S.knowledge, competitorMap: S.competitors,
      contentAnalysis: S.content, market: S.market
    }), FIRST_INSIGHT_SCHEMA, 'first_insight', 10000, run);
    S.insightGate = GATES.canShowInsight(S.insight);
    await saveRun(run);
  }
  if (!S.insightGate.pass) return stop(run, null, 'low_confidence');

  // ── ۶ · سؤال‌ها ──
  if (!done('questions')) {
    S.questions = await call(QUESTIONS_PROMPT({
      knowledge: knowledgeFor('questions', S.knowledge),
      mission: 'ساخت برنامه‌ی این ماه'
    }), QUESTIONS_SCHEMA, 'questions', 8000, run);
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
    }), STRATEGY_CARD_SCHEMA, 'strategy_card', 14000, run);

    // «واقعیت» بدون نقل‌قولی که در متن خوانده‌شده پیدا شود، واقعیت نیست —
    // قول است و تأیید کاربر می‌خواهد. اسکیما جلوی برچسبِ ناممکن را می‌گیرد،
    // ولی نمی‌تواند بفهمد نقل‌قول واقعی است یا ساخته شده. این کار کد است.
    const cellFix = GATES.checkCellOrigins(S.strategy, S.page?.text || '');
    if (!cellFix.pass) {
      S.strategy.originFixes = cellFix.changed;
      console.log('  ⚠ برچسب اصلاح شد: '
        + cellFix.changed.map(c => `${c.cell} ${c.from}→${c.to} (${c.why})`).join(' · '));
    }
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
      contentAnalysis: S.content, market: S.market,
      occasions: upcomingOccasions(S.market), capacity: cap
    }), CAMPAIGN_SCHEMA, 'campaign', 12000, run);
    c.capacityCheck = { ...cap, planned: c.pieces?.length ?? 0 };
    S.campaign = c;
    await saveRun(run);
  }

  if (run.usage) {
    const u = run.usage;
    console.log(`\n  ── جمع این اجرا ── ${u.calls} فراخوانی · ${Math.round(u.seconds)}s`
              + ` · ${u.inputTokens}→${u.outputTokens} توکن`
              + (u.usd ? ` · $${u.usd.toFixed(2)}  (${u.model})` : '') + '\n');
  }
  return stop(run, null, 'done');
}

/**
 * چرا صفحه خوانده نشد — به زبان آدمیزاد، نه کد خطا.
 * هدف: کاربر نفهمد «یک چیزی خراب شد»، بفهمد دقیقاً چه شد و چه کار کند.
 */
/**
 * فهرست منابع این اجرا.
 * سازگار با اجراهای قدیمی که فقط یک url داشتند.
 */
/**
 * ورودی کوتاه → آدرس کامل.
 * کاربر نباید مجبور باشد https و www و @ را درست بنویسد.
 *
 *   normalizeSource('instagram', 'brandname')        → https://www.instagram.com/brandname
 *   normalizeSource('instagram', '@brandname')       → https://www.instagram.com/brandname
 *   normalizeSource('instagram', 'instagram.com/brandname/') → https://www.instagram.com/brandname
 *   normalizeSource('telegram',  '@brandname')       → https://t.me/brandname
 *   normalizeSource('site',      'www.example.ir') → https://example.ir
 */
export function normalizeSource(kind, raw) {
  let v = String(raw || '').trim();
  if (!v) return null;

  v = v.replace(/^@+/, '').replace(/\s+/g, '');
  v = v.replace(/^https?:\/\//i, '').replace(/^www\./i, '');

  if (kind === 'instagram') {
    v = v.replace(/^(?:m\.)?instagram\.com\//i, '');
    v = v.split(/[?#]/)[0].replace(/\/+$/, '');
    if (!v) return null;
    return 'https://www.instagram.com/' + v;
  }

  if (kind === 'telegram') {
    v = v.replace(/^(?:t\.me|telegram\.me)\//i, '');
    v = v.split(/[?#]/)[0].replace(/\/+$/, '');
    if (!v) return null;
    return 'https://t.me/' + v;
  }

  // سایت: اگر نقطه ندارد آدرس نیست
  v = v.replace(/\/+$/, '');
  if (!v.includes('.')) return null;
  return 'https://' + v;
}

export function sourceList(run) {
  const out = [];
  const seen = new Set();

  const add = (raw, pasted) => {
    if (!raw) return;
    let u = String(raw).trim();
    if (!u) return;
    u = normalizeSource(classifyRaw(u), u) || u;
    if (!/^https?:\/\//.test(u)) u = 'https://' + u;
    if (seen.has(u)) return;
    seen.add(u);
    out.push({ url: u, pasted: pasted || null, ...classify(u) });
  };

  add(run.url, run.input.pageText);
  for (const extra of run.input.sources || []) add(extra);
  return out;
}

/** نوع را از روی رشته‌ی خام حدس بزن — برای وقتی کاربر فقط آی‌دی داده. */
function classifyRaw(raw) {
  const v = String(raw).toLowerCase();
  if (/instagram\.com/.test(v)) return 'instagram';
  if (/t\.me|telegram\.me/.test(v)) return 'telegram';
  return 'site';
}

export function classify(url) {
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch {}
  if (host.endsWith('instagram.com')) return { kind: 'instagram', label: 'اینستاگرام' };
  if (host.endsWith('t.me') || host.endsWith('telegram.me')) return { kind: 'telegram', label: 'تلگرام' };
  if (host.endsWith('linkedin.com')) return { kind: 'linkedin', label: 'لینکدین' };
  if (host.endsWith('basalam.com')) return { kind: 'marketplace', label: 'باسلام' };
  return { kind: 'site', label: host || 'سایت' };
}

export function whyBlocked(url, error) {
  let host = '';
  try { host = new URL(url.startsWith('http') ? url : 'https://' + url).hostname.replace(/^www\./, ''); } catch {}

  const social = {
    'instagram.com': 'اینستاگرام',
    'facebook.com':  'فیسبوک',
    'linkedin.com':  'لینکدین',
    'x.com':         'ایکس',
    'twitter.com':   'ایکس',
    'tiktok.com':    'تیک‌تاک'
  }[host];

  if (social) return {
    kind: 'social',
    text: `${social} صفحه‌ها را به برنامه‌ها نمی‌دهد — بدون لاگین دیوار می‌گذارد (کد ${error}). `
        + `وُهو به حساب ${social} تو وصل نیست و لینک پیج به‌تنهایی چیزی به آن نمی‌رساند.`,
    fix: 'فعلاً آدرس سایت را بده. برای خودِ اینستاگرام باید استخراج‌کننده وصل شود — کار جداست.'
  };

  if (error === 'timeout') return {
    kind: 'timeout',
    text: 'سایت در مهلت مقرر جواب نداد. یا کند است، یا از این سرور فیلتر/مسدود است.',
    fix: 'دوباره امتحان کن؛ اگر باز نشد، متن صفحه را خودت کپی کن و پایین بچسبان.'
  };

  if (String(error).startsWith('HTTP 4')) return {
    kind: 'blocked',
    text: `سایت درخواست را رد کرد (${error}) — معمولاً یعنی ربات‌ها را راه نمی‌دهد.`,
    fix: 'متن صفحه را خودت کپی کن و پایین بچسبان.'
  };

  return { kind: 'unknown', text: `خطا: ${error}`,
           fix: 'متن صفحه را خودت کپی کن و پایین بچسبان.' };
}

function stop(run, needs, state) {
  return { run, needs: needs || null, state: state || 'waiting',
           stages: Object.keys(run.stages) };
}
function id() { return 'r' + Math.random().toString(36).slice(2, 9); }
