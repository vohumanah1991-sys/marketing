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
import { loadRun } from '../services/store.js';
import { costOf } from '../lib/session.js';
import { isRealText, textResult, dedupeTexts } from '../services/media.js';
import * as VS from '../services/vohuService.js';
import { faModelError, faModelHint, configuredProvider, activeEngine, callWithSchema } from '../services/vohuService.js';
import { openaiEnabled, openaiModel, openaiBase, redactOpenAI, faOpenAIError,
         isReasoningModel, openaiRoute, noteDroppedReasoningEffort,
         schemaIsStrict, readUsage, callOpenAISchema } from '../services/openai.js';

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

// مهرِ تولید در داده می‌ماند ولی هرگز وارد پرامپت نمی‌شود — قاعده‌ی
// «هر ورودی باید حذفش خروجی را عوض کند». مهر هیچ تصمیمی را عوض نمی‌کند.
const stampAll = v => {
  if (Array.isArray(v)) return v.map(stampAll);
  if (v && typeof v === 'object') {
    const o = { producedBy: { provider: 'openai', model: 'gpt-قلابی', at: '2026-08-20T00:00:00Z' } };
    for (const [k, x] of Object.entries(v)) o[k] = stampAll(x);
    return o;
  }
  return v;
};
const STAMPED = stampAll({ ...STUB, knowledge: { brand: {}, products: [{ name: 'x' }], learningMemory: {} },
                           market: {}, contentAnalysis: { capacities: [], topics: {}, flatSpots: [] },
                           card: { cells: {} }, strength: { neverAllowed: [{ x: 1 }] },
                           occasions: [{ name: 'نوروز' }], posts: [{ caption: 'x' }] });

for (const p of prompts) t(`${p} مهر تولید را وارد پرامپت نمی‌کند`, () => {
  const out = V[p](STAMPED);
  ok(!out.includes('producedBy'), 'رشته‌ی producedBy در پرامپت نشت کرده');
  ok(!out.includes('gpt-قلابی'), 'نام مدلِ سازنده در پرامپت نشت کرده');
});

