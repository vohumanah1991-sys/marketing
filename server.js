/**
 * سرور وُهو.
 *
 *   node server.js          →  http://localhost:3000
 *   PORT=8080 node server.js
 *
 * دو چیز سرو می‌کند: رابط کاربری در public/ و شش مسیر API.
 * وضعیت هر اجرا در .vohu/ ذخیره می‌شود — قابل ادامه بعد از بستن مرورگر.
 */

import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startRun, getRun, advance } from './lib/session.js';
import { saveRun } from './services/store.js';
import { checkContent } from './lib/pipeline.js';

const app  = express();
const PORT = process.env.PORT || 3000;
const here = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(here, 'public')));

// خطای مدل نباید کل سرور را بخواباند
const guard = fn => (req, res) => fn(req, res).catch(e => {
  console.error('[vohu]', e.message);
  res.status(500).json({ error: e.message });
});

const view = r => ({
  url: r.run.url, needs: r.needs, state: r.state, stages: r.stages,
  page:      r.run.stages.page ? { ok: r.run.stages.page.ok, error: r.run.stages.page.error } : null,
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
  condensed: r.run.stages.condensed || 0
});

// شروع یا ادامه
app.post('/api/run', guard(async (req, res) => {
  const { url, note, fresh } = req.body;
  if (!url) return res.status(400).json({ error: 'آدرس لازم است' });
  let run = fresh ? await startRun({ url, note }) : await getRun(url);
  if (!run.stages) run = await startRun({ url, note });
  if (note && !run.note) run.note = note;
  res.json(view(await advance(run)));
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

app.listen(PORT, () => {
  const dry = process.env.VOHU_DRY_RUN ? '  · حالت خشک' : '';
  console.log(`\n  وُهو  →  http://localhost:${PORT}${dry}\n`);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.VOHU_DRY_RUN)
    console.log('  ⚠ ANTHROPIC_API_KEY تعریف نشده\n');
});
