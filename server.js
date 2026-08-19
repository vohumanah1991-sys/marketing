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
import { startRun, getRun, advance, normalizeSource } from './lib/session.js';
import { saveRun } from './services/store.js';
import { checkContent } from './lib/pipeline.js';
import { createJob, getJob, listJobs, registerHandler, markInterrupted } from './services/jobs.js';
import { syncInstagram, loadState, resolveLimits } from './lib/igSync.js';
import { analyzeItems } from './lib/igAnalyze.js';
import { capabilities } from './services/media.js';
import { apifyEnabled } from './services/apify.js';

const app  = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';   // روی سرور باید همه‌ی رابط‌ها باشد، نه فقط localhost
const here = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json({ limit: '2mb' }));

// هر درخواست لاگ می‌شود. اگر ترمینال ساکت است، یعنی درخواست اصلاً نرسیده —
// و آن یعنی مشکل از شبکه/مرورگر است، نه از برنامه.
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    const t0 = Date.now();
    console.log(`  ← ${req.method} ${req.path}`);
    res.on('finish', () =>
      console.log(`  → ${req.method} ${req.path} · ${res.statusCode} · ${Date.now() - t0}ms`));
  }
  next();
});

// صفحه هرگز کش نشود — وگرنه بعد از هر به‌روزرسانی، مرورگر نسخه‌ی قدیمی را نشان می‌دهد
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html'))
    res.setHeader('cache-control', 'no-store, must-revalidate');
  next();
});

app.use(express.static(path.join(here, 'public')));

// خطای مدل نباید کل سرور را بخواباند
const guard = fn => (req, res) => fn(req, res).catch(e => {
  console.error('[vohu]', e.message);
  res.status(500).json({ error: e.message });
});

const view = r => ({
  url: r.run.url, needs: r.needs, state: r.state, stages: r.stages,
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
                candidates: (r.run.stages.insight.candidates || []).map(c => ({ p: c.pattern, s: c.strength })),
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
  usage:     r.run.usage || null
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
  let run = fresh ? await startRun({ url, note }) : await getRun(url);
  if (!run.stages) run = await startRun({ url, note });
  if (note && !run.note) run.note = note;
  if (!run.stages.page) {
    const extra = [site, ig, tg].filter(Boolean).filter(x => x !== url);
    if (Array.isArray(sources)) extra.push(...sources.map(x => String(x || '').trim()).filter(Boolean));
    run.input.sources = [...new Set(extra)].slice(0, 5);
  }
  res.json(view(await advance(run)));
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
    elapsed: p?.startedAt ? Math.round((Date.now() - new Date(p.startedAt).getTime()) / 1000) : null,
    done: Boolean(p?.done),
    stages: Object.keys(run?.stages || {})
  });
}));

// وضعیت فعلی، بدون اجرای چیزی
app.get('/api/run', guard(async (req, res) => {
  const run = await getRun(req.query.url);
  res.json(view({ run, needs: null, state: 'loaded', stages: Object.keys(run.stages || {}) }));
}));

// رقبا
app.post('/api/run/competitors', guard(async (req, res) => {
  const run = await getRun(req.body.url);
  run.input.competitors = (req.body.competitors || []).filter(Boolean);
  await saveRun(run);
  res.json(view(await advance(run)));
}));

// جواب سؤال‌ها و حدس‌ها
app.post('/api/run/answers', guard(async (req, res) => {
  const run = await getRun(req.body.url);
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
  run.input.approved = true;
  await saveRun(run);
  res.json(view(await advance(run)));
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

async function timed(name, fn, ms = 20000) {
  const t0 = Date.now();
  try {
    const value = await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`بیش از ${ms / 1000}s طول کشید`)), ms))
    ]);
    return { name, ok: true, ms: Date.now() - t0, ...value };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - t0, error: String(e.message).slice(0, 200) };
  }
}

app.get('/api/selftest', guard(async (_req, res) => {
  const checks = [];

  checks.push({ name: 'فایل .env', ok: Boolean(envFile), detail: envFile ? 'خوانده شد' : 'پیدا نشد' });
  checks.push({ name: 'ANTHROPIC_API_KEY', ok: Boolean(process.env.ANTHROPIC_API_KEY),
                detail: process.env.ANTHROPIC_API_KEY ? 'تعریف شده' : 'تعریف نشده' });
  checks.push({ name: 'VOHU_MODEL', ok: Boolean(process.env.VOHU_MODEL),
                detail: process.env.VOHU_MODEL || 'تعریف نشده' });
  checks.push({ name: 'APIFY_TOKEN', ok: apifyEnabled(),
                detail: apifyEnabled() ? 'تعریف شده' : 'تعریف نشده — اینستاگرام خاموش است' });

  const caps = await capabilities();
  checks.push({ name: 'ffmpeg', ok: caps.ffmpeg, detail: caps.ffmpeg ? 'هست' : 'نصب نیست' });
  checks.push({ name: 'tesseract', ok: caps.tesseract,
                detail: caps.tesseract ? `زبان‌ها: ${caps.langs.join(', ')}` : 'نصب نیست' });
  checks.push({ name: 'OCR فارسی', ok: caps.ocrPersian,
                detail: caps.ocrPersian ? 'هست' : 'apt install tesseract-ocr-fas' });

  // اینترنت بیرون
  checks.push(await timed('اینترنت (example.com)', async () => {
    const r = await fetch('https://example.com', { redirect: 'follow' });
    return { detail: `HTTP ${r.status}` };
  }, 15000));

  // دسترسی به API کلاد — بدون خرج‌کردن توکن
  checks.push(await timed('دسترسی به api.anthropic.com', async () => {
    const r = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY || '',
                 'anthropic-version': '2023-06-01' }
    });
    if (r.status === 401) return { detail: 'رسید ولی کلید پذیرفته نشد (۴۰۱)', ok: false };
    return { detail: `HTTP ${r.status}` };
  }, 20000));

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
  } else if (!process.env.ANTHROPIC_API_KEY) {
    console.log(`  ⚠ ${envFile} خوانده شد ولی ANTHROPIC_API_KEY داخلش نبود.`);
    console.log(`     کلیدهایی که پیدا شد: ${Object.keys(process.env).filter(k => k.startsWith('VOHU_') || k === 'ANTHROPIC_API_KEY').join(', ') || '(هیچ)'}\n`);
  } else {
    console.log(`  ✓ کلید خوانده شد · مدل: ${process.env.VOHU_MODEL || '(VOHU_MODEL تعریف نشده)'}\n`);
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
