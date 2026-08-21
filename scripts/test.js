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
import { costOf, restoredInfo, rankCandidates } from '../lib/session.js';
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

// ── اجرای ذخیره‌شده نباید خودش را نتیجه‌ی همین حالا جا بزند ───
// سه بار کاربر خروجی چند روز پیش را نتیجه‌ی تازه گرفت و تنها راهش
// پاک‌کردن دستی .vohu بود.

const STORED = {
  url: 'x.com', updatedAt: '2026-08-18T10:00:00Z', engine: { provider: 'openai', model: 'gpt-5-mini' },
  stages: {
    condensed: 3,                                     // مرحله‌ای که شیء نیست — نباید بترکد
    insight:  { producedBy: { provider: 'openai', model: 'gpt-5-mini', at: '2026-08-18T09:00:00Z' } },
    strategy: { producedBy: { provider: 'openai', model: 'gpt-5-mini', at: '2026-08-18T10:00:00Z' } }
  }
};

// ── برچسب هر خانه: چهار تا، و هرکدام جای خودش ────────────────
// از یک اجرای واقعی (farideh.gilaseh): «پیام» با برچسب fact آمد ولی متنش
// وعده‌ای بود که در هیچ محتوایی نیامده بود، و «اقدام» با برچسب hypothesis —
// درحالی‌که اقدام تصمیم است، نه حدس.

const CELLS = V.STRATEGY_CARD_SCHEMA.properties.cells.properties;

t('اقدام نمی‌تواند حدس باشد — اسکیما اجازه نمی‌دهد', () => {
  for (const k of ['goal', 'action', 'successSignal']) {
    const e = CELLS[k].properties.origin.enum;
    eq(e.join(','), 'decision', `${k} را ما انتخاب کرده‌ایم، پس فقط تصمیم است`);
  }
  for (const k of ['audience', 'tension'])
    ok(!CELLS[k].properties.origin.enum.includes('decision'), `${k} یافته است، نه تصمیم`);
  for (const k of ['message', 'reasonToBelieve'])
    ok(CELLS[k].properties.origin.enum.includes('commitment'),
       `${k} جایی است که وعده‌ی کسب‌وکار می‌نشیند، پس باید بتواند «قول» باشد`);
  ok(CELLS.message.properties.source, 'هر خانه باید جای نقل‌قول داشته باشد');
});

t('پرامپت می‌گوید هر «کاری که می‌کنیم»، تا نقل‌قول نداشته باشد قول است', () => {
  const p = V.STRATEGY_CARD_PROMPT({ knowledge: {}, insight: 'x', answers: {}, constraints: [], fatigue: {} });
  ok(/commitment/.test(p) && /decision/.test(p), 'هر چهار برچسب باید معرفی شوند');
  ok(/چه کاری می‌کند یا خواهد کرد/.test(p), 'قاعده‌ی قول باید صریح باشد');
  ok(/نقل‌قول پیوسته/.test(p), 'و شرطش نقل‌قول پیوسته است');
  ok(/کد این را چک می‌کند/.test(p), 'و مدل باید بداند کد چکش می‌کند');
  // شمارش آزمایش کوچک باید با enum تازه جور باشد، وگرنه هرگز شلیک نمی‌کند
  ok(/سه‌تا\s*\n?یا بیشتر|سه‌تا یا بیشتر/.test(p), 'شمارش small_test باید بازنویسی شده باشد');
  ok(!/بیش از نیمی از خانه‌ها hypothesis/.test(p),
     'شمارش قدیمی روی هفت خانه دیگر ممکن نیست — سه خانه اصلاً حدس نمی‌شوند');
});

