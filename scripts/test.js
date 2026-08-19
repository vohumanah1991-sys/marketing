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
import { sourceList, classify, whyBlocked, normalizeSource } from '../lib/session.js';
import { apifyEnabled, classifyInstagramUrl, redact } from '../services/apify.js';
import { itemsToText, contentType, extractTags, readTranscript, buildContentItem, itemToText } from '../lib/instagram.js';
import { resolveLimits } from '../lib/igSync.js';
import { isRealText, textResult, dedupeTexts } from '../services/media.js';

let pass = 0, fail = 0;
const failures = [];

const pending = [];
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(() => { pass++; }, e => { fail++; failures.push(`${name}\n     ${e.message}`); }));
    } else pass++;
  }
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

// ═══ منابع چندگانه ═══
t('چند منبع با هم خوانده می‌شوند، نه یکی به‌جای دیگری', () => {
  const l = sourceList({ url:'mokaab.ir', input:{ sources:['instagram.com/mokaab','t.me/mokaab'] } });
  eq(l.length, 3, 'هر سه منبع باید در فهرست باشند');
  eq(l[0].kind, 'site');
  eq(l[1].kind, 'instagram');
  eq(l[2].kind, 'telegram');
  ok(l.every(x => x.url.startsWith('https://')), 'همه باید https شوند');
});
t('منبع تکراری دو بار خوانده نمی‌شود', () => {
  const l = sourceList({ url:'https://a.com', input:{ sources:['a.com','https://a.com'] } });
  eq(l.length, 1);
});
t('اجرای قدیمی با یک url هنوز کار می‌کند', () => {
  eq(sourceList({ url:'a.com', input:{} }).length, 1);
});
t('اینستاگرام به‌عنوان اینستاگرام شناخته می‌شود نه سایت', () => {
  eq(classify('https://www.instagram.com/x/').kind, 'instagram');
  eq(classify('https://shop.example.com').kind, 'site');
});
t('علت بسته‌بودن به زبان آدمیزاد است و راه‌حل دارد', () => {
  const w = whyBlocked('https://instagram.com/x', 'HTTP 403');
  eq(w.kind, 'social');
  ok(w.text.length > 30, 'باید توضیح بدهد نه فقط کد خطا');
  ok(w.fix, 'باید بگوید کاربر چه کار کند');
  eq(whyBlocked('https://a.com', 'timeout').kind, 'timeout');
});
t('پرامپت استخراج با چند منبع، غیاب و نخواندن را قاطی نمی‌کند', () => {
  const p = V.EXTRACTION_PROMPT({ pageContent:'x', userNote:'', sources:[
    { label:'سایت', kind:'site', ok:true },
    { label:'اینستاگرام', kind:'instagram', ok:false, error:'HTTP 403' }]});
  ok(p.includes('اینستاگرام'), 'باید منبع نخوانده را نام ببرد');
  ok(/غیاب نیست/.test(p), 'باید صریح بگوید نخواندن ≠ نداشتن');
  const one = V.EXTRACTION_PROMPT({ pageContent:'x', userNote:'', sources:[{label:'سایت',kind:'site',ok:true}] });
  ok(!/غیاب نیست/.test(one), 'با یک منبع این بخش نباید بیاید');
});

t('ورودی کوتاه بدون @ و www و https پذیرفته می‌شود', () => {
  eq(normalizeSource('instagram','mokaab'), 'https://www.instagram.com/mokaab');
  eq(normalizeSource('instagram','@mokaab'), 'https://www.instagram.com/mokaab');
  eq(normalizeSource('instagram','instagram.com/mokaab/'), 'https://www.instagram.com/mokaab');
  eq(normalizeSource('instagram','https://www.instagram.com/mokaab?hl=fa'), 'https://www.instagram.com/mokaab');
  eq(normalizeSource('telegram','@mokaab'), 'https://t.me/mokaab');
  eq(normalizeSource('telegram','t.me/mokaab'), 'https://t.me/mokaab');
  eq(normalizeSource('site','www.mokaab.ir'), 'https://mokaab.ir');
  eq(normalizeSource('site','mokaab.ir/'), 'https://mokaab.ir');
});
t('ورودی بی‌معنی رد می‌شود نه اینکه آدرس بی‌ربط بسازد', () => {
  eq(normalizeSource('site','mokaab'), null, 'سایت بدون نقطه آدرس نیست');
  eq(normalizeSource('instagram',''), null);
  eq(normalizeSource('instagram','@'), null);
});

