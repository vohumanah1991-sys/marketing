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

import path from 'node:path';

let pass = 0, fail = 0;
const ok = (c, m) => c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`));
const eq = (a, b, m) => ok(a === b, `${m} — انتظار ${JSON.stringify(b)}، دریافت ${JSON.stringify(a)}`);

// انبارِ خالیِ تازه — روی انبار فایلی یک پوشه‌ی موقت، روی SQLite یک دیتابیس
// تنانتِ موقت. همین یک خط باعث می‌شود این فایل روی هر دو میزبان کار کند.
const { enterFreshStore } = await import('../services/store.js');
await enterFreshStore();

const { startRun, advance } = await import('../lib/session.js');
const { loadMemory, memoryExists } = await import('../services/memory.js');
const { userDir, storeKind } = await import('../services/store.js');
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

// ── جداسازی کاربر ──
// دو انبار، دو سازوکار: روی فایل با runAsUser و پوشه‌ی کاربر؛ روی SQLite
// تنانت با فایلِ دیتابیسِ جدا و میدل‌ور تنانت. سنجیدنِ سازوکار *دیگری*
// یعنی تستی که یا الکی رد می‌شود یا بدتر، الکی سبز است.
const FILE_STORE = storeKind() === 'files';
if (FILE_STORE) {
  await runAsUser('tester-1', async () => {
    ok(userDir().endsWith(`${path.sep}tester-1`),
       `مسیرهای این کاربر زیر پوشه‌ی خودش است: ${userDir()}`);
  });
} else {
  console.log(`  ⓘ ادعای پوشه‌ی کاربر رد شد — انبار این میزبان «${storeKind()}» است`);
}

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
if (FILE_STORE) {
  const mem2 = await runAsUser('tester-2', () => loadMemory(URL_));
  eq(mem2.campaignHistory.length, 0, 'تستر ۲ روی همان آدرس، حافظه‌ی تستر ۱ را نمی‌بیند');
} else {
  // اینجا runAsUser کاری نمی‌کند و نباید هم بکند: جداسازی کارِ میدل‌ور
  // تنانت است. آزمونش در scripts/test-tenant.js همان میزبان است.
  console.log(`  ⓘ آزمون دو کاربره اینجا نه — انبار «${storeKind()}» جداسازی‌اش با تنانت است`);
}

// ── ردِ اسکیما اجرا را نمی‌کشد ──────────────────────────────
//
// قبلاً خروجی بدشکلِ مدل تا صداکننده بالا می‌رفت و ۵۰۰ می‌شد. از دید تستر
// «خطای سرور» روی کاری که هیچ ایرادی نداشت، و تنها راهش شروع از نو —
// یعنی دور ریختن مرحله‌هایی که پولشان داده شده بود.
//
// یک بار این اتفاق روی سرور واقعی افتاد (مرحله‌ی «سؤال‌ها»، دو بار پشت هم)
// و همان شد دلیل نوشتن این تست.
await runAsUser('tester-schema', async () => {
  const U = 'https://www.instagram.com/schema-reject-test';
  const run = await startRun({ url: U, note: 'آزمون ردِ اسکیما' });
  await advance(run);
  run.input.competitors = [];

  // از اینجا مرحله‌ی «سؤال‌ها» عمداً بدشکل جواب می‌دهد
  process.env.VOHU_DRY_FAIL = 'questions';

  const r1 = await advance(run);

  eq(r1.state, 'stage_failed', 'ردِ اسکیما یک حالت است، نه استثنا');
  eq(r1.needs, 'retryStage', 'رابط باید بداند چه دکمه‌ای نشان بدهد');
  ok(run.stageFailed, 'نشانِ شکست روی اجرا می‌نشیند');
  eq(run.stageFailed.stage, 'questions', 'کدام مرحله رد شد');
  eq(run.stageFailed.message, 'این مرحله خروجی درستی نداد. دوباره تلاش کن.',
     'جمله‌ای که کاربر می‌بیند');

  // مهم‌ترین ادعا: اجرا نمرده
  ok(run.stages.knowledge, 'شناخت کسب‌وکار سر جایش ماند');
  ok(run.stages.market,    'بازار سر جایش ماند');
  ok(run.stages.insight,   'جمله‌ی اول سر جایش ماند');
  ok(!run.stages.questions, 'ولی مرحله‌ی ردشده ذخیره نشد — خروجی نامعتبر از نبودش بدتر است');

  eq(run.schemaRejects.questions.streak, 1, 'ردِ اول شمرده شد');
  eq(run.schemaRejects.questions.total,  1, 'و در کل هم یک بار');

  // زیر آستانه، نامِ فیلد به کاربر گفته نمی‌شود — تلاش بعدی احتمالاً می‌گیرد
  eq(run.stageFailed.exhausted, false, 'یک بار رد یعنی هنوز جای تلاش دوباره هست');
  eq(run.stageFailed.fields.length, 0, 'و هنوز لازم نیست کاربر اسم فیلد اسکیما را ببیند');
  eq(run.stageFailed.advice, null, 'و هنوز پیشنهاد عوض‌کردن ورودی داده نمی‌شود');

  // ── سه بار پشت سر هم ──
  await advance(run);
  const r3 = await advance(run);

  eq(run.schemaRejects.questions.streak, 3, 'سه ردِ پشت سر هم شمرده شد');
  eq(r3.state, 'stage_failed', 'هنوز ۵۰۰ نیست — فقط دیگر امیدی به تکرار نیست');
  eq(run.stageFailed.exhausted, true, 'بعد از سه بار، تلاش دوباره جواب نیست');
  ok(run.stageFailed.fields.length > 0,
     `حالا باید بگوید کدام فیلد: ${JSON.stringify(run.stageFailed.fields)}`);
  ok(run.stageFailed.why.length > 0, 'و چه چیزی غلط آمد');
  ok(/ورودی را عوض کن/.test(run.stageFailed.advice || ''),
     `و پیشنهاد بدهد ورودی عوض شود: ${run.stageFailed.advice}`);

  // ── وقتی بالاخره گرفت ──
  delete process.env.VOHU_DRY_FAIL;
  await advance(run);

  ok(run.stages.questions, 'با خروجی درست، مرحله جلو می‌رود');
  ok(!run.stageFailed, 'نشانِ شکست برداشته می‌شود');
  eq(run.schemaRejects.questions.streak, 0, 'شمارنده‌ی پشت‌سرهم صفر می‌شود');
  eq(run.schemaRejects.questions.total, 3,
     'ولی کل ردها می‌ماند — این همان عددی است که می‌گوید پرامپت ایراد دارد یا ورودی');
});

// ── مرحله‌ی سؤال‌ها دو فراخوان است، ولی یک نتیجه ──────────────
//
// یک فراخوانِ «هم سؤال هم حدس» روی ورودی واقعی ۴۰٪ رد می‌شد. حالا دو
// فراخوان است. دو چیز باید سد داشته باشد:
//   ۱. قرارداد پایین‌دست عوض نشده باشد — همان { questions, assumptions }.
//   ۲. اگر نیمه‌ی دوم رد شود، تلاش دوباره پولِ نیمه‌ی اول را دوباره ندهد.
//      بدون این، دوتکه‌کردن هر ردی را دو برابر گران می‌کرد.
await runAsUser('tester-split', async () => {
  const U = 'https://www.instagram.com/split-questions-test';
  const run = await startRun({ url: U, note: 'آزمون دوتکه' });
  await advance(run);
  run.input.competitors = [];

  process.env.VOHU_DRY_FAIL = 'assumptions';      // فقط نیمه‌ی دوم رد شود
  const r = await advance(run);
  delete process.env.VOHU_DRY_FAIL;

  eq(r.state, 'stage_failed', 'ردِ نیمه‌ی دوم هم حالت است، نه ۵۰۰');
  eq(run.stageFailed.stage, 'assumptions', 'و می‌گوید کدام نیمه رد شد');
  ok(run.stages.questionsPart, 'نیمه‌ی اولِ موفق ذخیره شد — پولش دوباره داده نمی‌شود');
  ok(!run.stages.questions, 'ولی مرحله هنوز تمام نشده');

  const before = run.usage.calls;
  await advance(run);                              // تلاش دوباره

  ok(run.stages.questions, 'با نیمه‌ی دوم درست، مرحله کامل می‌شود');
  ok(Array.isArray(run.stages.questions.questions), 'قرارداد: questions آرایه است');
  ok(Array.isArray(run.stages.questions.assumptions), 'قرارداد: assumptions آرایه است');
  ok(!run.stages.questionsPart, 'نیمه‌ی موقت پاک می‌شود');
  eq(run.usage.calls - before, 1,
     'تلاش دوباره فقط یک فراخوان تازه دارد — نیمه‌ی اول دوباره صدا زده نمی‌شود');
});

// ── خطایی که واقعاً خطای سرور است، پنهان نمی‌شود ──
//
// اگر هر استثنایی به «حالت» تبدیل شود، خرابیِ واقعی سبز دیده می‌شود و آن
// از ۵۰۰ هم بدتر است. اینجا نبودِ fixture (یک خطای واقعی، نه بی‌انضباطیِ
// مدل) باید همان‌طور بالا برود.
//
// منابع عمداً *قبل* از خراب‌کردن fixtureها خوانده می‌شوند: شکستِ منبع خودش
// یک حالتِ مدیریت‌شده است و اگر از آن راه برویم، چیزی که می‌سنجیم آن است
// نه این.
await runAsUser('tester-schema', async () => {
  const U = 'https://www.instagram.com/real-error-test';
  const run = await startRun({ url: U, note: 'خطای غیراسکیما' });
  await advance(run);                       // منابع و شناخت با fixtureهای سالم
  run.input.competitors = [];
  ok(run.stages.knowledge, 'پیش‌شرط: تا شناخت رسیدیم');

  const keep = process.env.VOHU_FIXTURES;
  process.env.VOHU_FIXTURES = '/nonexistent-fixtures-dir';   // حالا fixture نیست
  let threw = null;
  try { await advance(run); } catch (e) { threw = e; }
  process.env.VOHU_FIXTURES = keep;

  ok(threw, 'خطای غیراسکیما همچنان بالا می‌رود، نه اینکه حالت شود');
  ok(/fixture/.test(String(threw?.message)), `و همان خطای واقعی است: ${threw?.message}`);
  ok(!run.stageFailed, 'و نشانِ «ردِ اسکیما» روی اجرا نمی‌نشیند');
});

// ── کلیدواژه‌ی شمارش ──
eq(actionKeyword('در کامنت بنویس «اصالت» تا برایت بفرستم'), 'اصالت', 'کلیدواژه از داخل گیومه');
eq(actionKeyword('در دایرکت کلمه‌ی اصالت را بفرست'), null, 'اقدام دایرکتی کلیدواژه‌ی شمردنی ندارد');
eq(actionKeyword('کامنت بگذار'), null, 'کامنت بدون کلیدواژه، شمارش خودکار ندارد');
eq(startFollowUp({ stages: {} }), null, 'بدون پیش‌بینی، سررسیدی هم نیست');

console.log(`\n  ${pass} قبول · ${fail} رد\n`);
process.exit(fail ? 1 : 0);