t('fact بدون نقل‌قولِ پیدا‌شدنی، fact نمی‌ماند', () => {
  const text = 'ما برای همه‌ی سفارش‌ها فاکتور رسمی واردکننده را می‌فرستیم و کد رهگیری می‌دهیم.';
  const card = { cells: {
    message:         { value: 'پک را بر اساس بودجه‌ی شما می‌چینیم', origin: 'fact' },
    reasonToBelieve: { value: 'فاکتور رسمی', origin: 'fact', source: 'فاکتور رسمی واردکننده را می‌فرستیم' },
    audience:        { value: 'y', origin: 'fact', source: 'کوتاه' }
  } };
  const r = V.GATES.checkCellOrigins(card, text);

  eq(card.cells.reasonToBelieve.origin, 'fact', 'نقل‌قولی که واقعاً در متن هست، fact می‌ماند');
  eq(card.cells.message.origin, 'commitment', 'وعده‌ی بی‌نقل‌قول باید به قول برگردد');
  eq(card.cells.message.needsConfirmation, true, 'و تأیید کاربر بخواهد');
  eq(card.cells.message.downgradedFrom, 'fact', 'و رد پایش بماند');
  ok(/نقل‌قول ندارد/.test(card.cells.message.downgradeReason), card.cells.message.downgradeReason);
  ok(/کوتاه/.test(card.cells.audience.downgradeReason), 'نقل‌قول خیلی کوتاه شاهد نیست');
  eq(card.cells.audience.origin, 'hypothesis', 'خانه‌ای که قول نمی‌پذیرد، به حدس برمی‌گردد');
  eq(r.pass, false);
  eq(r.changed.length, 2);
});

t('نقل‌قول با نیم‌فاصله و ی عربی هم پیدا می‌شود', () => {
  // بدون یکسان‌سازی، نقل‌قولِ درست هم رد می‌شد و همه‌چیز قول می‌شد
  const card = { cells: { message: {
    value: 'x', origin: 'fact', source: 'ارسال هديه همراه بسته بندي و پيام اختصاصي' } } };
  V.GATES.checkCellOrigins(card, 'خدمات ما: «ارسال هدیه — همراه بسته‌بندی و پیام اختصاصی» برای همه.');
  eq(card.cells.message.origin, 'fact', 'ی/ك عربی و نیم‌فاصله نباید نقل‌قول درست را رد کنند');
});

t('برچسبِ ناممکنِ کارت‌های قدیمی هم اصلاح می‌شود', () => {
  // کارت‌های قبل از این قاعده «اقدام: hypothesis» دارند
  const card = { cells: { action: { value: 'x', origin: 'hypothesis' },
                          goal:   { value: 'y', origin: 'fact' } } };
  const r = V.GATES.checkCellOrigins(card, '');
  eq(card.cells.action.origin, 'decision');
  eq(card.cells.goal.origin, 'decision', 'fact هم روی خانه‌ی تصمیمی جایی ندارد');
  eq(r.changed.length, 2);
  eq(V.GATES.checkCellOrigins({ cells: {} }, '').pass, true, 'کارت خالی نباید بترکد');
  eq(V.GATES.checkCellOrigins(null, null).pass, true, 'نبودِ کارت هم');
});