// ═══ اینستاگرام / Apify ═══
t('بدون توکن، Apify خاموش است — بی‌اجازه پول خرج نمی‌شود', () => {
  const saved = process.env.APIFY_TOKEN;
  delete process.env.APIFY_TOKEN;
  ok(!apifyEnabled(), 'بدون توکن باید خاموش باشد');
  process.env.APIFY_TOKEN = 'x';
  ok(apifyEnabled(), 'با توکن باید روشن شود');
  if (saved === undefined) delete process.env.APIFY_TOKEN; else process.env.APIFY_TOKEN = saved;
});
t('محتوای بدون آمار، صفر نمی‌گیرد', () => {
  const txt = itemsToText([{ type:'image', caption:'سلام', metrics:{likes:null,comments:null,views:null}, slides:[], comments:[] }]);
  ok(!/0 لایک/.test(txt), 'نبودِ عدد نباید به صفر تبدیل شود');
  ok(/سلام/.test(txt));
});
t('محتوای با آمار، عددش را نشان می‌دهد', () => {
  const txt = itemsToText([{ type:'reel', caption:'متن', publishedAt:'2026-08-01T00:00:00Z',
    metrics:{likes:120,comments:8,views:null,shares:3}, slides:[], comments:[] }]);
  ok(/120 لایک/.test(txt) && /8 کامنت/.test(txt) && /3 اشتراک/.test(txt));
  ok(/2026-08-01/.test(txt), 'تاریخ باید بیاید — کهنگی مهم است');
});
t('برش شناخت برای محتوا، فهرست محصولات را نمی‌فرستد', () => {
  const k = { brand:{v:1}, audience:{v:2}, products:[{name:'a'},{name:'b'}], productUsability:[{product:'a',usable:'yes'}] };
  const c = V.knowledgeFor('content', k);
  ok(c.brand && c.audience, 'صدا و مخاطب لازم است');
  ok(!c.products && !c.usableProducts, 'موجودی لازم نیست');
});

// ═══ استخراج عمیق اینستاگرام ═══
t('توکن Apify هرگز در لاگ یا خروجی نمی‌آید', () => {
  const dirty = 'خطا: Bearer apify_api_SECRET123 و ?token=apify_api_OTHER در URL';
  const clean = redact(dirty);
  ok(!/SECRET123/.test(clean) && !/OTHER/.test(clean), 'توکن باید کاملاً پاک شود');
});
t('نوع لینک درست تشخیص داده می‌شود', () => {
  eq(classifyInstagramUrl('https://www.instagram.com/mokaab/').kind, 'profile');
  eq(classifyInstagramUrl('https://instagram.com/reel/AB1/').kind, 'reel');
  eq(classifyInstagramUrl('https://instagram.com/p/AB1/').kind, 'post');
  eq(classifyInstagramUrl('https://instagram.com/explore/tags/x/').kind, 'unknown');
  eq(classifyInstagramUrl('https://example.com/p/AB1/').kind, 'unknown');
});
t('پست اسلایدی از تک‌عکس تشخیص داده می‌شود', () => {
  eq(contentType({ type:'Sidecar', childPosts:[{},{}] }), 'carousel');
  eq(contentType({ type:'Image' }), 'image');
  eq(contentType({ type:'Video', productType:'clips', videoUrl:'x' }), 'reel');
});
t('لینک صدا یا ویدئو به‌عنوان متن پذیرفته نمی‌شود', () => {
  eq(readTranscript({ transcript:'https://cdn.example.com/a.mp3' }).status, 'failed');
  eq(readTranscript({ transcript:'https://x.com/v.mp4' }).status, 'failed');
  eq(readTranscript({ transcript:'سلام امروز درباره عیار طلا حرف می‌زنیم' }).status, 'ok');
  ok(!isRealText('https://a.com/x.mp4'), 'لینک متن نیست');
});
t('متن خالی به‌عنوان استخراج موفق ثبت نمی‌شود', () => {
  eq(textResult('').status, 'failed');
  eq(textResult('   ').status, 'failed');
  eq(textResult('...').status, 'failed');
  eq(textResult('متن واقعی').status, 'ok');
  eq(textResult('').text, '', 'متن خالی باید خالی بماند نه اینکه چیزی ساخته شود');
});
t('Save و Reach همیشه null‌اند و هیچ‌وقت حدس زده نمی‌شوند', async () => {
  const it = await buildContentItem({ type:'Image', likesCount:10 }, { withMedia:false });
  eq(it.metrics.saves, null);
  eq(it.metrics.reach, null);
  eq(it.metrics.shares, null, 'نبودِ shares باید null بماند نه صفر');
  eq(it.metrics.likes, 10);
});
t('متن تکراری حذف می‌شود ولی جای هر متن معلوم می‌ماند', () => {
  const d = dedupeTexts([{text:'تخفیف ویژه',at:1},{text:'تخفیف ویژه',at:2},{text:'کد تخفیف',at:3}]);
  eq(d.length, 2);
  eq(d[0].at, 1);
  ok(d[0].alsoAt.includes(2), 'باید بگوید در اسلاید ۲ هم بود');
});
t('پرامپت تحلیل، نخوانده را با نبوده اشتباه نمی‌گیرد', () => {
  const p = V.CONTENT_ITEM_PROMPT({ item:{
    type:'reel', speechStatus:'failed', speechError:'اکتور transcript نداد',
    imageTextStatus:'ok', metrics:{likes:5,saves:null,reach:null}, __text:'x' }});
  ok(/غایب نیستند/.test(p), 'باید صریح بگوید نخوانده ≠ نبوده');
  ok(/ذخیره و ریچ/.test(p), 'باید درباره‌ی null بودن ذخیره و ریچ هشدار بدهد');
});
t('دلیل عملکرد هرگز واقعیت نیست', () => {
  const en = V.CONTENT_ITEM_SCHEMA.properties.performance.properties.status.enum;
  ok(!en.includes('fact'), 'وضعیت عملکرد نباید هیچ‌وقت fact باشد');
  ok(en.includes('hypothesis') && en.includes('inconclusive'));
});

