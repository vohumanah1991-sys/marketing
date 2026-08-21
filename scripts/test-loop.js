/**
 * دو دور پشت‌سرهم — آزمون نیمه‌ی دوم حلقه.
 *
 *   npm run test:loop
 *
 * کاملاً خشک: هیچ شبکه‌ای، هیچ هزینه‌ای. همه‌چیز از fixtures می‌آید.
 *
 * چیزی که ثابت می‌کند:
 *   ۱. دور اول تا «چه شد؟» می‌رود و حلقه بسته می‌شود.
 *   ۲. حافظه‌ی کسب‌وکار در فایل جدا می‌نشیند و «شروع از نو» پاکش نمی‌کند.
 *   ۳. دور دوم آن حافظه را می‌خواند: campaignHistory دارد و سؤال تکراری نمی‌پرسد.
 *
 * بدون این تست، همه‌ی تکه‌ها جدا جدا کار می‌کنند و حلقه باز می‌ماند —
 * دقیقاً همان چیزی که تا امروز بود.
 */

process.env.VOHU_DRY_RUN  = '1';
process.env.VOHU_FIXTURES = './fixtures';
process.env.VOHU_MODEL    = 'dry';
process.env.APIFY_TOKEN   = 'apify_api_FAKE_FOR_TEST';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (c, m) => c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`));
const eq = (a, b, m) => ok(a === b, `${m} — انتظار ${JSON.stringify(b)}، دریافت ${JSON.stringify(a)}`);

process.env.VOHU_STORE_DIR = mkdtempSync(path.join(tmpdir(), 'vohu-loop-'));

const { startRun, advance } = await import('../lib/session.js');
const { loadMemory, memoryExists } = await import('../services/memory.js');
const { userDir } = await import('../services/store.js');
const { closeLoop, followUpStatus, actionKeyword, startFollowUp } = await import('../lib/followUp.js');
const { runAsUser, currentUser } = await import('../lib/userContext.js');
const { threadFatigue } = await import('../prompts/vohuPrompts.js');

const URL_ = 'https://www.instagram.com/loop-test';

/** یک دور کامل تا ساخت کمپین. جواب‌های کاربر همان‌هایی که رابط می‌فرستد. */
async function fullRound(note) {
  const run = await startRun({ url: URL_, note });
  await advance(run);                                    // منابع، شناخت → می‌ایستد روی رقبا
  run.input.competitors = ['رقیب الف'];
  await advance(run);                                    // بازار، جمله، سؤال‌ها → می‌ایستد روی جواب‌ها
  const asked = run.stages.questions?.questions || [];
  run.input.replies = {
    answers: Object.fromEntries(asked.map((_, i) => [`q${i + 1}`, 'جواب تستی'])),
    assumptionResponses: {}, constraints: []
  };
  await advance(run);                                    // کارت → می‌ایستد روی تأیید

  // قولِ تأییدنشده سد است: بدون جواب‌دادن به آن، تأیید جلو نمی‌رود.
  // همان کاری که رابط با دکمه‌های «درست است / نه» می‌کند.
  const pending = run.stages.strategy.pendingConfirmations || [];
  for (const p of pending) {
    const c = run.stages.strategy.cells[p.cell];
    c.needsConfirmation = false;
    c.confirmedAt = new Date().toISOString();
  }
  run.stages.strategy.pendingConfirmations = [];

  run.input.approved = true;
  await advance(run);                                    // تأیید + کمپین
  return { run, asked, pending };
}

console.log('\n── دور اول ──');
const r1 = await runAsUser('tester-1', () => fullRound('دور اول'));
eq(currentUser(), 'default', 'بیرون از context، کاربر پیش‌فرض است');
ok(r1.asked.length > 0, `دور اول ${r1.asked.length} سؤال پرسید`);
ok(r1.pending.length > 0, `قولِ تأییدنشده جلوی تأیید را گرفت: ${r1.pending.map(p => p.cell).join('، ')}`);
ok(Boolean(r1.run.stages.strategy?.approvedAt), 'کارت تأیید شد');
ok(Boolean(r1.run.stages.campaign), 'کمپین ساخته شد');

// ── سررسید ──
const f = r1.run.followUp;
ok(Boolean(f), 'پیش‌بینی و سررسیدش روی اجرا نشست');
eq(f.days, 14, 'سررسید ۱۴ روز بعد است');
eq(followUpStatus(r1.run).state, 'waiting', 'همین حالا هنوز سررسید نرسیده');
const due = followUpStatus(r1.run, { now: Date.parse(f.dueAt) + 1000 });
eq(due.state, 'due', 'بعد از ۱۴ روز، سررسید رسیده است');

// ── مسیرها زیر کاربر ──
await runAsUser('tester-1', async () => {
  ok(userDir().endsWith(`${path.sep}tester-1`),
     `مسیرهای این کاربر زیر پوشه‌ی خودش است: ${userDir()}`);
});

console.log('\n── بستن حلقه ──');
const closed = await runAsUser('tester-1', () => closeLoop(r1.run, {
  observations: [{ what: 'کامنت‌های منطبق', note: '7', how: 'counted' },
                 { what: 'آنچه کاربر دید', note: 'چند نفر پرسیدند', how: 'user_said' }],
  userAnswer: 'چند نفر پرسیدند'
}));
ok(['supported', 'weakened', 'inconclusive', 'contradicted'].includes(closed.outcome),
   `حکم دور: ${closed.outcome}`);
eq(followUpStatus(r1.run).state, 'done', 'بعد از ثبت، سررسید بسته است');

const mem1 = await runAsUser('tester-1', () => loadMemory(URL_));
eq(mem1.campaignHistory.length, 1, 'یک دور در تاریخچه نشست');
ok(mem1.campaignHistory[0].outcome, 'حکم دور ثبت شد — چه جواب داده باشد چه نه');
ok(mem1.askedQuestions.length === r1.asked.length,
   `سؤال‌های پرسیده‌شده ثبت شدند: ${mem1.askedQuestions.length}`);
ok(mem1.hypotheses.length > 0, `فرضیه‌ها از learn وارد حافظه شدند: ${mem1.hypotheses.length}`);

console.log('\n── دور دوم، روی همان کسب‌وکار ──');
const r2 = await runAsUser('tester-1', () => fullRound('دور دوم'));

const lm = r2.run.stages.knowledge.learningMemory;
ok(Boolean(lm), 'دور دوم حافظه را در knowledge.learningMemory دارد');
eq(lm.campaignHistory.length, 1, 'campaignHistory دور قبل خوانده شد');
ok(lm.hypotheses.length > 0, 'فرضیه‌های دور قبل هم آمدند');

// ⚠ قلب این تست: سؤال تکراری نباید دوباره پرسیده شود
const repeated = r2.asked.filter(q => mem1.askedQuestions.some(a => a.question === q.question));
eq(repeated.length, 0,
   `دور دوم نباید سؤال تکراری بپرسد (تکراری‌ها: ${repeated.map(q => q.question.slice(0, 30)).join(' | ')})`);
ok((r2.run.stages.questions.droppedAsAlreadyAsked || []).length > 0,
   'و باید بگوید کدام‌ها را چون قبلاً پرسیده حذف کرده');

// ── threadFatigue حالا واقعاً چیزی می‌بیند ──
const target = mem1.campaignHistory[0].target;
const fat = threadFatigue(lm.campaignHistory, target);
eq(fat.timesTargeted, 1, `threadFatigue گلوگاه «${target}» را یک بار هدف‌شده می‌بیند`);
ok(!fat.tired, 'با یک بار، هنوز خسته نیست — ولی دیگر کور هم نیست');

// ── «شروع از نو» حافظه را پاک نمی‌کند ──
await runAsUser('tester-1', async () => {
  const fresh = await startRun({ url: URL_, note: 'از نو' });
  ok(!fresh.stages.knowledge, 'اجرای تازه واقعاً تازه است');
  ok(await memoryExists(URL_), 'ولی حافظه‌ی کسب‌وکار سر جایش ماند');
  eq((await loadMemory(URL_)).campaignHistory.length, 1, 'و تاریخچه‌اش دست‌نخورده است');
});

// ── داده‌ی دو کاربر قاطی نمی‌شود ──
const mem2 = await runAsUser('tester-2', () => loadMemory(URL_));
eq(mem2.campaignHistory.length, 0, 'تستر ۲ روی همان آدرس، حافظه‌ی تستر ۱ را نمی‌بیند');

// ── کلیدواژه‌ی شمارش ──
eq(actionKeyword('در کامنت بنویس «اصالت» تا برایت بفرستم'), 'اصالت', 'کلیدواژه از داخل گیومه');
eq(actionKeyword('در دایرکت کلمه‌ی اصالت را بفرست'), null, 'اقدام دایرکتی کلیدواژه‌ی شمردنی ندارد');
eq(actionKeyword('کامنت بگذار'), null, 'کامنت بدون کلیدواژه، شمارش خودکار ندارد');
eq(startFollowUp({ stages: {} }), null, 'بدون پیش‌بینی، سررسیدی هم نیست');

console.log(`\n  ${pass} قبول · ${fail} رد\n`);
process.exit(fail ? 1 : 0);