t('دروازه پیش از نمایش کارت شلیک می‌کند، در هر دو مسیر', async () => {
  const { readFile } = await import('node:fs/promises');
  const ses = await readFile(new URL('../lib/session.js', import.meta.url), 'utf8');
  const pip = await readFile(new URL('../lib/pipeline.js', import.meta.url), 'utf8');
  for (const [name, src] of [['session', ses], ['pipeline', pip]])
    ok(/GATES\.checkCellOrigins\(/.test(src), `${name} باید دروازه را صدا بزند`);
  // در مسیر CLI باید *قبل* از نشان‌دادن کارت باشد
  ok(pip.indexOf('GATES.checkCellOrigins(') < pip.indexOf("io.show({ type: 'strategy'"),
     'کاربر نباید یک لحظه هم «واقعیت» ببیند که واقعیت نیست');
});

t('رابط هر چهار برچسب را می‌شناسد و «قول» را برجسته می‌کند', async () => {
  const { readFile } = await import('node:fs/promises');
  const ui = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const map = ui.match(/const ORIGIN = \{[\s\S]*?\};/);
  ok(map, 'نگاشت برچسب‌ها پیدا نشد');
  for (const k of ['fact', 'hypothesis', 'commitment', 'decision'])
    ok(map[0].includes(k + ':'), `${k} باید در نگاشت باشد`);
  ok(!/v\.origin==='fact'\?'واقعیت':'حدس'/.test(ui), 'نگاشت دوتایی قدیمی نباید مانده باشد');
  ok(/needsConfirmation\?/.test(ui), 'قولِ تأییدنشده باید روی صفحه دیده شود');
});

t('سرورِ کهنه سکوت نمی‌کند', async () => {
  // ریشه‌ی «قاعده اعمال نشد»: پروسه ۲۸ دقیقه قبل از آن قاعده بالا آمده بود و
  // Node ماژول را دوباره نمی‌خواند؛ /api/version هم buildِ دیسک را می‌گفت.
  const { readFile } = await import('node:fs/promises');
  const srv = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  ok(/function staleBuild\(/.test(srv), 'باید مقایسه‌ای بین کدِ اجرا و کدِ دیسک باشد');
  const fn = srv.match(/function staleBuild\(\)[\s\S]*?\n}/)[0];
  ok(/BUILD === onDisk/.test(fn) && /buildId\(here\)/.test(fn),
     'باید buildِ لحظه‌ی بالا آمدن را با buildِ همین حالا بسنجد');
  ok(/stale: staleBuild\(\)/.test(srv), '/api/version باید بگویدش');
  ok(/checks\.push\(check\('کدِ در حال اجرا'/.test(srv), 'و خودآزمایی هم');
  const ui = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  ok(/if \(v\.stale\)/.test(ui), 'و کاربر باید ببیندش، نه اینکه در JSON بماند');
});

t('کارت نمونه با قاعده‌های تازه جور است', async () => {
  const { readFile } = await import('node:fs/promises');
  const card = JSON.parse(await readFile(new URL('../fixtures/strategy_card.json', import.meta.url), 'utf8'));
  for (const [k, v] of Object.entries(card.cells))
    ok(CELLS[k].properties.origin.enum.includes(v.origin),
       `${k} با برچسب «${v.origin}» در اسکیما مجاز نیست`);
  // و دروازه نباید چیزی برای اصلاح پیدا کند
  eq(V.GATES.checkCellOrigins(JSON.parse(JSON.stringify(card)), '').changed
      .filter(c => c.from !== 'fact').length, 0, 'نمونه نباید برچسب ناممکن داشته باشد');
});

// ── رتبه‌بندی مشاهده‌ها: اطمینان × اهمیت ─────────────────────
// امتیاز الگو به‌تنهایی، مشاهده‌ی قطعیِ بی‌اثر را بالای فهرست می‌نشاند.

const INSIGHT_PROMPT = V.FIRST_INSIGHT_PROMPT({
  knowledge: {}, competitorMap: {}, contentAnalysis: {}, market: {} });

t('پرامپت جمله‌ی اول دو عدد می‌خواهد، نه یکی', () => {
  const text = INSIGHT_PROMPT;
  ok(/اطمینان/.test(text) && /اهمیت/.test(text), 'هر دو مفهوم باید نام برده شوند');
  ok(/تکان بدهد/.test(text), 'اهمیت باید همان «چقدر می‌تواند تکان بدهد» تعریف شود');
  ok(/اطمینان × اهمیت/.test(text), 'ترتیب باید صریح ترکیب هر دو باشد');
  ok(/قوی‌ترین شاهد[\s\S]{0,60}بی‌اثر/.test(text),
     'باید بگوید شاهد محکمِ بی‌اثر، جمله‌ی اول نمی‌شود');
});

t('اسکیمای جمله‌ی اول، اهمیت را اجباری می‌کند', () => {
  const items = V.FIRST_INSIGHT_SCHEMA.properties.candidates.items;
  ok(items.required.includes('strength') && items.required.includes('impact'),
     'هر دو عدد باید اجباری باشند، وگرنه مدل یکی را جا می‌اندازد');
  eq(items.properties.impact.minimum, 0);
  eq(items.properties.impact.maximum, 1);
  ok(items.properties.strength.description.includes('اطمینان'), 'معنی strength باید صریح باشد');
});

t('ترتیب مشاهده‌ها را کد می‌چیند، نه ترتیبی که مدل داده', () => {
  const out = rankCandidates([
    { pattern: 'proof',       strength: 0.95, impact: 0.2 },   // قطعی ولی بی‌اثر
    { pattern: 'entry_point', strength: 0.60, impact: 0.9 },   // کم‌مطمئن‌تر، پرتکان
    { pattern: 'fear',        strength: 0.50, impact: 0.5 }
  ]);
  // proof با اطمینان ۰٫۹۵ ته فهرست می‌افتد (۰٫۹۵×۰٫۲=۰٫۱۹) و fear با اطمینان
  // ۰٫۵ بالاتر می‌نشیند (۰٫۵×۰٫۵=۰٫۲۵) — دقیقاً همان چیزی که امتیاز الگو تنها نمی‌دید.
  eq(out.map(c => c.p).join(','), 'entry_point,fear,proof',
     'مشاهده‌ی قطعیِ بی‌اثر نباید بالای فهرست بماند');
  eq(out[0].score.toFixed(2), '0.54');
  ok(out.every(c => c.s != null && c.i != null), 'هر دو عدد باید بیرون بروند تا در رابط دیده شوند');
});

t('اهمیتِ نبوده ساخته نمی‌شود', () => {
  // کارت‌های قبل از این قاعده impact ندارند — صفر گذاشتن یعنی «سنجیدم و هیچ»
  const [a] = rankCandidates([{ pattern: 'x', strength: 0.8 }]);
  eq(a.i, null, 'اهمیتِ نبوده باید null بماند، نه صفر');
  eq(a.score, 0.8, 'و امتیاز همان اطمینان می‌شود، نه صفر');

  eq(rankCandidates([]).length, 0);
  eq(rankCandidates(null).length, 0, 'نبودِ candidates نباید بترکد');
  const [b] = rankCandidates([{ pattern: 'y', strength: 5, impact: -2 }]);
  ok(b.s === 1 && b.i === 0, `عدد بیرون از بازه باید مهار شود: ${JSON.stringify(b)}`);
  eq(rankCandidates([{ pattern: 'z', strength: 'زیاد' }])[0].score, null, 'عدد نبودن یعنی امتیاز نامعلوم');
});

t('هر دو عدد روی صفحه دیده می‌شوند — وگرنه معلوم نیست چرا این اول آمده', async () => {
  const { readFile } = await import('node:fs/promises');
  const ui = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const grab = n => (ui.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n}')) || [])[0];
  ok(grab('patternBars'), 'patternBars پیدا نشد');
  ok(/اطمینان × اهمیت = امتیاز/.test(ui), 'راهنمای نمودار باید بگوید این عددها چیستند');

  const draw = new Function('c', grab('patternBars') + '; return patternBars(c);');
  const out = draw([{ p: 'fear', s: 0.8, i: 0.9, score: 0.72 },
                    { p: 'proof', s: 0.95, i: null, score: 0.95 }]);
  ok(out.includes('0.80') && out.includes('0.90') && out.includes('0.72'),
     `هر سه عدد باید نوشته شوند: ${out}`);
  ok(/—/.test(out) && !/0\.00/.test(out), `عددِ نبوده باید «—» باشد، نه صفر: ${out}`);
});

t('نمونه‌ی حالت خشک هم دو عدد دارد و ترتیبش با انتخابش جور است', async () => {
  const { readFile } = await import('node:fs/promises');
  const ins = JSON.parse(await readFile(new URL('../fixtures/first_insight.json', import.meta.url), 'utf8'));
  ok(ins.candidates.every(c => typeof c.impact === 'number'), 'همه‌ی candidateها باید impact داشته باشند');
  const top = rankCandidates(ins.candidates)[0];
  eq(top.p, ins.chosen.pattern, 'جمله‌ی انتخاب‌شده باید همان صدرنشین ترتیب تازه باشد');
});

// ── سؤالی که از هر کسی می‌شود پرسید، سؤال نیست ───────────────

const Q_PROMPT = V.QUESTIONS_PROMPT({ knowledge: {}, mission: 'x' });

t('پرامپت سؤال‌ها، سؤالِ فرم‌مانند را رد می‌کند', () => {
  ok(/فرم/.test(Q_PROMPT), 'باید اسمش را بگذارد: این فرم است، نه سؤال');
  ok(/کلمه‌به‌کلمه/.test(Q_PROMPT), 'محک باید عملی باشد: همین جمله را از کسب‌وکار دیگری هم می‌شود پرسید؟');
  ok(/در متن خود سؤال/.test(Q_PROMPT),
     'اشاره باید در خود سؤال باشد، نه در whyItMatters — کاربر فقط سؤال را می‌خواند');
  ok(/groundedIn/.test(Q_PROMPT), 'و باید بگوید کدام تکه‌ی شناخت سؤال را ساخت');
});

t('«هدف این ماه» فقط با دو شاخه‌ی نام‌دار مجاز است', () => {
  ok(/دو مسیر مشخص|دو شاخه/.test(Q_PROMPT), 'شرط دو شاخه باید صریح باشد');
  ok(/نام هر دو در خود سؤال/.test(Q_PROMPT), 'و نامشان باید در خود سؤال بیاید');
  ok(/هدف این ماه چیست/.test(Q_PROMPT), 'باید نمونه‌ی غلط را هم نشان بدهد');
  ok(/assumptions/.test(Q_PROMPT), 'اگر دو شاخه نبود، به‌جای سؤال باید فرض بگذارد');

  // پرامپت نباید خودش را نقض کند: این جمله قبلاً مثالِ «درست» بود
  const generic = 'سه ماه آینده فروش برایت مهم‌تر است یا شناخته‌شدن؟';
  const i = Q_PROMPT.indexOf(generic);
  ok(i > -1, 'نمونه هنوز باید باشد — ولی به‌عنوان مثال غلط');
  ok(/غلط: $/m.test(Q_PROMPT.slice(0, i)) || Q_PROMPT.slice(Math.max(0, i - 12), i).includes('غلط'),
     'جمله‌ی همه‌جایی باید زیر «غلط» باشد، نه زیر «درست»');
});

t('اسکیمای سؤال‌ها groundedIn را اجباری می‌کند', () => {
  const items = V.QUESTIONS_SCHEMA.properties.questions.items;
  ok(items.required.includes('groundedIn'),
     'نبودش باید همان اول گیر بیفتد، وگرنه قاعده فقط یک توصیه در پرامپت است');
  ok(items.properties.groundedIn.description.includes('شناخت'));
});

t('سؤال‌های نمونه هم ریشه دارند و روی صفحه نشان داده می‌شوند', async () => {
  const { readFile } = await import('node:fs/promises');
  const q = JSON.parse(await readFile(new URL('../fixtures/questions.json', import.meta.url), 'utf8'));
  ok(q.questions.length && q.questions.every(x => x.groundedIn && x.groundedIn.length > 15),
     'هر سؤال نمونه باید ریشه‌اش را بگوید');
  const ui = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  ok(/از کجا پرسیدم: \$\{esc\(q\.groundedIn\)\}/.test(ui), 'ریشه‌ی سؤال باید به کاربر نشان داده شود');
});

// ── «جواب داد» باید شمردنی باشد ──────────────────────────────
// نشانه‌ی موفقیت بدون عدد و خط پایه، دو هفته بعد قابل راستی‌آزمایی نیست؛
// و اقدامی که ابزارهای ما نمی‌بینندش، بی‌اعلام نباید پیشنهاد شود.

const CARD_PROMPT = V.STRATEGY_CARD_PROMPT({
  knowledge: {}, insight: 'x', answers: {}, constraints: [], fatigue: {} });

t('پرامپت کارت، نشانه‌ی موفقیت بی‌عدد را نمی‌پذیرد', () => {
  ok(/خط پایه/.test(CARD_PROMPT), 'خط پایه باید خواسته شود');
  ok(/عدد هدف/.test(CARD_PROMPT), 'عدد هدف باید خواسته شود');
  ok(/countFirst/.test(CARD_PROMPT) && /قبل از شروع/.test(CARD_PROMPT),
     'وقتی خط پایه نامعلوم است، باید به‌جای نشانه‌ی مبهم بگوید «قبل از شروع، X را بشمار»');
  ok(/اقدام لازم/.test(CARD_PROMPT), 'و همان شمردن باید یک اقدام لازم باشد، نه یک تذکر');
  ok(/حدس نزن/.test(CARD_PROMPT) && /baseline[\s\S]{0,40}null/.test(CARD_PROMPT),
     'خط پایه‌ی نامعلوم باید null بماند، نه عددِ ساختگی — قاعده‌ی ۶');
});

t('پرامپت کارت می‌گوید با چه چیزی می‌شود اندازه گرفت و با چه چیزی نه', () => {
  // فهرست از روی چیزی است که واقعاً جمع می‌کنیم (lib/instagram.js)
  for (const w of ['کامنت', 'لایک', 'بازدید'])
    ok(new RegExp(w).test(CARD_PROMPT), `«${w}» باید در فهرست شمردنی‌ها باشد`);
  for (const w of ['دایرکت', 'سیو', 'ریچ', 'فروش'])
    ok(new RegExp(w).test(CARD_PROMPT), `«${w}» باید در فهرست شمردنی‌نیست‌ها باشد`);
  ok(/blindSpot/.test(CARD_PROMPT) && /قابل رصد نیست|دیده نمی‌شود/.test(CARD_PROMPT),
     'اقدام نامرئی باید صریح اعلام شود، نه اینکه ممنوع باشد');

  // پرامپت نباید خودش را نقض کند: مثالِ «درست» در بخش پیش‌بینی قبلاً
  // دایرکت بود — همان چیزی که حالا شمردنی حساب نمی‌شود.
  const good = CARD_PROMPT.match(/^درست: .*$/m);
  ok(good, 'مثال «درست» پیدا نشد');
  ok(!/دایرکت/.test(good[0]), `مثال «درست» نباید چیزی باشد که نمی‌توانیم بشماریم: ${good[0]}`);
});

t('اسکیمای کارت جایی برای این دو قاعده دارد — نه فقط پرامپت', () => {
  const S = V.STRATEGY_CARD_SCHEMA;
  ok(S.required.includes('measurement'), 'نبودش باید همان اول گیر بیفتد، نه اینکه امید به پرامپت باشد');
  const m = S.properties.measurement;
  ok(m.required.includes('countable'), 'شمردنی‌بودن باید همیشه جواب داشته باشد');
  for (const f of ['metric', 'baseline', 'countFirst', 'blindSpot'])
    ok(m.properties[f], `${f} باید در اسکیما باشد`);
  // خط پایه‌ی نامعلوم باید بتواند null بماند، وگرنه مدل مجبور به ساختن عدد می‌شود
  ok(m.properties.baseline.type.includes('null'), 'baseline باید بتواند null باشد');
});

t('کارت می‌گوید با چه چیزی رصد می‌شود — روی صفحه، نه فقط در JSON', async () => {
  const { readFile } = await import('node:fs/promises');
  const ui = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const grab = n => (ui.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n}')) || [])[0];
  ok(grab('measureBox'), 'measureBox پیدا نشد');
  ok(/\$\{measureBox\(c\.measurement\)\}/.test(ui), 'کارت استراتژی باید صدایش بزند');

  const draw = new Function('m', `
    const esc = s => String(s??'').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
    ${grab('measureBox')}
    return measureBox(m);`);

  eq(draw(null), '', 'کارت قدیمی بدون measurement نباید بترکد');
  eq(draw({ countable: true, metric: 'کامنت', baseline: '۴' }), '',
     'وقتی خط پایه هست و شمردنی است، چیز اضافه‌ای نشان داده نمی‌شود');

  const first = draw({ countable: true, countFirst: 'قبل از شروع، کامنت‌های هر پست را بشمار', baseline: null });
  ok(first.includes('قبل از شروع'), `شمردنِ خط پایه باید دیده شود: ${first}`);

  const blind = draw({ countable: false, blindSpot: 'دایرکت را نمی‌توانیم بشماریم' });
  ok(/class="gate"/.test(blind) && blind.includes('دایرکت'), `اقدام نامرئی باید دیده شود: ${blind}`);
  // حتی اگر مدل blindSpot را خالی بگذارد، کاربر نباید بی‌خبر بماند
  ok(/class="gate"/.test(draw({ countable: false })), 'countable=false بدون توضیح هم باید هشدار بدهد');
});

t('کارتِ نمونه‌ی حالت خشک با همین قاعده‌ها جور است', async () => {
  const { readFile } = await import('node:fs/promises');
  const card = JSON.parse(await readFile(new URL('../fixtures/strategy_card.json', import.meta.url), 'utf8'));
  const m = card.measurement;
  ok(m, 'نمونه باید measurement داشته باشد، وگرنه حالت خشک مسیر تازه را اصلاً نمی‌آزماید');
  eq(typeof m.countable, 'boolean');
  // اقدام این کارت در دایرکت است — پس باید اعلام‌شده باشد، نه بی‌صدا
  eq(m.countable, false, 'اقدام دایرکتی شمردنی نیست');
  ok(m.blindSpot && m.blindSpot.length > 10, 'و باید بگوید چرا');
  ok(m.baseline === null && m.countFirst, 'خط پایه‌ی نامعلوم یعنی قدم اول شمردن است');
});

t('اجرای تازه بنر «قدیمی است» نمی‌گیرد', () => {
  eq(restoredInfo(STORED, null), null, 'وقتی همین حالا ساخته شده، بنری در کار نیست');
  eq(restoredInfo(null, '2026-08-18T10:00:00Z'), null, 'بدون اجرا هم چیزی ادعا نمی‌شود');
});

t('اجرای ذخیره‌شده تاریخ و سازنده‌اش را می‌گوید', () => {
  withEnv({ VOHU_PROVIDER: 'openai', OPENAI_MODEL: 'gpt-5-mini' }, () => {
    const r = restoredInfo(STORED, STORED.updatedAt);
    ok(r, 'باید بنر بدهد');
    eq(r.at, '2026-08-18T10:00:00Z', 'تاریخ از تازه‌ترین مهر می‌آید، نه از قدیمی‌ترین');
    eq(r.provider, 'openai');
    eq(r.model, 'gpt-5-mini');
    eq(r.mismatch, null, 'وقتی سرویس فعلی همان است، هشدار اضافه نباید بدهد');
  });
});

t('سرویس یا مدلِ عوض‌شده صریح گفته می‌شود، نه بی‌سروصدا', () => {
  withEnv({ VOHU_PROVIDER: 'anthropic', VOHU_MODEL: 'claude-sonnet-5' }, () => {
    const r = restoredInfo(STORED, STORED.updatedAt);
    eq(r.mismatch?.provider, 'anthropic', 'باید سرویس فعلی را نام ببرد');
    eq(r.mismatch?.model, 'claude-sonnet-5', 'و مدل فعلی را');
    eq(r.provider, 'openai', 'و سازنده‌ی واقعی هم باید بماند');
  });
  // همان سرویس، مدل دیگر — این هم فرق است
  withEnv({ VOHU_PROVIDER: 'openai', OPENAI_MODEL: 'gpt-4.1' }, () => {
    eq(restoredInfo(STORED, STORED.updatedAt).mismatch?.model, 'gpt-4.1');
  });
});

t('طرفِ نامعلوم «فرق دارد» حساب نمی‌شود', () => {
  // مدل فعلی که تعریف نشده، دلیل نمی‌شود بگوییم مدل عوض شده — قاعده‌ی ۶
  withEnv({ VOHU_PROVIDER: 'anthropic', VOHU_MODEL: null }, () => {
    const bare = { url: 'x', stages: { s: { producedBy: { provider: 'anthropic', model: 'claude-sonnet-5',
                                                          at: '2026-08-18T10:00:00Z' } } } };
    eq(restoredInfo(bare, '2026-08-18T10:00:00Z').mismatch, null, 'مدلِ نامعلوم ادعای فرق نمی‌سازد');
  });
  // اجرای بی‌مهر: هنوز چیزی ساخته نشده، پس ادعای سازنده هم نیست
  withEnv({ VOHU_PROVIDER: 'anthropic', VOHU_MODEL: 'claude-sonnet-5' }, () => {
    const r = restoredInfo({ url: 'x', stages: {} }, '2026-08-18T10:00:00Z');
    eq(r.provider, null, 'بدون مهر، سازنده ساخته نمی‌شود');
    eq(r.at, '2026-08-18T10:00:00Z', 'ولی تاریخ ذخیره را دارد');
    eq(r.mismatch, null);
  });
});

t('«شروع از نو» در هدر است، در همه‌ی حالت‌ها — نه فقط در صفحه‌ی خطا', async () => {
  const { readFile } = await import('node:fs/promises');
  const ui = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

  const header = ui.match(/<header>[\s\S]*?<\/header>/);
  ok(header, 'هدر پیدا نشد');
  ok(header[0].includes('freshStart()'), 'دکمه باید در خود هدر باشد تا همه‌ی صفحه‌ها آن را داشته باشند');

  // بنر «این نتیجه از انبار درآمده» و راه بیرون‌آمدنش
  ok(/function restoredBar\(/.test(ui), 'بنر باید تعریف شده باشد');
  ok(/function render\([\s\S]{0,400}restoredBar\(\)/.test(ui),
     'بنر باید بعد از هر رسم بیاید، وگرنه فقط در بعضی صفحه‌ها دیده می‌شود');
  ok(/function restoredBar\(\)[\s\S]*?S\.restored/.test(ui), 'تصمیمش با داده‌ی سرور است، نه حدس مرورگر');

  // منابع اجرا نباید با «شروع از نو» بی‌صدا بیفتند
  const fresh = ui.match(/function freshStart\(\)[\s\S]*?\n}/);
  ok(fresh, 'freshStart پیدا نشد');
  ok(fresh[0].includes("instagram: pick('instagram')"),
     'شروع از نو باید همان منابع را دوباره بفرستد، نه فقط url');
  ok(fresh[0].includes('fresh:true'), 'و باید واقعاً اجرای تازه بسازد');
});

t('بنر واقعاً رسم می‌شود — و وقتی مدل عوض شده، صریح می‌گوید', async () => {
  // رسم واقعی، نه فقط جست‌وجوی رشته: یک اشتباه در تمپلیت با regex پیدا نمی‌شود
  // ولی روی صفحه‌ی کاربر خودش را نشان می‌دهد.
  const { readFile } = await import('node:fs/promises');
  const ui = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const grab = n => (ui.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n}')) || [])[0];
  const PARTS = ['faNum', 'dayFa', 'agoFa', 'restoredBar'];
  for (const n of PARTS) ok(grab(n), `${n} پیدا نشد`);

  const draw = new Function('S', 'M', `
    const esc = s => String(s??'').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
    ${PARTS.map(grab).join('\n')}
    restoredBar(); return M.html;`);
  const paint = restored => {
    const M = { html: '', insertAdjacentHTML(_, h) { this.html += h; } };
    draw({ restored }, M);
    return M.html;
  };

  eq(paint(null), '', 'اجرای تازه هیچ بنری نمی‌گیرد');

  const fresh3h = paint({ at: new Date(Date.now() - 3 * 3600e3).toISOString(),
                          provider: 'openai', model: 'gpt-5-mini', mismatch: null });
  ok(fresh3h.includes('openai/gpt-5-mini'), `سازنده باید در بنر باشد: ${fresh3h}`);
  ok(fresh3h.includes('۳ ساعت پیش'), `چقدر پیش، با رقم فارسی کنار تاریخ فارسی: ${fresh3h}`);
  ok(fresh3h.includes('freshStart()'), 'بنر بدون راه ادامه، همان بن‌بست است');
  ok(!fresh3h.includes('undefined') && !fresh3h.includes('null'), `نشتِ مقدار خالی: ${fresh3h}`);
  ok(!/class="gate"/.test(fresh3h), 'وقتی فرقی نیست، هشدار قرمز هم نباید باشد');

  const changed = paint({ at: '2026-08-18T10:00:00Z', provider: 'openai', model: 'gpt-5-mini',
                          mismatch: { provider: 'anthropic', model: 'claude-sonnet-5' } });
  ok(changed.includes('openai/gpt-5-mini') && changed.includes('anthropic/claude-sonnet-5'),
     `هر دو طرف باید نام برده شوند: ${changed}`);
  ok(/class="gate"/.test(changed), 'فرقِ مدل باید دیده شود، نه اینکه در متن گم شود');
  ok(changed.includes('مدل قبلی'), 'باید بگوید آنچه می‌بینی خروجی مدل قبلی است');

  // تاریخِ خراب نباید بنر را بترکاند یا «Invalid Date» نشان دهد
  const bad = paint({ at: 'نه-تاریخ', provider: null, model: null, mismatch: null });
  ok(bad.includes('freshStart()') && !/Invalid|NaN|undefined/.test(bad), `تاریخ خراب: ${bad}`);
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
