/**
 * مجموعه‌ی تست رگرسیون وُهو.
 *
 *   node scripts/test.js
 *
 * بعد از هر تغییری در پرامپت‌ها یا کد اجرا شود.
 * تمرکز روی **ثابت‌ها** است — چیزهایی که هرگز نباید نقض شوند،
 * نه اینکه خروجی مدل «خوب» باشد. آن را تست سرد می‌سنجد، نه این.
 */

import * as V from '../prompts/vohuPrompts.js';

let pass = 0, fail = 0;
const failures = [];

function t(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; failures.push(`${name}\n     ${e.message}`); }
}
function eq(a, b, msg)  { if (a !== b) throw new Error(`${msg || ''} — انتظار ${JSON.stringify(b)}، دریافت ${JSON.stringify(a)}`); }
function ok(v, msg)     { if (!v) throw new Error(msg || 'شرط برقرار نشد'); }

const STUB = { knowledge:{}, posts:[], competitors:[], insight:'x', answers:{}, constraints:[],
  pageContent:'x', userNote:'', mission:'m', content:'x', today:'2026-08-19', card:{}, prediction:'p',
  userAnswer:'y', userReason:null, edits:[], hypothesisHistory:[], operationalLevelAtRun:'x',
  competitorMap:null, contentAnalysis:null, hasMetrics:false, market:null, userSaid:[],
  occasions:[], capacity:{}, observations:[], strength:{}, previousPatterns:[], fatigue:[] };

// ═══ ۱ · ساختار ═══
const prompts = Object.keys(V).filter(k => k.endsWith('_PROMPT'));
const schemas = Object.keys(V).filter(k => k.endsWith('_SCHEMA'));

t('هر پرامپت یک اسکیمای متناظر دارد', () => {
  const missing = prompts.map(p => p.replace('_PROMPT','')).filter(n => !schemas.includes(n + '_SCHEMA'));
  eq(missing.length, 0, `بدون اسکیما: ${missing.join(', ')}`);
});