t('knowledgeFor در هر برشی مهر را می‌اندازد', () => {
  const k = stampAll({ business: {}, brand: {}, learningMemory: { campaignHistory: [{ target: 'x' }] },
                       productUsability: [{ product: 'p', usable: 'yes' }] });
  for (const stage of ['questions', 'market', 'content', 'strategy', 'campaign', 'evidence', 'هیچ']) {
    const cut = JSON.stringify(V.knowledgeFor(stage, k));
    ok(!cut.includes('producedBy'), `برش ${stage} مهر را نگه داشته`);
  }
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

// ═══ رابط کاربری — دو باگی که ساعت‌ها وقت گرفتند ═══
t('هیچ ورودی‌ای مستقیم خوانده نمی‌شود — همه از val() رد می‌شوند', async () => {
  const { readFile } = await import('node:fs/promises');
  const ui = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const direct = ui.match(/\$\('#[A-Za-z0-9_]+'\)\.value/g) || [];
  eq(direct.length, 0,
     `خواندن مستقیم: ${direct.join(', ')} — spin() صفحه را پاک می‌کند و بعدش null.value می‌شود`);
  ok(/function val\(id\)/.test(ui), 'تابع val باید وجود داشته باشد');
});
t('هیچ <a> رویداد inline ندارد', async () => {
  const { readFile } = await import('node:fs/promises');
  const ui = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const bad = ui.match(/<a\b[^>]*\son[a-z]+=/gi) || [];
  eq(bad.length, 0,
     `<a> با onclick: خاصیت‌های خود عنصر (مثل ping و target) تابع سراسری هم‌نام را می‌پوشانند`);
});
t('نام هیچ تابع سراسری با خاصیت‌های عناصر تداخل ندارد', async () => {
  const { readFile } = await import('node:fs/promises');
  const ui = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const names = [...ui.matchAll(/^(?:async )?function ([a-zA-Z0-9_]+)\(/gm)].map(m => m[1]);
  const dom = ['ping','target','rel','download','href','name','type','form','title','id','value','text','media'];
  const clash = names.filter(n => dom.includes(n));
  eq(clash.length, 0, `تداخل با خاصیت DOM: ${clash.join(', ')}`);
});

t('اجرای تازه همیشه شکل حداقلی دارد — stages و input', async () => {
  process.env.VOHU_STORE_DIR = '/tmp/vohu-test-store-' + Math.random().toString(36).slice(2);
  const r = await loadRun('https://never-seen-' + Math.random().toString(36).slice(2) + '.com');
  ok(r.stages && typeof r.stages === 'object', 'stages باید باشد');
  ok(r.input  && typeof r.input  === 'object', 'input باید باشد — وگرنه اولین نوشتن منفجر می‌شود');
  ok(r.url, 'url باید باشد');
  // همان چیزی که در سرور می‌شکست
  r.input.sources = ['x'];
  eq(r.input.sources.length, 1);
});


// ═══ خطای مدل — کاربر باید بفهمد چه شد، نه اینکه JSON انگلیسی ببیند ═══
//
// این همان چیزی است که در اجرای واقعی دیده شد: «✗ کارت استراتژی — 400
// {"type":"error","error":{...}}». متن خام فقط جای لاگ سرور است.

const apiErr = (status, message, type = 'invalid_request_error') =>
  Object.assign(new Error(`${status} ${JSON.stringify({ type: 'error', error: { type, message } })}`),
    { status, error: { type: 'error', error: { type, message } } });

const CREDIT = 'Your credit balance is too low to access the Anthropic API.';

t('پیام خطای مدل هیچ‌وقت بلوک JSON خام نیست', () => {
  const cases = [
    apiErr(400, CREDIT), apiErr(401, 'invalid x-api-key'), apiErr(403, 'no access'),
    apiErr(404, 'model not found'), apiErr(413, 'too large'), apiErr(429, 'rate limit'),
    apiErr(500, 'internal'), apiErr(529, 'overloaded')
  ];
  for (const e of cases) {
    const m = faModelError(e);
    ok(!m.includes('{"type"'), `JSON خام نشت کرد: ${m}`);
    ok(!/^\d{3}\s/.test(m), `پیام با کد خام شروع شده: ${m}`);
    ok(/[\u0600-\u06FF]/.test(m), `پیام فارسی نیست: ${m}`);
  }
});

t('تمام‌شدن اعتبار با جمله‌ی خودش گفته می‌شود', () => {
  const m = faModelError(apiErr(400, CREDIT));
  ok(m.includes('اعتبار'), m);
  ok(!/credit balance/i.test(m), 'متن انگلیسی سرویس به کاربر نشان داده شد');
});

t('۴۰۱ کلید را نشان می‌دهد، ۴۲۹ و ۵۲۹ فرق دارند', () => {
  ok(faModelError(apiErr(401, 'x')).includes('ANTHROPIC_API_KEY'));
  ok(faModelError(apiErr(429, 'x')).includes('نرخ'));
  ok(faModelError(apiErr(529, 'x')).includes('شلوغ'));
  ok(faModelError(apiErr(429, 'x')) !== faModelError(apiErr(529, 'x')), 'دو خطای متفاوت یک پیام دارند');
});

t('۴۰۴ نام مدل خواسته‌شده را می‌گوید', () => {
  ok(faModelError(apiErr(404, 'not found'), { model: 'claude-x' }).includes('claude-x'));
});

t('مهلت و قطعی شبکه کد HTTP ندارند ولی پیام دارند', () => {
  class APIConnectionTimeoutError extends Error {}
  class APIConnectionError extends Error {}
  const to = faModelError(new APIConnectionTimeoutError('Request timed out.'), { timeoutMs: 180000 });
  ok(to.includes('180s'), to);
  ok(faModelError(new APIConnectionError('Connection error.')).includes('api.anthropic.com'));
});

t('راهنمای «حالا چه کار کنم» فقط جایی است که حرفی برای گفتن هست', () => {
  ok(faModelHint(apiErr(400, CREDIT)).includes('شارژ'));
  ok(faModelHint(apiErr(529, 'x')).includes('Anthropic'));
  eq(faModelHint(apiErr(400, 'something else')), null, 'برای خطای نامعلوم راهنمای ساختگی نمی‌دهیم');
});

t('حالت خشک هیچ‌وقت وارد مسیر خطای مدل نمی‌شود', () => {
  ok(faModelError({}) === 'خطای نامعلوم در تماس با مدل', 'خطای بی‌شکل هم پیام دارد');
});


// ═══ انتخاب سرویس — یک اجرا، یک سرویس ═══
//
// قاعده‌ای که نباید بشکند: هیچ تعویضی وسط کار. اگر سرویس انتخاب‌شده جواب
// نداد، اجرا شکست می‌خورد و می‌گوید چرا — نه اینکه نیمه‌کاره با مدل دیگری
// تمام شود. کارت استراتژیِ نصفه‌نصفه یک شاهد یکدست نیست (قاعده‌ی ۴).

const withEnv = (vars, fn) => {
  const old = {};
  for (const [k, v] of Object.entries(vars)) {
    old[k] = process.env[k];
    if (v === null) delete process.env[k]; else process.env[k] = v;
  }
  // برگرداندن محیط باید بعد از تمام‌شدن کار باشد، نه بعد از برگشتن promise
  const restore = () => { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  let r;
  try { r = fn(); } catch (e) { restore(); throw e; }
  if (r && typeof r.then === 'function') return r.then(v => { restore(); return v; }, e => { restore(); throw e; });
  restore();
  return r;
};

t('پیش‌فرض anthropic است', () => {
  withEnv({ VOHU_PROVIDER: null }, () => eq(configuredProvider(), 'anthropic'));
});

t('VOHU_PROVIDER=openai سرویس و مدل را عوض می‌کند', () => {
  withEnv({ VOHU_PROVIDER: 'openai', OPENAI_MODEL: 'gpt-test' }, () => {
    eq(configuredProvider(), 'openai');
    eq(activeEngine().model, 'gpt-test', 'مدل باید از OPENAI_MODEL بیاید نه VOHU_MODEL');
  });
});

t('مقدار نامعتبر VOHU_PROVIDER خطاست، نه پیش‌فرض بی‌صدا', () => {
  withEnv({ VOHU_PROVIDER: 'gemini' }, () => {
    let msg = null;
    try { configuredProvider(); } catch (e) { msg = e.message; }
    ok(msg && msg.includes('gemini'), 'باید صریح رد کند');
  });
});

t('منطق جایگزینی خودکار دیگر وجود ندارد', () => {
  ok(!('shouldFallback' in VS), 'shouldFallback باید حذف شده باشد');
  eq(typeof VS.activeEngine, 'function', 'به‌جایش انتخاب صریح آمده');
});

t('اجرا وسط کار سرویس عوض نمی‌کند — صریح می‌ایستد', async () => {
  await withEnv({ VOHU_PROVIDER: 'openai', VOHU_DRY_RUN: null, OPENAI_API_KEY: 'sk-test' }, async () => {
    let err = null;
    try {
      await callWithSchema({ prompt: 'x', schema: { type: 'object', required: [], properties: {} },
                             toolName: 'x', engine: { provider: 'anthropic', model: 'claude-sonnet-5' } });
    } catch (e) { err = e; }
    ok(err, 'باید خطا بدهد، نه اینکه با سرویس تازه ادامه دهد');
    ok(err.message.includes('anthropic') && err.message.includes('openai'), err.message);
    ok(err.hint && err.hint.includes('تازه'), 'باید بگوید اجرای تازه لازم است');
  });
});

t('اجرا وسط کار مدل هم عوض نمی‌کند — همان‌طور که سرویس', async () => {
  await withEnv({ VOHU_PROVIDER: 'anthropic', VOHU_MODEL: 'claude-sonnet-5', VOHU_DRY_RUN: null }, async () => {
    let err = null;
    try {
      await callWithSchema({ prompt: 'x', schema: { type: 'object', required: [], properties: {} },
                             toolName: 'x', engine: { provider: 'anthropic', model: 'claude-opus-5' } });
    } catch (e) { err = e; }
    ok(err, 'باید خطا بدهد، نه اینکه با مدل تازه ادامه دهد');
    ok(err.message.includes('claude-opus-5') && err.message.includes('VOHU_MODEL'), err.message);
    ok(err.hint.includes('یادگیری'), 'باید بگوید چرا: مقایسه‌ی دوربه‌دور و حافظه‌ی یادگیری');
  });
});

t('قفل مدل برای openai هم هست، با نام متغیر خودش', async () => {
  await withEnv({ VOHU_PROVIDER: 'openai', OPENAI_MODEL: 'gpt-4.1', OPENAI_API_KEY: 'sk-t', VOHU_DRY_RUN: null }, async () => {
    let err = null;
    try {
      await callWithSchema({ prompt: 'x', schema: { type: 'object', required: [], properties: {} },
                             toolName: 'x', engine: { provider: 'openai', model: 'gpt-قدیمی' } });
    } catch (e) { err = e; }
    ok(err && err.message.includes('OPENAI_MODEL'), err?.message);
  });
});

t('VOHU_PROVIDER=openai بدون کلید، صریح می‌ایستد', async () => {
  await withEnv({ VOHU_PROVIDER: 'openai', OPENAI_API_KEY: null, VOHU_DRY_RUN: null }, async () => {
    let err = null;
    try { await callWithSchema({ prompt: 'x', schema: { type: 'object', required: [], properties: {} }, toolName: 'x' }); }
    catch (e) { err = e; }
    ok(err && err.message.includes('OPENAI_API_KEY'), err?.message);
  });
});

t('VOHU_MODEL که نیست ولی OPENAI_MODEL هست — پیام می‌گوید مدل کجا نشسته', async () => {
  // مسیر anthropic نام مدل را فقط از VOHU_MODEL می‌خواند. کسی که OPENAI_MODEL را
  // پر کرده، یک نام مدل جلوی چشمش در .env دارد و «تعریف نشده» را باور نمی‌کند.
  const err = await withEnv(
    { VOHU_PROVIDER: 'anthropic', VOHU_MODEL: null, OPENAI_MODEL: 'gpt-5-mini', VOHU_DRY_RUN: null },
    async () => {
      try {
        await callWithSchema({ prompt: 'x', schema: { type: 'object', required: [], properties: {} }, toolName: 'x' });
        return null;
      } catch (e) { return e; }
    });

  ok(err, 'باید بایستد، نه اینکه بی‌مدل جلو برود');
  ok(err.message.includes('VOHU_MODEL'), `باید نام متغیر درست را بگوید: ${err.message}`);
  ok(err.hint && err.hint.includes('gpt-5-mini'), `باید بگوید مدل کجا نشسته: ${err.hint}`);
  ok(err.hint.includes('VOHU_MODEL=gpt-5-mini'), `باید همان خطی را بدهد که باید به .env اضافه شود: ${err.hint}`);

  // و بدون OPENAI_MODEL هم کاربر بی‌راهنما نمی‌ماند
  const bare = await withEnv(
    { VOHU_PROVIDER: 'anthropic', VOHU_MODEL: null, OPENAI_MODEL: null, VOHU_DRY_RUN: null },
    async () => {
      try { await callWithSchema({ prompt: 'x', schema: { type: 'object', required: [], properties: {} }, toolName: 'x' }); return null; }
      catch (e) { return e; }
    });
  ok(bare?.hint?.includes('VOHU_MODEL='), `راه ادامه باید همیشه باشد: ${bare?.hint}`);
  ok(!bare.hint.includes('undefined'), `نبودِ OPENAI_MODEL نباید در پیام نشت کند: ${bare.hint}`);
});

t('هر خروجی مهر سازنده‌اش را می‌گیرد (producedBy)', async () => {
  await withEnv({ VOHU_DRY_RUN: '1', VOHU_FIXTURES: './fixtures' }, async () => {
    const { data, meta } = await callWithSchema({
      prompt: 'x', schema: { type: 'object', required: [], properties: {} }, toolName: 'هیچ‌فایلی' });
    ok(data.producedBy, 'producedBy باید روی خروجی بنشیند');
    eq(data.producedBy.provider, meta.provider);
    eq(data.producedBy.model, meta.model);
    ok(data.producedBy.at, 'تاریخ ساخت باید باشد');
  });
});

t('راهنمای خطا دیگر وعده‌ی جایگزینی خودکار نمی‌دهد', () => {
  const h = faModelHint(apiErr(400, CREDIT)) || '';
  ok(!h.includes('خودکار'), `راهنما هنوز از جایگزینی خودکار حرف می‌زند: ${h}`);
});

// ═══ لایه‌ی OpenAI — مانده، ولی فقط «چطور حرف بزنیم» ═══

t('آدرس و مدل OpenAI از .env می‌آیند، با پیش‌فرض سالم', () => {
  withEnv({ OPENAI_BASE_URL: null, OPENAI_MODEL: null }, () => {
    eq(openaiBase(), 'https://api.openai.com/v1');
    ok(openaiModel().length > 0, 'مدل پیش‌فرض باید باشد');
  });
  withEnv({ OPENAI_BASE_URL: 'https://gateway.example.com/v1/' }, () =>
    eq(openaiBase(), 'https://gateway.example.com/v1', 'اسلش آخر باید برداشته شود'));
});

t('کلید OpenAI هرگز در متن خطا یا لاگ نمی‌ماند', () => {
  const leak = 'auth failed for sk-proj-ABCdef1234567890 with Bearer sk-abc123456789';
  const clean = redactOpenAI(leak);
  ok(!clean.includes('sk-proj-ABCdef1234567890'), `کلید نشت کرد: ${clean}`);
  ok(!clean.includes('sk-abc123456789'), `کلید نشت کرد: ${clean}`);
  ok(!faOpenAIError(400, { error: { message: leak } }).includes('sk-proj-ABC'), 'کلید در پیام خطا ماند');
});

t('خطای OpenAI هم فارسی است، نه JSON', () => {
  const cases = [
    faOpenAIError(401, { error: { message: 'Incorrect API key' } }),
    faOpenAIError(429, { error: { message: 'quota', code: 'insufficient_quota' } }),
    faOpenAIError(500, { error: { message: 'server error' } }),
    faOpenAIError('timeout', 'x', { timeoutMs: 180000 }),
    faOpenAIError('network', 'x')
  ];
  for (const m of cases) {
    ok(/[\u0600-\u06FF]/.test(m), `فارسی نیست: ${m}`);
    ok(!m.includes('{"'), `JSON خام نشت کرد: ${m}`);
  }
});

t('مدل OpenAI قیمت ساختگی نمی‌گیرد', () => {
  eq(costOf('gpt-4.1', 1000, 1000), null, 'قیمت ناشناخته باید null بماند، نه صفر');
  ok(costOf('claude-sonnet-5', 1e6, 0) > 0, 'قیمت مدل شناخته‌شده باید حساب شود');
});

// ── دو مسیر، یک قرارداد ─────────────────────────────────────
// مدل استدلالی از /responses می‌رود تا هم‌زمان reasoning و ابزار داشته باشد؛
// مدل معمولی همان chat/completions. تصمیم را نام مدل می‌گیرد، نه یک متغیر جدا.

// یک OpenAI قلابی: می‌گوید چه چیزی به کجا فرستاده شد، بدون شبکه.
const fakeOpenAI = (reply) => {
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opt) => {
    seen.push({ url: String(url), body: JSON.parse(opt.body), headers: opt.headers });
    return { ok: true, status: 200, text: async () => JSON.stringify(reply) };
  };
  return { seen, restore: () => { globalThis.fetch = real; } };
};

const RESPONSES_OK = {
  status: 'completed',
  output: [{ type: 'reasoning', summary: [] },
           { type: 'function_call', name: 'x', arguments: '{"a":1}' }],
  usage: { input_tokens: 11, output_tokens: 22 }
};
const CHAT_OK = {
  choices: [{ message: { tool_calls: [{ function: { arguments: '{"a":1}' } }] } }],
  usage: { prompt_tokens: 11, completion_tokens: 22 }
};
const SCHEMA = { type: 'object', required: ['a'], properties: { a: { type: 'integer' } } };

t('مدل استدلالی به /responses می‌رود و reasoning همراهش می‌ماند', async () => {
  eq(openaiRoute('gpt-5-mini'), '/responses');
  eq(openaiRoute('o3'), '/responses');
  eq(openaiRoute('gpt-4.1'), '/chat/completions');

  const f = fakeOpenAI(RESPONSES_OK);
  let out;
  try {
    out = await withEnv({ OPENAI_API_KEY: 'sk-t', OPENAI_BASE_URL: null, OPENAI_REASONING_EFFORT: 'high' }, () =>
      callOpenAISchema({ prompt: 'x', schema: SCHEMA, toolName: 'x', model: 'gpt-5-mini' }));
  } finally { f.restore(); }

  const [req] = f.seen;
  eq(req.url, 'https://api.openai.com/v1/responses', 'مدل استدلالی باید از /responses برود');
  eq(req.body.reasoning?.effort, 'high', 'reasoning_effort دیگر دور ریخته نمی‌شود');
  ok(req.body.tools?.[0]?.name === 'x' && req.body.tools[0].type === 'function',
     `ابزار در /responses تخت است: ${JSON.stringify(req.body.tools)}`);
  eq(req.body.tool_choice?.name, 'x', 'ابزار همچنان اجباری است');
  eq(req.body.max_output_tokens, 8000, 'سقف توکن در /responses نام دیگری دارد');
  ok(!('max_completion_tokens' in req.body), 'کلید مسیر chat نباید اینجا بیاید');
  eq(out.data.a, 1);
});

t('مدل معمولی همان chat/completions می‌ماند و reasoning داخلش نمی‌رود', async () => {
  const f = fakeOpenAI(CHAT_OK);
  try {
    await withEnv({ OPENAI_API_KEY: 'sk-t', OPENAI_BASE_URL: null, OPENAI_REASONING_EFFORT: 'high' }, () =>
      callOpenAISchema({ prompt: 'x', schema: SCHEMA, toolName: 'x', model: 'gpt-4.1' }));
  } finally { f.restore(); }

  const [req] = f.seen;
  eq(req.url, 'https://api.openai.com/v1/chat/completions', 'مدل معمولی نباید به /responses برود');
  ok(!('reasoning' in req.body) && !('reasoning_effort' in req.body),
     `این پارامتر در مسیر chat جا ندارد: ${JSON.stringify(req.body)}`);
  ok(req.body.tools?.[0]?.function?.name === 'x', 'ابزار در chat تودرتو است');
  eq(req.body.tool_choice?.function?.name, 'x', 'ابزار همچنان اجباری است');
});

t('خروجی هر دو مسیر دقیقاً یک شکل است — بقیه‌ی زنجیره نباید بفهمد', async () => {
  const run = async (model, reply) => {
    const f = fakeOpenAI(reply);
    try {
      return await withEnv({ OPENAI_API_KEY: 'sk-t', OPENAI_BASE_URL: null, OPENAI_REASONING_EFFORT: null }, () =>
        callOpenAISchema({ prompt: 'x', schema: SCHEMA, toolName: 'x', model }));
    } finally { f.restore(); }
  };
  const r1 = await run('gpt-5-mini', RESPONSES_OK);
  const r2 = await run('gpt-4.1', CHAT_OK);

  eq(JSON.stringify(Object.keys(r1.meta).sort()), JSON.stringify(Object.keys(r2.meta).sort()),
     'کلیدهای meta باید یکی باشند');
  eq(JSON.stringify(r1.data), JSON.stringify(r2.data), 'data باید همان شکل باشد');
  for (const r of [r1, r2]) {
    eq(r.meta.provider, 'openai');
    eq(r.meta.inputTokens, 11, 'شمارش توکن ورودی در هر دو مسیر خوانده شود');
    eq(r.meta.outputTokens, 22, 'شمارش توکن خروجی در هر دو مسیر خوانده شود');
    ok(typeof r.meta.ms === 'number', 'زمان باید عدد باشد');
  }
});

t('فیلد اجباریِ نبوده، در هر دو مسیر گیر می‌افتد', async () => {
  const bad = async (model, reply) => {
    const f = fakeOpenAI(reply);
    try {
      await withEnv({ OPENAI_API_KEY: 'sk-t' }, () =>
        callOpenAISchema({ prompt: 'x', schema: SCHEMA, toolName: 'x', model }));
      return null;
    } catch (e) { return e.message; } finally { f.restore(); }
  };
  const m1 = await bad('gpt-5-mini', { output: [{ type: 'function_call', name: 'x', arguments: '{}' }] });
  const m2 = await bad('gpt-4.1', { choices: [{ message: { tool_calls: [{ function: { arguments: '{}' } }] } }] });
  ok(m1 && m1.includes('a'), `مسیر responses باید فیلد نبوده را بگوید: ${m1}`);
  ok(m2 && m2.includes('a'), `مسیر chat باید فیلد نبوده را بگوید: ${m2}`);
});

t('وقتی استدلال کل سقف توکن را می‌خورد، پیام می‌گوید کدام دستگیره را بچرخان', async () => {
  const f = fakeOpenAI({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] });
  let msg = null;
  try {
    await withEnv({ OPENAI_API_KEY: 'sk-t' }, () =>
      callOpenAISchema({ prompt: 'x', schema: SCHEMA, toolName: 'x', model: 'gpt-5-mini', maxTokens: 64 }));
  } catch (e) { msg = e.message; } finally { f.restore(); }
  ok(msg && /[\u0600-\u06FF]/.test(msg), `باید فارسی باشد: ${msg}`);
  ok(msg.includes('gpt-5-mini') && msg.includes('64'), `مدل و سقف باید در پیام باشند: ${msg}`);
  ok(/OPENAI_REASONING_EFFORT|سقف توکن را بالا/.test(msg), `راه ادامه باید در پیام باشد: ${msg}`);
});

t('مدلی که در حساب نیست، با نام خودش گزارش می‌شود', () => {
  // ۴۰۴ مسیر chat و ۴۰۰ِ code=model_not_found مسیر responses — یک حرف، یک پیام.
  const a = faOpenAIError(404, { error: { message: 'not found' } }, { model: 'gpt-5-جعلی' });
  const b = faOpenAIError(400, { error: { message: 'The model does not exist', code: 'model_not_found' } },
                          { model: 'gpt-5-جعلی', route: '/responses' });
  for (const m of [a, b]) {
    ok(m.includes('gpt-5-جعلی'), `نام مدل باید در پیام باشد: ${m}`);
    ok(m.includes('OPENAI_MODEL'), `باید بگوید کدام کلید را عوض کند: ${m}`);
    ok(/[\u0600-\u06FF]/.test(m) && !m.includes('{"'), `فارسی و بدون JSON خام: ${m}`);
  }
  // درگاه واسطی که /responses ندارد، نباید با «مدل نیست» قاطی شود
  const gw = faOpenAIError(404, { error: { message: 'Unknown path' } },
                           { model: 'o3', route: '/responses' });
  ok(gw.includes('/responses') && gw.includes('OPENAI_BASE_URL'), `بن‌بست درگاه باید راه دررو داشته باشد: ${gw}`);
});

t('تلاش برای reasoning روی مدل غیراستدلالی بی‌سروصدا نمی‌افتد — یک خط لاگ می‌شود', () => {
  const warn = console.warn;
  const lines = [];
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    noteDroppedReasoningEffort('high', 'gpt-4.1-تست');
    noteDroppedReasoningEffort('high', 'gpt-4.1-تست');   // تکرار نباید لاگ تازه بسازد
    eq(noteDroppedReasoningEffort('low', 'o3-mini-تست'), null, 'روی مدل استدلالی اعمال می‌شود، پس لاگی ندارد');
    eq(noteDroppedReasoningEffort(undefined, 'gpt-4.1'), null, 'وقتی چیزی خواسته نشده، لاگی هم نیست');
  } finally { console.warn = warn; }
  eq(lines.length, 1, `فقط یک خط، آن هم برای مدل غیراستدلالی: ${JSON.stringify(lines)}`);
  ok(lines[0].includes('استدلالی نیست') && lines[0].includes('OPENAI_MODEL'), lines[0]);
  ok(isReasoningModel('o1') && isReasoningModel('gpt-5.1') && !isReasoningModel('gpt-4.1'),
     'تشخیص مدل استدلالی');
});

t('مقدار بی‌معنا برای reasoning همان اول می‌ایستد، نه با ۴۰۰ انگلیسی', async () => {
  let msg = null;
  try {
    await withEnv({ OPENAI_API_KEY: 'sk-t', OPENAI_REASONING_EFFORT: 'خیلی-زیاد' }, () =>
      callOpenAISchema({ prompt: 'x', schema: SCHEMA, toolName: 'x', model: 'gpt-5-mini' }));
  } catch (e) { msg = e.message; }
  ok(msg && msg.includes('خیلی-زیاد'), `باید بگوید چه مقداری غلط بود: ${msg}`);
  ok(msg.includes('high') && msg.includes('low'), `باید مقدارهای معتبر را بشمارد: ${msg}`);
});

t('نبودِ OPENAI_REASONING_EFFORT یعنی medium، نه استدلالِ خاموش', async () => {
  const f = fakeOpenAI(RESPONSES_OK);
  try {
    await withEnv({ OPENAI_API_KEY: 'sk-t', OPENAI_BASE_URL: null, OPENAI_REASONING_EFFORT: null }, () =>
      callOpenAISchema({ prompt: 'سلام', schema: SCHEMA, toolName: 'x', model: 'gpt-5-mini' }));
  } finally { f.restore(); }

  const [req] = f.seen;
  eq(req.body.reasoning?.effort, 'medium', 'پیش‌فرض باید صریح فرستاده شود، نه سپرده به OpenAI');
  eq(req.body.input, 'سلام', 'پرامپت همان متن است');
  ok(!('reasoning_effort' in req.body), 'در /responses نامش reasoning.effort است، نه reasoning_effort');
});

t('پیش‌فرضِ medium روی مدل معمولی هشدار الکی نمی‌سازد', async () => {
  // هشدار «اعمال نشد» فقط برای چیزی است که کاربر *صریح* خواسته. اگر پیش‌فرض هم
  // مثل خواسته رفتار کند، هر تماس مدل معمولی یک خط هشدار می‌گیرد و لاگ کور می‌شود.
  const warn = console.warn;
  const lines = [];
  console.warn = (...a) => lines.push(a.join(' '));
  const f = fakeOpenAI(CHAT_OK);
  try {
    await withEnv({ OPENAI_API_KEY: 'sk-t', OPENAI_BASE_URL: null, OPENAI_REASONING_EFFORT: null }, () =>
      callOpenAISchema({ prompt: 'x', schema: SCHEMA, toolName: 'x', model: 'gpt-4.1-بی‌هشدار' }));
  } finally { f.restore(); console.warn = warn; }

  eq(lines.length, 0, `کاربر چیزی نخواسته بود، پس هشداری هم نباید باشد: ${JSON.stringify(lines)}`);
  ok(!('reasoning' in f.seen[0].body), 'و چیزی هم به مسیر chat نمی‌رود');
});

t('توکن استدلال شمرده می‌شود — هزینه کمتر از واقعیت نشان داده نشود', async () => {
  const f = fakeOpenAI({
    status: 'completed',
    output: [{ type: 'function_call', name: 'x', arguments: '{"a":1}' }],
    usage: { input_tokens: 11, output_tokens: 90, output_tokens_details: { reasoning_tokens: 70 } }
  });
  let r;
  try {
    r = await withEnv({ OPENAI_API_KEY: 'sk-t' }, () =>
      callOpenAISchema({ prompt: 'x', schema: SCHEMA, toolName: 'x', model: 'gpt-5-mini' }));
  } finally { f.restore(); }

  eq(r.meta.reasoningTokens, 70, 'توکن استدلال باید در meta بیاید');
  eq(r.meta.outputTokens, 90, 'output_tokens خودش شامل استدلال است — جمع‌کردن یعنی دوبار حساب‌کردن');

  // درگاهی که output_tokens نمی‌دهد ولی استدلال را می‌شمارد: صفر نشان ندهیم
  eq(readUsage({ output_tokens_details: { reasoning_tokens: 40 } }).outputTokens, 40);
  eq(readUsage({ completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 3 } }).reasoningTokens, 3,
     'مسیر chat هم اگر شمرد، خوانده شود');
  eq(readUsage(undefined).outputTokens, undefined, 'نبودِ usage نباید صفرِ ساختگی بسازد');
});

