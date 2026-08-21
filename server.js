/**
 * سرور وُهو.
 *
 *   node server.js          →  http://localhost:3000
 *   PORT=8080 node server.js
 *
 * دو چیز سرو می‌کند: رابط کاربری در public/ و شش مسیر API.
 * وضعیت هر اجرا در .vohu/ ذخیره می‌شود — قابل ادامه بعد از بستن مرورگر.
 */

import { envFile } from './lib/env.js';   // باید اولین import باشد — .env را می‌خواند
import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { check, timed, buildId } from './lib/selftest.js';
import { startRun, getRun, advance, normalizeSource, restoredInfo, rankCandidates } from './lib/session.js';
import { saveRun, storeDir } from './services/store.js';
import { checkContent } from './lib/pipeline.js';
import { followUpStatus, countComments, closeLoop } from './lib/followUp.js';
import { runAsUser } from './lib/userContext.js';
import { createJob, getJob, listJobs, registerHandler, markInterrupted } from './services/jobs.js';
import { syncInstagram, loadState, resolveLimits } from './lib/igSync.js';
import { analyzeItems } from './lib/igAnalyze.js';
import { capabilities } from './services/media.js';
import { apifyEnabled } from './services/apify.js';
import { configuredProvider, activeEngine } from './services/vohuService.js';
import { GATES } from './prompts/vohuPrompts.js';

const app  = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';   // روی سرور باید همه‌ی رابط‌ها باشد، نه فقط localhost
const here = path.dirname(fileURLToPath(import.meta.url));
const STARTED_AT = new Date().toISOString();

/**
 * کلیدی که **سرویس فعال** لازم دارد — نه همیشه کلید کلاد.
 * با VOHU_PROVIDER=openai نبودن ANTHROPIC_API_KEY اصلاً عیب نیست؛
 * هشدار دادن بابتش کاربر را دنبال کلیدی می‌فرستد که هیچ‌جا خوانده نمی‌شود.
 */
function activeKey() {
  let provider = null;
  try { provider = configuredProvider(); } catch { /* مقدار نامعتبر — selftest می‌گوید */ }
  const name = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
  return { provider, name, set: Boolean(process.env[name]) };
}

app.use(express.json({ limit: '2mb' }));

// هر درخواست لاگ می‌شود. اگر ترمینال ساکت است، یعنی درخواست اصلاً نرسیده —
// و آن یعنی مشکل از شبکه/مرورگر است، نه از برنامه.
app.use((req, res, next) => {
  const t0 = Date.now();
  console.log(`  ← ${req.method} ${req.path}`);
  res.on('finish', () =>
    console.log(`  → ${req.method} ${req.path} · ${res.statusCode} · ${Date.now() - t0}ms`));
  next();
});

// صفحه هرگز کش نشود — وگرنه بعد از هر به‌روزرسانی، مرورگر نسخه‌ی قدیمی را نشان می‌دهد
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html'))
    res.setHeader('cache-control', 'no-store, must-revalidate');
  next();
});

/**
 * هر درخواست داخل context یک کاربر اجرا می‌شود، تا مسیرهای روی دیسک
 * (`.vohu/<user>/…`) از همان اول جدا باشند.
 *
 * فعلاً احراز هویتی نیست و همه «default»اند. هدف این است که وقتی این مغز
 * روی spark-saas سوار شود، فقط همین یک تابع عوض شود — نه هیچ‌کدام از
 * جاهایی که فایل می‌خوانند یا می‌نویسند.
 */
app.use((req, _res, next) => {
  const who = req.get('x-vohu-user') || process.env.VOHU_USER || null;
  runAsUser(who, next);
});

app.use(express.static(path.join(here, 'public')));

// خطای مدل نباید کل سرور را بخواباند
const guard = fn => (req, res) => fn(req, res).catch(e => {
  console.error('[vohu]', e.message);
  // hint را سرویس مدل می‌گذارد — «حالا چه کار کنم؟». اگر نبود، رابط
  // خودش جمله‌ی عمومی می‌گذارد.
  res.status(500).json({ error: e.message, hint: e.hint || null });
});