for (const p of prompts) t(`${p} با ورودی خالی خطا نمی‌دهد`, () => {
  const s = V[p](STUB);
  ok(typeof s === 'string' && s.length > 200, 'خروجی خالی یا خیلی کوتاه');
  ok(!s.includes('undefined'), 'رشته‌ی undefined در پرامپت نشت کرده');
  ok(!/\$\{/.test(s), 'قالب جایگزین‌نشده در خروجی مانده');
});

for (const s of schemas) t(`${s} ساختار معتبر دارد`, () => {
  const sc = V[s];
  eq(sc.type, 'object');
  ok(Array.isArray(sc.required) && sc.required.length > 0, 'فیلد required ندارد');
  for (const r of sc.required) ok(sc.properties?.[r], `فیلد الزامی ${r} در properties نیست`);
});

t('هر پرامپت هسته را در خود دارد', () => {
  for (const p of prompts) ok(V[p](STUB).includes('چهار قانون'), `${p} هسته را ندارد`);
});

// ═══ ۲ · ظرفیت ═══
t('واقع‌بینانه هرگز از ادعایی بیشتر نیست', () => {
  for (const n of [1,2,5,10]) {
    const r = V.realisticCapacity({ statedPerWeek:n, card:{prediction:{checkAfterDays:14}} });
    ok(r.realisticTotal <= r.statedTotal, `${n}: ${r.realisticTotal} > ${r.statedTotal}`);
  }
});
t('پنجره از کارت می‌آید نه از عدد ثابت', () => {
  const a = V.realisticCapacity({ statedPerWeek:2, card:{prediction:{checkAfterDays:14}} });
  const b = V.realisticCapacity({ statedPerWeek:2, card:{prediction:{checkAfterDays:28}} });
  eq(a.windowDays, 14); eq(b.windowDays, 28);
  ok(b.realisticTotal > a.realisticTotal, 'پنجره‌ی بلندتر باید قطعه‌ی بیشتری بدهد');
});
t('دور با مانع بیرونی ضریب را پایین نمی‌آورد', () => {
  const h = [{planned:2,published:2},{planned:2,published:0,externalBlock:'مریضی'},{planned:2,published:2}];
  const withFlag = V.realisticCapacity({ statedPerWeek:2, card:{}, history:h });
  const without  = V.realisticCapacity({ statedPerWeek:2, card:{}, history:h.map(x=>({planned:x.planned,published:x.published})) });
  ok(withFlag.ratio > without.ratio, 'محافظ دور بیرونی کار نمی‌کند');
  eq(withFlag.excluded, 1);
});
t('همیشه حداقل یک قطعه', () => {
  eq(V.realisticCapacity({ statedPerWeek:0, card:{} }).realisticTotal, 1);
});

// ═══ ۳ · کفایت شواهد ═══
t('نمونه‌ی کم اجازه‌ی الگو نمی‌دهد', () => {
  for (const n of [0,1,2,3,4]) eq(V.evidenceStrength({samples:n}).allowed, 'describe_only', `n=${n}`);
});
t('چند متغیر هم‌زمان، فرضیه را می‌بندد', () => {
  eq(V.evidenceStrength({samples:20,variantsCompared:5,biggestGapRatio:10}).allowed, 'weak_observation');
});
t('اختلاف کم = نویز', () => {
  eq(V.evidenceStrength({samples:20,variantsCompared:1,biggestGapRatio:1.4}).allowed, 'weak_observation');
});
t('فقط با نمونه و اختلاف کافی، فرضیه مجاز است', () => {
  eq(V.evidenceStrength({samples:10,variantsCompared:1,biggestGapRatio:3}).allowed, 'propose_hypothesis');
});
t('ادعاهای همیشه‌ممنوع فهرست شده‌اند', () => {
  ok(V.evidenceStrength({samples:100}).neverAllowed.length >= 3);
});

// ═══ ۴ · تقویم ═══
t('تقویم شمسی، میلادی و فصلی را می‌فهمد', () => {
  const today = new Date('2026-08-19');
  const cases = [['۱ فروردین','شمسی'],['early September','میلادی'],['زمستان','فصل فارسی'],['winter','فصل انگلیسی']];
  for (const [d,label] of cases) {
    const r = V.upcomingOccasions({demandCalendar:[{occasion:'x',approxDate:d,effect:'up'}]}, today);
    eq(r.length, 1, `${label} تفسیر نشد`);
    ok(r[0].daysUntil >= 0 && r[0].daysUntil <= 366, `${label}: فاصله‌ی نامعقول ${r[0].daysUntil}`);
  }
});
t('تاریخ نامفهوم حذف می‌شود نه اینکه صفر شود', () => {
  eq(V.upcomingOccasions({demandCalendar:[{occasion:'x',approxDate:'یک روزی',effect:'up'}]}).length, 0);
});
t('مناسبت‌ها مرتب برمی‌گردند', () => {
  const r = V.upcomingOccasions({demandCalendar:[
    {occasion:'دور',approxDate:'۱ خرداد',effect:'up'},{occasion:'نزدیک',approxDate:'۱ مهر',effect:'up'}]},
    new Date('2026-08-19'));
  ok(r[0].daysUntil <= r[1].daysUntil, 'مرتب نیست');
});

// ═══ ۵ · کهنگی ═══
t('کهنگی درست تشخیص داده می‌شود', () => {
  const today = new Date('2026-08-19');
  ok(V.isStale({validDays:7},  '2026-08-01', today).stale, 'محرک قیمتی باید کهنه باشد');
  ok(!V.isStale({validDays:180},'2026-08-01', today).stale, 'ترس دسته نباید کهنه باشد');
});
t('بدون validDays حکمی صادر نمی‌شود', () => {
  eq(V.isStale({}, '2026-01-01'), null);
});

// ═══ ۶ · خستگی نخ ═══
t('سه شکست بدون نتیجه = خسته', () => {
  const h = Array.from({length:3},(_,i)=>({target:'a',approach:'x',outcome:'weakened'}));
  ok(V.threadFatigue(h,'a').tired);
});
t('نخ موفق خسته نمی‌شود', () => {
  const h = [{target:'a',outcome:'supported'},{target:'a',outcome:'weakened'},{target:'a',outcome:'weakened'}];
  ok(!V.threadFatigue(h,'a').tired, 'نخی که یک بار جواب داده نباید بازنشسته شود');
});
t('چند رویکرد شکست‌خورده = پیشنهاد گام عقب', () => {
  const h = [{target:'a',approach:'p',outcome:'weakened'},{target:'a',approach:'q',outcome:'weakened'},
             {target:'a',approach:'r',outcome:'weakened'}];
  ok(V.threadFatigue(h,'a').suggestStepBack);
});

// ═══ ۷ · برش شناخت — مهم‌ترین ثابت‌ها ═══
const FULL = {
  business:{name:{value:'x',status:'fact'}},
  products:Array.from({length:20},(_,i)=>({name:`p${i}`,specs:{value:'x',status:'fact'}})),
  productUsability:[{product:'a',usable:'yes'},{product:'b',usable:true},
                    {product:'c',usable:'no'},{product:'d',usable:'unknown'}],
  constraints:[{what:'چهره',reason:'راحت نیستم'}],
  userStated:[{value:'گفته‌ی مهم',status:'fact'}],
  learningMemory:{hypotheses:[{claim:'h'}]},
  notChecked:['لینک‌ها']
};
for (const stage of ['questions','market','strategy','campaign']) {
  t(`برش ${stage} محدودیت‌ها را نمی‌اندازد`, () => {
    eq(V.knowledgeFor(stage,FULL).constraints.length, 1);
  });
  t(`برش ${stage} گفته‌های کاربر را نمی‌اندازد`, () => {
    eq(V.knowledgeFor(stage,FULL).userStated.length, 1);
  });
}
t('برش با هر دو قالب usable کار می‌کند', () => {
  eq(V.knowledgeFor('strategy',FULL).usableProducts.length, 2, 'باید هم yes هم true را بگیرد');
});
t('برش واقعاً کوچک‌تر می‌کند', () => {
  const full = JSON.stringify(FULL).length;
  const cut  = JSON.stringify(V.knowledgeFor('questions',FULL)).length;
  ok(cut < full * 0.8, `برش کوچک نکرد: ${cut} از ${full}`);
});
t('برش ناشناخته همه‌چیز را برمی‌گرداند', () => {
  eq(JSON.stringify(V.knowledgeFor('چیز-ناشناخته',FULL)), JSON.stringify(FULL));
});

// ═══ ۸ · فشرده‌سازی ═══
t('زیر آستانه دست نمی‌زند', () => {
  eq(V.condenseMemory({userStated:Array.from({length:10},(_,i)=>({topic:`دور ${i}`,value:'x'}))}).condensed, 0);
});
t('بالای آستانه فشرده می‌کند', () => {
  const k = {userStated:Array.from({length:40},(_,i)=>({topic:`دور ${i+1}`,value:'x'}))};
  const r = V.condenseMemory(k);
  ok(r.condensed > 0 && r.knowledge.userStated.length < 40);
});
t('فشرده‌سازی محدودیت‌ها و فرضیه‌ها را دست نمی‌زند', () => {
  const k = {userStated:Array.from({length:40},(_,i)=>({topic:`دور ${i+1}`,value:'x'})),
             constraints:[{what:'a'}], learningMemory:{hypotheses:[{claim:'h'}]}};
  const r = V.condenseMemory(k);
  eq(r.knowledge.constraints.length, 1);
  eq(r.knowledge.learningMemory.hypotheses.length, 1);
});
t('فشرده‌سازی ورودی را تغییر نمی‌دهد', () => {
  const k = {userStated:Array.from({length:40},(_,i)=>({topic:`دور ${i+1}`,value:'x'}))};
  V.condenseMemory(k);
  eq(k.userStated.length, 40, 'ورودی جهش خورد');
});

// ═══ ۹ · ادغام جواب‌ها ═══
t('جواب کاربر واقعیت می‌شود', () => {
  const r = V.mergeAnswers({}, {answers:{q1:'جواب'}});
  eq(r.userStated.length, 1);
  eq(r.userStated[0].status, 'fact');
});
t('حدس ردشده حذف می‌شود نه تعدیل', () => {
  const r = V.mergeAnswers({}, {assumptionResponses:{'حدس الف':'نه، برعکسه'}});
  eq(r.rejectedAssumptions.length, 1);
});
t('حدس تأییدشده واقعیت می‌شود', () => {
  const r = V.mergeAnswers({}, {assumptionResponses:{'حدس ب':'درست'}});
  ok(r.userStated.some(u => u.value === 'حدس ب'));
});
t('ادغام ورودی را تغییر نمی‌دهد', () => {
  const k = {};
  V.mergeAnswers(k, {answers:{a:'b'}});
  eq(k.userStated, undefined, 'ورودی جهش خورد');
});

// ═══ ۱۰ · دروازه‌ها ═══
t('دروازه‌ی رسیدن هرگز سد نمی‌شود', () => {
  const r = V.GATES.reachCheck({reach:{brokenLinks:['a','b'],orderPaths:['1','2','3','4','5']}});
  eq(r.blocking, false, 'blocking باید همیشه false باشد');
});
t('جمله‌ی کم‌اطمینان نمایش داده نمی‌شود', () => {
  ok(!V.GATES.canShowInsight({confident:0.5}).pass);
  ok(V.GATES.canShowInsight({confident:0.7}).pass);
});
t('ادعای بی‌پشتوانه اجازه‌ی انتشار نمی‌گیرد', () => {
  ok(!V.GATES.canPublish({claims:[{kind:'verifiable',status:'blocked'}]}).pass);
  ok(V.GATES.canPublish({claims:[{kind:'opinion',status:'n/a'}]}).pass);
});
t('قول و ادعای شخصی سد نیستند ولی تأیید می‌خواهند', () => {
  const r = V.GATES.canPublish({claims:[{kind:'commitment',status:'needsConfirmation'}]});
  eq(r.askUser.length, 1);
  ok(!r.pass, 'باید منتظر تأیید بماند');
});
t('کارت بدون تأیید اجازه‌ی محتوا نمی‌دهد', () => {
  ok(!V.GATES.canProduceContent({}).pass);
  ok(!V.GATES.canProduceContent({approvedAt:'x'}).pass, 'بدون پیش‌بینی هم نباید رد شود');
  ok(V.GATES.canProduceContent({approvedAt:'x',prediction:{observable:'y'}}).pass);
});
t('محصول نامطمئن از کاربر پرسیده می‌شود', () => {
  const r = V.GATES.usableProducts({productUsability:[
    {product:'a',usable:'yes'},{product:'b',usable:'unknown'},{product:'c',usable:'no',basis:'page_level'}]});
  eq(r.unsure.length, 2, 'unknown و استنباط‌شده هر دو باید پرسیده شوند');
  ok(r.askUser);
});

// ═══ گزارش ═══
console.log(`\n  ${pass} قبول · ${fail} رد\n`);
if (fail) {
  failures.forEach(f => console.log(`  ✗ ${f}\n`));
  process.exit(1);
}
console.log('  ✓ همه‌ی ثابت‌ها برقرارند\n');