t('پیش‌فرض ۱۰ پست و ۱۰ ریلز است، جدا از هم', () => {
  const d = resolveLimits();
  eq(d.posts, 10); eq(d.reels, 10);
});
t('می‌شود بیشتر خواست، و می‌شود یکی را خاموش کرد', () => {
  eq(resolveLimits({posts:30,reels:20}).posts, 30);
  eq(resolveLimits({posts:30,reels:20}).reels, 20);
  eq(resolveLimits({posts:0}).posts, 0, 'صفر یعنی نخوان، نه اینکه پیش‌فرض بگیرد');
  eq(resolveLimits({posts:0}).reels, 10, 'خاموش‌کردن یکی نباید دیگری را عوض کند');
});
t('ورودی بی‌معنی به پیش‌فرض برمی‌گردد و سقف رعایت می‌شود', () => {
  eq(resolveLimits({posts:'abc'}).posts, 10);
  eq(resolveLimits({reels:-5}).reels, 10);
  ok(resolveLimits({posts:99999}).posts <= 200, 'سقف مطلق باید اعمال شود');
});

t('هیچ نام برند یا آدرسی در کد و رابط کاربری هاردکد نشده', async () => {
  const { readFile } = await import('node:fs/promises');
  const files = ['public/index.html','lib/session.js','lib/igSync.js','lib/instagram.js',
                 'services/apify.js','services/media.js','server.js'];
  const bad = [];
  for (const f of files) {
    const txt = await readFile(new URL('../' + f, import.meta.url), 'utf8');
    // نام‌های خاصی که فقط مال یک کاربر است نباید در کد باشد
    for (const needle of ['mokaab', 'hatii', 'basalam.com/mokaab']) {
      if (txt.toLowerCase().includes(needle)) bad.push(`${f}: ${needle}`);
    }
  }
  eq(bad.length, 0, `هاردکد: ${bad.join(', ')}`);
});
t('آدرس اینستاگرام از ورودی می‌آید نه از کد', async () => {
  const { readFile } = await import('node:fs/promises');
  const txt = await readFile(new URL('../lib/igSync.js', import.meta.url), 'utf8');
  // تنها آدرس ثابت باید الگوی instagram.com/${username} باشد
  const literals = txt.match(/https:\/\/www\.instagram\.com\/(?!\$)[a-z0-9._]+/gi) || [];
  eq(literals.length, 0, `آدرس ثابت در کد: ${literals.join(', ')}`);
});

t('اسم هیچ مدلی در رابط کاربری هاردکد نشده', async () => {
  const { readFile } = await import('node:fs/promises');
  const ui = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const m of ['Opus', 'opus', 'Sonnet', 'sonnet', 'Haiku', 'claude-']) {
    ok(!ui.includes(m), `اسم مدل «${m}» در رابط کاربری نوشته شده — باید از سرور بیاید`);
  }
});

// ═══ گزارش ═══
await Promise.all(pending);
console.log(`\n  ${pass} قبول · ${fail} رد\n`);
if (fail) {
  failures.forEach(f => console.log(`  ✗ ${f}\n`));
  process.exit(1);
}
console.log('  ✓ همه‌ی ثابت‌ها برقرارند\n');