const view = r => ({
  url: r.run.url, needs: r.needs, state: r.state, stages: r.stages,
  // یک خطی که کاربر نوشته بود. رابط با «شروع از نو» پسش می‌فرستد —
  // بدون این، اجرای تازه همان توضیح را از دست می‌داد.
  note:      r.run.note || null,
  page:      r.run.stages.page ? { ok: r.run.stages.page.ok,
                                   sources: r.run.stages.page.sources || [],
                                   readCount: r.run.stages.page.readCount ?? null,
                                   missedCount: r.run.stages.page.missedCount ?? null,
                                   length: r.run.stages.page.text?.length || 0 } : null,
  pageError: r.run.stages.pageError || null,
  insight:   r.run.stages.insight ? {
                sentence: r.run.stages.insight.chosen?.sentence,
                evidence: r.run.stages.insight.chosen?.evidence,
                supporting: r.run.stages.insight.supporting || [],
                scope: r.run.stages.insight.scope,
                candidates: rankCandidates(r.run.stages.insight.candidates),
                confident: r.run.stages.insight.confident,
                fallback: r.run.stages.insight.fallback } : null,
  questions: r.run.stages.questions || null,
  strategy:  r.run.stages.strategy || null,
  campaign:  r.run.stages.campaign || null,
  market:    r.run.stages.market ? {
                fears: (r.run.stages.market.categoryFear || []).slice(0, 3),
                vocab: (r.run.stages.market.buyerVocabulary || []).slice(0, 4) } : null,
  coverage:  r.run.stages.knowledge?.coverage || null,
  condensed: r.run.stages.condensed || 0,
  usage:     r.run.usage || null,
  // سرویس قفل‌شده‌ی این اجرا — تا در رابط معلوم باشد با چه چیزی ساخته می‌شود
  engine:    r.run.engine || null,
  // اگر این جواب از انبار درآمده و همین حالا ساخته نشده، رابط باید بگویدش.
  // null یعنی تازه است و بنری لازم نیست.
  restored:  restoredInfo(r.run, r.restoredAt || null),
  // سررسید «چه شد؟» — رابط بر اساس همین صفحه را نشان می‌دهد
  followUp:  r.run.followUp ? followUpStatus(r.run) : null
});

// شروع یا ادامه
app.post('/api/run', guard(async (req, res) => {
  const { note, fresh, sources } = req.body;

  // ورودی کوتاه: site / instagram / telegram — کاربر @ و www و https نمی‌نویسد
  const site = normalizeSource('site', req.body.site || req.body.url);
  const ig   = normalizeSource('instagram', req.body.instagram);
  const tg   = normalizeSource('telegram', req.body.telegram);

  const url = site || ig || tg;
  if (!url) return res.status(400).json({ error: 'دست‌کم یک آدرس لازم است — سایت یا اینستاگرام یا تلگرام' });
  // refetch یعنی «دوباره از Apify بخوان» و ناچار یعنی اجرای تازه هم:
  // اگر فقط منابع عوض شوند و تحلیل‌های قبلی سر جایشان بمانند، تحلیل روی
  // شاهدی می‌نشیند که دیگر وجود ندارد. قاعده‌ی ۴ این را نمی‌پذیرد.
  const refetch = Boolean(req.body.refetch);
  let run = (fresh || refetch) ? await startRun({ url, note }) : await getRun(url);
  // updatedAt فقط روی اجرایی هست که قبلاً ذخیره شده — یعنی همین یک خط
  // جواب «این از انبار درآمد یا حالا ساخته شد؟» است. باید *قبل* از advance
  // خوانده شود، چون advance خودش ذخیره می‌کند و مهرش را تازه می‌کند.
  const restoredAt = (fresh || refetch) ? null : (run.updatedAt || null);
  run.stages = run.stages || {};
  run.input  = run.input  || {};
  if (note && !run.note) run.note = note;

  // بدون refetch، اگر استخراج تازه‌ای در تاریخچه باشد از همان استفاده می‌شود —
  // چون هر فراخوان Apify پول است. fresh زنجیره را از نو شروع می‌کند ولی
  // پول تازه‌ی استخراج خرج نمی‌کند؛ فقط refetch خرج می‌کند.
  if (refetch) { run.input.refetch = true; delete run.igFetch; }
  if (!run.stages.page) {
    const extra = [site, ig, tg].filter(Boolean).filter(x => x !== url);
    if (Array.isArray(sources)) extra.push(...sources.map(x => String(x || '').trim()).filter(Boolean));
    run.input.sources = [...new Set(extra)].slice(0, 5);
  }
  res.json(view({ ...await advance(run), restoredAt }));
}));