t('strict فقط روی اسکیمایی می‌رود که OpenAI می‌پذیردش', async () => {
  const loose  = { type: 'object', required: ['a'], properties: { a: { type: 'integer' } } };
  const strict = { type: 'object', additionalProperties: false, required: ['a', 'b'],
                   properties: { a: { type: 'integer' },
                                 b: { type: 'array', items: { type: 'object', additionalProperties: false,
                                      required: ['c'], properties: { c: { type: 'string' } } } } } };
  eq(schemaIsStrict(loose), false, 'بدون additionalProperties:false، strict یعنی ۴۰۰');
  eq(schemaIsStrict({ ...strict, required: ['a'] }), false, 'required باید همه‌ی کلیدها را بشمارد');
  eq(schemaIsStrict(strict), true);
  eq(schemaIsStrict({ ...strict, properties: { ...strict.properties, b: { type: 'array',
       items: { type: 'object', required: ['c'], properties: { c: { type: 'string' } } } } } }), false,
     'شیء تودرتوی ناسازگار هم باید گیر بیفتد');

  const sent = async (schema, model, reply) => {
    const f = fakeOpenAI(reply);
    try {
      await withEnv({ OPENAI_API_KEY: 'sk-t' }, () =>
        callOpenAISchema({ prompt: 'x', schema, toolName: 'x', model }));
    } finally { f.restore(); }
    return f.seen[0].body.tools[0];
  };
  const okReply = { status: 'completed', output: [{ type: 'function_call', name: 'x', arguments: '{"a":1,"b":[]}' }] };
  eq((await sent(strict, 'gpt-5-mini', okReply)).strict, true, 'اسکیمای سازگار strict می‌گیرد');
  eq((await sent(loose,  'gpt-5-mini', RESPONSES_OK)).strict, undefined, 'ناسازگار اصلاً نباید strict بفرستد');
  eq((await sent(loose,  'gpt-4.1',    CHAT_OK)).function.strict, undefined, 'در مسیر chat هم همین قاعده');
});