// پیشرفت زنده — مرورگر هر چند ثانیه می‌پرسد «الان کجایی؟»
app.get('/api/run/progress', guard(async (req, res) => {
  const run = await getRun(req.query.url);
  const p = run?.progress || null;
  res.json({
    stage: p?.stage || null,
    label: p?.label || null,
    model: p?.model || process.env.VOHU_MODEL || null,
    inputKB: p?.inputKB ?? null,
    // پیشرفت منبعی که مهلت ندارد (اینستاگرام/Apify) — عددها واقعی‌اند یا null
    phase:      p?.phase      ?? null,
    percent:    p?.percent    ?? null,
    itemsDone:  p?.itemsDone  ?? null,
    itemsTotal: p?.itemsTotal ?? null,
    elapsed: p?.startedAt ? Math.round((Date.now() - new Date(p.startedAt).getTime()) / 1000) : null,
    done: Boolean(p?.done),
    stages: Object.keys(run?.stages || {})
  });
}));

// وضعیت فعلی، بدون اجرای چیزی
app.get('/api/run', guard(async (req, res) => {
  const run = await getRun(req.query.url);
  // این سر اصلاً چیزی نمی‌سازد — هرچه برمی‌گرداند از انبار است.
  res.json(view({ run, needs: null, state: 'loaded', stages: Object.keys(run.stages || {}),
                  restoredAt: run.updatedAt || run.createdAt || null }));
}));

// رقبا
app.post('/api/run/competitors', guard(async (req, res) => {
  const run = await getRun(req.body.url);
  run.input = run.input || {};
  run.input.competitors = (req.body.competitors || []).filter(Boolean);
  await saveRun(run);
  res.json(view(await advance(run)));
}));

// جواب سؤال‌ها و حدس‌ها
app.post('/api/run/answers', guard(async (req, res) => {
  const run = await getRun(req.body.url);
  run.input = run.input || {};
  run.input.replies = {
    answers: req.body.answers || {},
    assumptionResponses: req.body.assumptions || {},
    constraints: req.body.constraints || []
  };
  await saveRun(run);
  res.json(view(await advance(run)));
}));

// متن صفحه، دستی — وقتی سایت به ما نداد
app.post('/api/run/page-text', guard(async (req, res) => {
  const run = await getRun(req.body.url);
  run.input = run.input || {};
  const text = String(req.body.text || '').trim();
  if (text.length < 200)
    return res.status(400).json({ error: 'متن خیلی کوتاه است — دست‌کم ۲۰۰ نویسه لازم داریم' });
  run.input.pageText = text.slice(0, 40000);
  delete run.stages.pageError;
  await saveRun(run);
  res.json(view(await advance(run)));
}));

// تأیید کارت
app.post('/api/run/approve', guard(async (req, res) => {
  const run = await getRun(req.body.url);
  run.input = run.input || {};

  // اینجا هم چک می‌شود، نه فقط در advance: کاربر باید *بفهمد* چرا تأییدش
  // نگرفت. بدون این، دکمه را می‌زد و همان صفحه برمی‌گشت بدون هیچ توضیحی.
  const conf = GATES.canApproveCard(run.stages?.strategy);
  if (!conf.pass)
    return res.status(400).json({
      error: `${conf.reason} — اول همان‌ها را جواب بده`,
      hint: 'زیر هر کدام دو دکمه هست: «درست است» یا «نه». تا همه‌شان جواب نگیرند، تأیید معنی ندارد.',
      pending: conf.pending
    });

  run.input.approved = true;
  await saveRun(run);
  res.json(view(await advance(run)));
}));

/**
 * تأیید یا تصحیح یک قول.
 *
 * «درست است» → فقط needsConfirmation برداشته می‌شود. برچسب **commitment
 * می‌ماند**، چون هنوز همان قول است — فقط حالا کاربر پشتش ایستاده. تبدیلش به
 * fact یعنی وانمود کنیم در منابع دیده‌ایمش، که ندیده‌ایم.
 * «نه، این است» → مقدار عوض می‌شود؛ باز هم قول است، این بار به بیان خودش.
 */
app.post('/api/run/confirm', guard(async (req, res) => {
  const run = await getRun(req.body.url);
  const card = run.stages?.strategy;
  if (!card?.cells) return res.status(400).json({ error: 'این اجرا کارتی ندارد' });

  for (const [name, answer] of Object.entries(req.body.cells || {})) {
    const c = card.cells[name];
    if (!c || c.needsConfirmation !== true) continue;
    const correction = typeof answer === 'string' ? answer.trim() : '';
    if (correction) { c.correctedFrom = c.value; c.value = correction; }
    else if (answer !== true) continue;              // نه true بود نه متن — یعنی هنوز جواب نداده
    c.needsConfirmation = false;
    c.confirmedAt = new Date().toISOString();
  }
  card.pendingConfirmations = GATES.canApproveCard(card).pending;
  await saveRun(run);
  res.json(view({ run, needs: 'approval', state: 'awaiting_approval',
                  stages: Object.keys(run.stages || {}) }));
}));

// ── نیمه‌ی دوم حلقه: «چه شد؟» ───────────────────────────────
// وضعیت سررسید. هیچ فراخوان پولی اینجا زده نمی‌شود — فقط نگاه به اجرا.
app.get('/api/followup', guard(async (req, res) => {
  const run = await getRun(req.query.url);
  res.json(followUpStatus(run));
}));

// شمارش خودکار — این یکی به Apify می‌زند، پس فقط با درخواست صریح کاربر.
app.post('/api/followup/count', guard(async (req, res) => {
  const run = await getRun(req.body.url);
  res.json(await countComments(run));
}));

// بستن حلقه: مشاهده‌ها → عملکرد → یادگیری → حافظه‌ی کسب‌وکار
app.post('/api/followup/close', guard(async (req, res) => {
  const run = await getRun(req.body.url);
  const out = await closeLoop(run, {
    observations: req.body.observations || [],
    userAnswer:   req.body.userAnswer || null,
    userReason:   req.body.userReason || null
  });
  await saveRun(run);                       // answeredAt روی اجرا نشسته
  res.json({ outcome: out.outcome, learning: out.learning,
             campaignHistory: out.memory.campaignHistory.length });
}));

// دروازه‌ی شواهد — قبل از انتشار هر متنی
app.post('/api/check', guard(async (req, res) => {
  const run = await getRun(req.body.url);
  const { report, gate } = await checkContent({
    content: req.body.content,
    knowledge: run.stages.knowledge,
    market: run.stages.market
  });
  res.json({ gate, claims: report.claims });
}));

// ══ اینستاگرام ══════════════════════════════════════════════
//
// استخراج در پس‌زمینه انجام می‌شود. درخواست فقط کار را ثبت می‌کند و شناسه می‌دهد.
// توکن Apify هرگز در هیچ‌کدام از این پاسخ‌ها نیست — فقط در متغیر محیطی سرور.

registerHandler('ig-sync', async (payload, report) => {
  const sync = await syncInstagram(payload, report);
  if (payload.analyze === false) return { ...sync, analysis: null };

  await report({ note: 'استخراج تمام شد — شروع تحلیل' });
  const analysis = await analyzeItems(sync.newItems, report);
  return { ...sync, analysis };
});

app.post('/api/instagram/sync', guard(async (req, res) => {
  if (!apifyEnabled())
    return res.status(400).json({ error: 'APIFY_TOKEN در .env سرور تعریف نشده' });

  const target = String(req.body.target || '').trim();
  if (!target) return res.status(400).json({ error: 'target لازم است — لینک پیج، پست یا ریلز' });

  const limits = resolveLimits({ posts: req.body.posts, reels: req.body.reels });
  const job = await createJob('ig-sync', {
    target,
    withMedia: req.body.withMedia !== false,
    force:     Boolean(req.body.force),
    analyze:   req.body.analyze !== false,
    ...limits
  });
  res.json({ jobId: job.id, status: job.status, limits });
}));

app.get('/api/instagram/job/:id', guard(async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'کار پیدا نشد' });
  const full = req.query.full === '1';
  const result = job.result && !full
    ? { ...job.result, newItems: (job.result.newItems || []).map(stripRaw) }
    : job.result;
  res.json({ ...job, result });
}));

app.get('/api/instagram/jobs', guard(async (_req, res) => res.json(await listJobs({}))));

app.get('/api/instagram/items', guard(async (req, res) => {
  const st = await loadState(String(req.query.username || ''));
  res.json({ username: st.username, lastSyncAt: st.lastSyncAt || null,
             count: (st.items || []).length,
             items: (st.items || []).map(req.query.raw === '1' ? (x => x) : stripRaw) });
}));