t('هر پیام خطایی که کاربر را متوقف می‌کند، راه ادامه دارد', async () => {
  const { readFile } = await import('node:fs/promises');
  const ui = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

  ok(/function freshStart\s*\(/.test(ui), 'freshStart باید تعریف شده باشد');
  ok(/function freshStart[\s\S]{0,700}fresh\s*:\s*true/.test(ui),
     'شروع از نو باید اجرای تازه بسازد، نه ادامه‌ی همان بن‌بست');

  // بلوک خطای api() — همان چیزی که کاربر موقع گیر کردن می‌بیند
  const block = ui.match(/M\.innerHTML = `<div class="err">\$\{esc\(title\)\}[\s\S]*?`;/);
  ok(block, 'بلوک نمایش خطا پیدا نشد');
  ok(block[0].includes('freshStart()'), 'پیام خطا باید دکمه‌ی «شروع از نو» داشته باشد');

  // ⚠ url فقط بعد از یک جواب موفق پر می‌شود. اگر همان اولین درخواست خطا بدهد،
  // «شروع از نو» بدون این کاربر را به فرم خالی برمی‌گرداند و او دوباره همان
  // درخواستِ بدون fresh را می‌فرستد — حلقه‌ی بی‌پایان همان خطا.
  ok(/lastRun\s*=\s*body/.test(ui), 'آخرین درخواست /api/run باید نگه داشته شود');
  ok(/\.\.\.lastRun,\s*fresh\s*:\s*true/.test(ui),
     'وقتی url خالی است، شروع از نو باید همان منابع را با fresh دوباره بفرستد');

  // همان قاعده در پنل‌های کوچک‌تر هم: هیچ خطایی بدون راه ادامه نمی‌ماند.
  // پیام لخت یعنی کاربر همان‌جا رها می‌شود.
  const naked = ui.match(/innerHTML = `<div class="err">\$\{esc\(e\.message\)\}<\/div>`/g) || [];
  eq(naked.length, 0, `${naked.length} پیام خطا بدون دکمه‌ی ادامه — باید از errBox رد شوند`);
  ok(/function errBox\(/.test(ui), 'errBox باید تعریف شده باشد');
});

// ═══ خودآزمایی — نباید خودش بشکند ═══

t('یک بررسی که می‌ترکد، بقیه را با خودش نمی‌برد', async () => {
  const { check, timed } = await import('../lib/selftest.js');

  const r = check('همگام', () => { throw new ReferenceError('openaiModel is not defined'); });
  eq(r.name, 'همگام');
  eq(r.ok, false, 'بررسیِ شکسته باید قرمز شود، نه اینکه استثنا بالا برود');
  ok(r.error.includes('openaiModel'), `خطا باید در نتیجه بماند: ${r.error}`);

  eq(check('سالم', () => ({ detail: 'خوب' })).ok, true, 'بررسی سالم پیش‌فرض سبز است');
  eq(check('قرمزِ عمدی', () => ({ ok: false, detail: 'نیست' })).ok, false, 'خود بررسی می‌تواند ok را قرمز کند');

  const a = await timed('ناهمگام', async () => { throw new Error('نرسید'); });
  eq(a.ok, false, 'ناهمگامِ شکسته هم فقط یک خط قرمز است');
  ok(a.error.includes('نرسید'), a.error);

  const slow = await timed('کند', () => new Promise(r => setTimeout(r, 200)), 20);
  eq(slow.ok, false, 'مهلت باید اعمال شود');
  ok(slow.error.includes('طول کشید'), slow.error);
});

t('هر بررسی خودآزمایی داخل try خودش است', async () => {
  const { readFile } = await import('node:fs/promises');
  const txt = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  // هر checks.push باید از check( یا timed( رد شود — نه یک شیء لخت که
  // خطایش کل /api/selftest را ۵۰۰ می‌کند
  const naked = (txt.match(/checks\.push\(\s*\{/g) || []);
  eq(naked.length, 0, `${naked.length} بررسی بدون try — باید داخل check() یا timed() باشند`);
});

t('شماره‌ی نسخه از git می‌آید، نه از فایلی که عقب می‌ماند', async () => {
  const { buildId } = await import('../lib/selftest.js');
  const { existsSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { readFile } = await import('node:fs/promises');
  const root = fileURLToPath(new URL('..', import.meta.url));

  ok(/^[0-9a-f]{7,}/.test(buildId(root) || ''), `باید هش کوتاه git باشد: ${buildId(root)}`);
  // بدون $HOME (مثل systemd) باید همان جواب بیاید — وگرنه یک فایل ردیابی‌نشده
  // که فقط ignore سراسریِ کاربر پنهانش می‌کند، نسخه را «تغییریافته» نشان می‌دهد
  const { execFileSync } = await import('node:child_process');
  const bare = execFileSync(process.execPath,
    ['-e', `import('${new URL('../lib/selftest.js', import.meta.url).href}').then(m => console.log(m.buildId(${JSON.stringify(root)})))`],
    { env: {}, encoding: 'utf8' }).trim();
  eq(bare, buildId(root), 'شناسه‌ی نسخه نباید به محیط بستگی داشته باشد');
  eq(buildId('/'), null, 'بیرون از مخزن، «نمی‌دانم» جواب درست است — نه شماره‌ی غلط');
  ok(!existsSync(new URL('../BUILD', import.meta.url)), 'فایل BUILD نباید برگردد — همیشه عقب می‌ماند');

  const txt = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  ok(!txt.includes("'BUILD'"), 'server.js نباید دوباره از فایل BUILD بخواند');
});

// ═══ گزارش ═══
await Promise.all(pending);
console.log(`\n  ${pass} قبول · ${fail} رد\n`);
if (fail) {
  failures.forEach(f => console.log(`  ✗ ${f}\n`));
  process.exit(1);
}
console.log('  ✓ همه‌ی ثابت‌ها برقرارند\n');