// وضعیت ابزارها — تا معلوم باشد OCR واقعاً کار می‌کند یا نه
// تاریخچه‌ی چه پیج‌هایی روی دیسک هست — تا معلوم باشد از کجا می‌شود ادامه داد
app.get('/api/instagram/history', guard(async (_req, res) => {
  const { readdir, readFile } = await import('node:fs/promises');
  const dir = storeDir();
  const files = await readdir(dir).catch(() => []);
  const out = [];
  for (const f of files.filter(x => x.startsWith('ig-') && x.endsWith('.json'))) {
    try {
      const st = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
      const at = st.lastSyncAt || null;
      out.push({ username: st.username, lastSyncAt: at,
                 count: (st.items || []).length,
                 exhausted: st.exhausted === true,
                 ageH: at ? Math.round((Date.now() - new Date(at).getTime()) / 360000) / 10 : null });
    } catch {}
  }
  out.sort((a, b) => String(b.lastSyncAt).localeCompare(String(a.lastSyncAt)));
  res.json({ ttlHours: Number(process.env.IG_HISTORY_TTL_H || 24), pages: out });
}));

app.get('/api/instagram/capabilities', guard(async (_req, res) => {
  const c = await capabilities();
  res.json({ ...c, apify: apifyEnabled(),
             note: c.ocrPersian ? null : 'بسته‌ی فارسی tesseract نصب نیست: apt install tesseract-ocr-fas' });
}));

/** داده‌ی خام Apify حجیم است — در فهرست‌ها فرستاده نمی‌شود، ولی روی دیسک می‌ماند. */
function stripRaw(it) { const { raw, ...rest } = it || {}; return { ...rest, rawStored: Boolean(raw) }; }

markInterrupted().then(n => { if (n) console.log(`  ⚠ ${n} کار ناتمام از اجرای قبلی «interrupted» علامت خورد`); });

// ══ خودآزمایی ══════════════════════════════════════════════
//
// یک آدرس که همه‌چیز را چک می‌کند و می‌گوید کجا خراب است.
// در مرورگر باز کن:  http://<آی‌پی>:3000/api/selftest
// هیچ کلیدی در خروجی نیست — فقط «هست یا نیست».

// check() و timed() در lib/selftest.js هستند تا خودشان هم زیر تست بروند —
// قاعده‌شان یکی است: هر بررسی داخل try خودش، خطا به‌عنوان نتیجه‌ی همان بررسی.

// نسخه‌ی در حال اجرا — برای تشخیص اینکه مرورگر نسخه‌ی کش‌شده نشان می‌دهد یا نه
// ══ صفحه‌ی تشخیص، بدون جاوااسکریپت ═════════════════════════
//
// اگر رابط کاربری اصلی هیچ واکنشی نشان نمی‌دهد، این صفحه جواب می‌دهد:
// یک فرم ساده‌ی HTML که خودِ مرورگر ارسال می‌کند، بدون fetch و بدون JS.
// اگر این کار کند، شبکه سالم است و مشکل از جاوااسکریپت مرورگر است.
// اگر این هم کار نکند، درخواست اصلاً به سرور نمی‌رسد.

const page = (title, body) => `<!doctype html><html lang="fa" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
body{font-family:system-ui,sans-serif;max-width:640px;margin:0 auto;padding:20px;line-height:1.9;background:#faf9f7}
.ok{color:#137333}.bad{color:#c5221f}
input,button{font:inherit;padding:10px;width:100%;box-sizing:border-box;margin:6px 0;border:1px solid #ccc;border-radius:8px}
button{background:#1a1a1a;color:#fff;border:0}
pre{background:#fff;padding:12px;border-radius:8px;overflow:auto;font-size:12px;direction:ltr;text-align:left}
</style></head><body>${body}</body></html>`;

app.get('/diag', guard(async (_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(page('تشخیص وُهو', `
    <h2>این صفحه بدون جاوااسکریپت کار می‌کند</h2>
    <p>اگر این را می‌بینی، مرورگر به سرور می‌رسد.</p>
    <form method="POST" action="/diag">
      <p>حالا این دکمه را بزن. اگر نتیجه آمد، یعنی ارسال هم کار می‌کند
      و مشکل فقط از جاوااسکریپت صفحه‌ی اصلی است.</p>
      <input name="site" value="example.com">
      <button type="submit">آزمایش ارسال</button>
    </form>
    <p><a href="/api/selftest">خودآزمایی (JSON)</a> · <a href="/api/version">نسخه</a> · <a href="/">صفحه‌ی اصلی</a></p>`));
}));

app.post('/diag', guard(async (req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');

  // بدنه ممکن است فرم باشد نه JSON
  let site = req.body?.site;
  if (!site && typeof req.body === 'string') {
    const m = /site=([^&]*)/.exec(req.body);
    if (m) site = decodeURIComponent(m[1].replace(/\+/g, ' '));
  }

  const caps = await capabilities();
  res.end(page('نتیجه', `
    <h2 class="ok">✓ ارسال رسید</h2>
    <p>مرورگر تو می‌تواند به سرور درخواست بفرستد. پس شبکه و فایروال مشکلی ندارند
    و مشکل از جاوااسکریپت صفحه‌ی اصلی است.</p>
    <pre>${JSON.stringify({
      دریافت_شد: site || '(خالی)',
      مدل: (() => { try { return activeEngine().model; } catch { return null; } })(),
      سرویس: activeKey().provider,
      کلید: `${activeKey().name}: ${activeKey().set ? 'هست' : 'نیست'}`,
      توکن_آپیفای: apifyEnabled(),
      ffmpeg: caps.ffmpeg, tesseract: caps.tesseract
    }, null, 2)}</pre>
    <p><a href="/diag">برگرد</a></p>`));
}));

// شناسه‌ی نسخه یک بار موقع بالا آمدن خوانده می‌شود، نه هر درخواست: کدی که
// این پروسه اجرا می‌کند تا restart بعدی عوض نمی‌شود، حتی اگر HEAD وسط کار
// جلو برود. فایل BUILD حذف شد — چرایش در lib/selftest.js نوشته است.
const BUILD = buildId(here);   // ← لحظه‌ی بالا آمدن، نه لحظه‌ی درخواست

/**
 * کدِ در حال اجرا با کدِ روی دیسک یکی است؟
 *
 * Node ماژول‌ها را یک بار در import می‌خواند و دیگر عوضشان نمی‌کند. سروری که
 * قبل از یک تغییر بالا آمده، تا ری‌استارت همان پرامپت و همان اسکیمای قدیمی را
 * اجرا می‌کند — و /api/version تا امروز buildِ *دیسک* را نشان می‌داد، پس صفحه
 * می‌گفت کد تازه است درحالی‌که خروجی از کد قدیمی می‌آمد.
 *
 * این دقیقاً یک بار پیش آمد: قاعده‌ی تازه‌ی کارت استراتژی «اعمال نشد»، چون
 * سرور ۲۸ دقیقه قبل از آن قاعده بالا آمده بود.
 */
function staleBuild() {
  const onDisk = buildId(here);
  if (!BUILD || !onDisk || BUILD === onDisk) return null;
  return `کدِ در حال اجرا (${BUILD}) با کدِ روی دیسک (${onDisk}) یکی نیست — `
       + 'سرور از وقتی بالا آمده همان کد قدیمی را اجرا می‌کند. دوباره بالا بیاورش.';
}

app.get('/api/version', guard(async (_req, res) => {
  const build = BUILD;
  let engine = null;
  try { engine = activeEngine(); } catch { /* VOHU_PROVIDER نامعتبر — selftest می‌گوید */ }
  res.json({ build, startedAt: STARTED_AT, stale: staleBuild(),
             model: engine?.model || null, provider: engine?.provider || null });
}));

app.get('/api/selftest', guard(async (_req, res) => {
  const checks = [];

  // ⚠ هر بررسی داخل try خودش است — check() برای همگام‌ها، timed() برای
  // آن‌هایی که به بیرون زنگ می‌زنند. یک بررسی که می‌ترکد باید یک خط قرمز
  // بشود، نه اینکه بقیه را هم با خودش ببرد.
  //
  // مقدارهای مشترک (کلید، ماژول OpenAI، ابزارهای رسانه) یک بار و با احتیاط
  // گرفته می‌شوند؛ خطاشان نگه داشته می‌شود و فقط داخل همان بررسی‌هایی که به
  // آن نیاز دارند بالا می‌آید.

  checks.push(check('فایل .env', () =>
    ({ ok: Boolean(envFile), detail: envFile ? 'خوانده شد' : 'پیدا نشد' })));

  // ⚠ فقط کلید و مدلِ سرویسِ فعال «لازم» است. آن یکی اگر نباشد هم چیزی خراب
  // نیست — قرمز کردنش یعنی فرستادن کاربر دنبال کلیدی که خوانده نمی‌شود.
  let key = null, keyErr = null;
  try { key = activeKey(); } catch (e) { keyErr = String(e?.message || e); }
  const needKey = () => { if (keyErr) throw new Error(keyErr); return key; };
  // اگر خود activeKey شکسته باشد، محتاطانه فرض می‌کنیم کلاد لازم است
  const needAnthropic = key ? key.provider !== 'openai' : true;

  checks.push(check('ANTHROPIC_API_KEY', () => ({
    ok: needAnthropic ? needKey().set : true,
    detail: process.env.ANTHROPIC_API_KEY
      ? 'تعریف شده' + (needAnthropic ? '' : ' — ولی سرویس فعال openai است، خوانده نمی‌شود')
      : (needAnthropic ? 'تعریف نشده' : 'تعریف نشده — لازم هم نیست، سرویس فعال openai است') })));
  checks.push(check('کدِ در حال اجرا', () => {
    const stale = staleBuild();
    return { ok: !stale, detail: stale || `${BUILD || '؟'} — همان چیزی که روی دیسک است` };
  }));
  checks.push(check('VOHU_MODEL', () => ({
    ok: needAnthropic ? Boolean(process.env.VOHU_MODEL) : true,
    detail: process.env.VOHU_MODEL
      || (needAnthropic
            ? 'تعریف نشده' + (process.env.OPENAI_MODEL
                ? ` — مدل «${process.env.OPENAI_MODEL}» در OPENAI_MODEL نشسته که مسیر anthropic نمی‌خواندش`
                : '')
            : 'تعریف نشده — با openai مدل از OPENAI_MODEL می‌آید') })));
  checks.push(check('APIFY_TOKEN', () => ({
    ok: apifyEnabled(), detail: apifyEnabled() ? 'تعریف شده' : 'تعریف نشده — اینستاگرام خاموش است' })));

  // کدام سرویس؟ انتخاب صریح است، نه خودکار — و اگر مقدارش غلط باشد اینجا لو می‌رود
  let oa = null, oaErr = null;
  try { oa = await import('./services/openai.js'); } catch (e) { oaErr = String(e?.message || e); }
  const needOA = () => { if (oaErr) throw new Error(oaErr); return oa; };

  let engine = null, engineErr = null;
  try { engine = activeEngine(); } catch (e) { engineErr = e.message; }
  checks.push(check('VOHU_PROVIDER', () => ({
    ok: Boolean(engine),
    detail: engine ? `${engine.provider} · مدل ${engine.model || 'تعریف نشده'}` : engineErr })));
  checks.push(check('OPENAI_API_KEY', () => {
    const { openaiEnabled, openaiBase } = needOA();
    return { ok: engine?.provider === 'openai' ? openaiEnabled() : true,
             detail: openaiEnabled()
               ? `تعریف شده · ${openaiBase()}`
               : 'تعریف نشده' + (engine?.provider === 'openai' ? ' — ولی VOHU_PROVIDER=openai است!' : '') };
  }));

  let caps = null, capsErr = null;
  try { caps = await capabilities(); } catch (e) { capsErr = String(e?.message || e); }
  const needCaps = () => { if (capsErr) throw new Error(capsErr); return caps; };
  checks.push(check('ffmpeg', () => {
    const c = needCaps();
    return { ok: c.ffmpeg, detail: c.ffmpeg ? 'هست' : 'نصب نیست' };
  }));
  checks.push(check('tesseract', () => {
    const c = needCaps();
    return { ok: c.tesseract, detail: c.tesseract ? `زبان‌ها: ${c.langs.join(', ')}` : 'نصب نیست' };
  }));
  checks.push(check('OCR فارسی', () => {
    const c = needCaps();
    return { ok: c.ocrPersian, detail: c.ocrPersian ? 'هست' : 'apt install tesseract-ocr-fas' };
  }));

  // اینترنت بیرون
  checks.push(await timed('اینترنت (example.com)', async () => {
    const r = await fetch('https://example.com', { redirect: 'follow' });
    return { detail: `HTTP ${r.status}` };
  }, 15000));

  // دسترسی به API کلاد — بدون خرج‌کردن توکن.
  // با سرویس فعالِ openai اصلاً زده نمی‌شود: یک ۴۰۱ قرمز از سروری که
  // این اجرا هرگز با آن حرف نمی‌زند، فقط گمراه‌کننده است.
  if (needAnthropic) {
    checks.push(await timed('دسترسی به api.anthropic.com', async () => {
      const r = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY || '',
                   'anthropic-version': '2023-06-01' }
      });
      if (r.status === 401) return { detail: 'رسید ولی کلید پذیرفته نشد (۴۰۱)', ok: false };
      return { detail: `HTTP ${r.status}` };
    }, 20000));
  }

  // یک تماس واقعی و کوچک با مدل
  checks.push(await timed('یک تماس واقعی با مدل', async () => {
    const { callWithSchema } = await import('./services/vohuService.js');
    const out = await callWithSchema({
      prompt: 'فقط عدد ۷ را در فیلد n برگردان.',
      schema: { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } },
      toolName: 'ping', maxTokens: 64
    });
    return { detail: `مدل جواب داد: n=${out.data?.n} · ${out.meta?.model}` };
  }, 60000));

  if (oa?.openaiEnabled()) {
    checks.push(await timed('دسترسی به OpenAI', async () => {
      // openaiModel هم از همین ماژول می‌آید — قبلاً import نشده بود و این
      // بررسی همیشه با «تعریف نشده» می‌ترکید.
      const { openaiBase, openaiModel } = needOA();
      const model = openaiModel();
      const r = await fetch(`${openaiBase()}/models`,
        { headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });
      if (r.status === 401) return { detail: 'رسید ولی کلید پذیرفته نشد (۴۰۱)', ok: false };
      if (!r.ok) return { detail: `HTTP ${r.status}`, ok: false };
      // مدل تعریف‌شده واقعاً وجود دارد؟ حدس نزن، از خودشان بپرس.
      const body = await r.json().catch(() => null);
      const ids = (body?.data || []).map(m => m.id);
      const has = ids.includes(model);
      return { ok: has,
               detail: has ? `توکن معتبر است · ${model} موجود است`
                           : `توکن معتبر است ولی مدل «${model}» در فهرست نیست` };
    }, 20000));
  }

  if (apifyEnabled()) {
    checks.push(await timed('دسترسی به Apify', async () => {
      const r = await fetch('https://api.apify.com/v2/users/me',
        { headers: { authorization: `Bearer ${process.env.APIFY_TOKEN}` } });
      return { detail: r.ok ? 'توکن معتبر است' : `HTTP ${r.status}` , ok: r.ok };
    }, 20000));
  }

  const bad = checks.filter(c => c.ok === false);
  res.json({
    خلاصه: bad.length ? `${bad.length} مشکل: ${bad.map(b => b.name).join('، ')}` : 'همه‌چیز سالم است',
    checks
  });
}));


const server = app.listen(PORT, HOST, () => {
  const dry = process.env.VOHU_DRY_RUN ? '  · حالت خشک' : '';
  console.log(`\n  وُهو  →  http://localhost:${PORT}${dry}`);
  if (HOST === '0.0.0.0') console.log(`         →  http://<آی‌پی سرور>:${PORT}   (از بیرون)`);
  console.log('');

  // تشخیص دقیق: مشکل از نبودن فایل است یا از نبودن کلید داخل فایل؟
  if (process.env.VOHU_DRY_RUN) return;

  if (!envFile) {
    console.log(`  ⚠ فایل .env پیدا نشد. انتظار می‌رفت اینجا باشد:`);
    console.log(`     ${path.join(here, '.env')}\n`);
  } else {
    // کلیدِ سرویسِ فعال. با VOHU_PROVIDER=openai دنبال ANTHROPIC_API_KEY نمی‌گردیم.
    const key = activeKey();
    let engine = null;
    try { engine = activeEngine(); } catch (e) { console.log(`  ⚠ ${e.message}\n`); }

    if (!key.set) {
      console.log(`  ⚠ ${envFile} خوانده شد ولی ${key.name} داخلش نبود.`);
      console.log(`     سرویس فعال: ${key.provider || '؟'} — همین کلید را لازم دارد.`);
      console.log(`     کلیدهایی که پیدا شد: ${Object.keys(process.env).filter(k => k.startsWith('VOHU_') || k === 'ANTHROPIC_API_KEY' || k === 'OPENAI_API_KEY' || k === 'APIFY_TOKEN').join(', ') || '(هیچ)'}\n`);
    } else if (engine) {
      const modelVar = engine.provider === 'openai' ? 'OPENAI_MODEL' : 'VOHU_MODEL';
      console.log(`  ✓ ${key.name} خوانده شد · سرویس: ${engine.provider} · مدل: ${engine.model || `(${modelVar} تعریف نشده)`}\n`);
    }
  }
});

// پورت اشغال یعنی نسخه‌ی قبلی هنوز بالاست — نه اینکه چیزی خراب باشد
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`\n  ⚠ پورت ${PORT} از قبل اشغال است — نسخه‌ی قبلی وُهو هنوز در حال اجراست.\n`);
    console.log(`     ببندش:      kill $(lsof -t -i:${PORT})`);
    console.log(`     یا پورت دیگری بزن:  PORT=3001 npm start\n`);
    process.exit(1);
  }
  throw e;
});
