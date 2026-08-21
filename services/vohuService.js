/**
 * تنها تابعی که برای صدا زدن مدل لازم داری.
 * از tool-use استفاده می‌کند تا خروجی حتماً مطابق اسکیما باشد و لازم نباشد متن پارس کنی.
 *
 * دو سرویس پشت این تابع است و **انتخاب با توست**، نه با کد:
 *
 *   VOHU_PROVIDER=anthropic   (پیش‌فرض)
 *   VOHU_PROVIDER=openai
 *
 * قاعده: **یک اجرا از اول تا آخر با یک سرویس.** هیچ تعویضی وسط کار نیست.
 * اگر سرویس انتخاب‌شده جواب ندهد، اجرا شکست می‌خورد و می‌گوید چرا — نیمه‌کاره
 * با مدل دیگری تمام نمی‌شود. دلیلش قاعده‌ی ۴ است: کارت استراتژی که نصفش را
 * یک مدل و نصفش را مدل دیگری ساخته باشد، یک شاهد یکدست نیست.
 *
 * هر خروجی مهر می‌خورد (`producedBy`) تا بعداً معلوم باشد با چه چیزی ساخته شده.
 */
import { openaiModel, callOpenAISchema } from './openai.js';

export const PROVIDERS = ['anthropic', 'openai'];

/** سرویسی که .env همین حالا می‌گوید. مقدار نامعتبر = خطا، نه پیش‌فرض بی‌صدا. */
export function configuredProvider() {
  const v = String(process.env.VOHU_PROVIDER || 'anthropic').trim().toLowerCase();
  if (!PROVIDERS.includes(v))
    throw new Error(`VOHU_PROVIDER نامعتبر: «${v}» — فقط ${PROVIDERS.join(' یا ')}`);
  return v;
}

/** سرویس و مدلی که همین حالا فعال است. */
export function activeEngine() {
  const provider = configuredProvider();
  return { provider, model: provider === 'openai' ? openaiModel() : (process.env.VOHU_MODEL || null) };
}

/** مهر «این را چه چیزی ساخت» — روی خروجی می‌نشیند و در انبار می‌ماند. */
function stamp(data, meta) {
  if (data && typeof data === 'object' && !Array.isArray(data))
    data.producedBy = { provider: meta.provider, model: meta.model, at: new Date().toISOString() };
  return data;
}

// SDK با تأخیر بارگذاری می‌شود — در حالت خشک اصلاً لازم نیست،
// پس می‌شود کل جریان را قبل از npm install هم تست کرد.
let _client = null;
let _sdk = null;
async function getClient() {
  if (_client) return _client;
  const mod = await import('@anthropic-ai/sdk');
  _sdk = mod.default;
  _client = new _sdk({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

/**
 * ترجمه‌ی خطای مدل به یک جمله‌ی فارسی که بشود روی صفحه نشان داد.
 *
 * قبلاً پیام خام SDK — یک بلوک JSON انگلیسی — مستقیم به مرورگر می‌رفت
 * و کاربر «400 {"type":"error",...}» می‌دید. متن خام حالا فقط در لاگ سرور
 * می‌ماند؛ کاربر می‌فهمد چه شد و چه باید بکند.
 *
 * تشخیص با کلاس‌های خطای خود SDK و کد HTTP است، نه با تطبیق رشته —
 * جز یک جا: تمام‌شدن اعتبار که سرور همان کد ۴۰۰ درخواست نامعتبر را می‌دهد.
 */
export function faModelError(e, { timeoutMs, model } = {}) {
  const status = e?.status;
  const body   = e?.error?.error;                       // { type, message }
  const raw    = String(body?.message || e?.message || '');

  // خطای شبکه کد HTTP ندارد. نام کلاس هم چک می‌شود تا اگر SDK هنوز
  // بارگذاری نشده باشد (تست) باز هم درست تشخیص داده شود.
  const isTimeout = (_sdk && e instanceof _sdk.APIConnectionTimeoutError)
    || e?.constructor?.name === 'APIConnectionTimeoutError';
  const isOffline = (_sdk && e instanceof _sdk.APIConnectionError)
    || e?.constructor?.name === 'APIConnectionError';
  if (isTimeout)
    return `مدل در ${Math.round((timeoutMs || 0) / 1000)}s جواب نداد — دوباره امتحان کن یا VOHU_CALL_TIMEOUT_MS را بالا ببر`;
  if (isOffline)
    return 'به api.anthropic.com نرسیدیم — اینترنت سرور یا دسترسی به مدل را چک کن';

  if (status === 400 && /credit balance/i.test(raw))
    return 'اعتبار حساب Anthropic تمام شده — از Plans & Billing شارژ کن. تا آن‌وقت هیچ تحلیلی ساخته نمی‌شود';
  if (status === 401)
    return 'کلید ANTHROPIC_API_KEY پذیرفته نشد — کلید داخل .env را چک کن';
  if (status === 403)
    return 'این کلید به این مدل دسترسی ندارد';
  if (status === 404)
    return `مدل «${model || process.env.VOHU_MODEL || '؟'}» پیدا نشد — VOHU_MODEL در .env را چک کن`;
  if (status === 413)
    return 'ورودی برای مدل خیلی بزرگ بود — منابع کمتری بده یا متن صفحه را کوتاه کن';
  if (status === 429)
    return 'سقف نرخ درخواست Anthropic پر شد — چند لحظه بعد دوباره بزن';
  if (status === 529)
    return 'سرویس Anthropic موقتاً شلوغ است — چند لحظه بعد دوباره بزن';
  if (status >= 500)
    return `خطای سرور Anthropic (${status}) — چند لحظه بعد دوباره بزن`;
  if (status)
    return `درخواست به مدل رد شد (${status})${raw ? ' — ' + raw.slice(0, 200) : ''}`;

  return raw || 'خطای نامعلوم در تماس با مدل';
}

/**
 * راهنمای کوتاه زیر پیام خطا — «حالا چه کار کنم؟».
 * null یعنی حرف اضافه‌ای برای گفتن نیست؛ آن‌وقت رابط چیزی نشان نمی‌دهد.
 */
export function faModelHint(e) {
  const status = e?.status;
  const raw = String(e?.error?.error?.message || e?.message || '');

  if (status === 400 && /credit balance/i.test(raw))
    return 'کلید و مدل درست‌اند؛ فقط حساب خالی است. بعد از شارژ، همین‌جا ادامه بده — جواب‌هایت ذخیره شده‌اند.';
  if (status === 401 || status === 403) return 'کلید را در ~/repo/.env درست کن و سرور را دوباره بالا بیاور.';
  if (status === 404) return 'نام مدل‌های معتبر را با /api/selftest چک کن.';
  if (status === 429 || status === 529 || status >= 500)
    return 'مشکل از سمت Anthropic است، نه از داده‌های تو. جواب‌هایت ذخیره شده‌اند؛ دوباره بزن.';
  return null;
}

/* ══════════════════════════════════════════════════════════
   دروازه‌ی اسکیما — تا امروز اینجا فقط به ادبِ مدل تکیه شده بود.

   `tool_choice` مدل را مجبور می‌کند ابزار را صدا بزند، ولی هیچ‌کس چک نمی‌کرد
   داخل ابزار چه ریخته. یک بار مدل کل خروجی شناخت محتوا را — با همه‌ی کلیدهای
   خواهر و برادرش — داخل رشته‌ی `capacities` چپاند و همان رشته خام در انبار
   نشست. مرحله «انجام‌شده» حساب شد، مرحله‌های بعدی روی هیچ ساخته شدند.

   از این‌جا به بعد: خروجی در برابر خود اسکیما سنجیده می‌شود. فیلدی که
   آرایه اعلام شده و رشته آمده، رد می‌شود. یک بار — با گفتنِ صریح اینکه
   کجا را غلط داده — دوباره تلاش می‌شود. اگر باز هم نشد، خطای صریح.
   **هیچ خروجی نامعتبری ذخیره نمی‌شود.**
   ══════════════════════════════════════════════════════════ */

const faTypeOf = v =>
  v === undefined ? 'نبود'
  : v === null ? 'null'
  : Array.isArray(v) ? 'آرایه'
  : typeof v === 'object' ? 'شیء'
  : typeof v === 'string' ? 'رشته'
  : typeof v === 'number' ? 'عدد'
  : typeof v === 'boolean' ? 'بولی'
  : typeof v;

const FA_TYPE = { object: 'شیء', array: 'آرایه', string: 'رشته', number: 'عدد',
                  integer: 'عدد صحیح', boolean: 'بولی', null: 'null' };

function typeOk(t, v) {
  switch (t) {
    case 'object':  return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'array':   return Array.isArray(v);
    case 'string':  return typeof v === 'string';
    case 'number':  return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'null':    return v === null;
    default:        return true;                  // نوعی که نمی‌شناسیم را ادعا نمی‌کنیم
  }
}

/**
 * تخلف‌های خروجی از اسکیما — فهرست، نه بولی.
 *
 * عمداً همان زیرمجموعه‌ای از JSON Schema را می‌فهمد که این مخزن واقعاً
 * می‌نویسد: type (تکی یا فهرست)، required، properties، items، enum،
 * minimum/maximum. چیزی که نمی‌فهمد را **تخلف حساب نمی‌کند** — دروازه‌ای
 * که ادعای بیش از دانشش کند، خروجی سالم را رد می‌کند.
 *
 * برمی‌گرداند: [{ path, expected, got, why }]
 */
export function schemaViolations(schema, data, path = '') {
  const out = [];
  if (!schema || typeof schema !== 'object') return out;
  const at = path || '(ریشه)';

  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : null;

  if (types) {
    if (!types.some(t => typeOk(t, data))) {
      const want = types.map(t => FA_TYPE[t] || t).join(' یا ');
      out.push({ path: at, expected: want, got: faTypeOf(data),
                 why: `${at} باید ${want} باشد ولی ${faTypeOf(data)} آمد` });
      return out;                                 // نوع که غلط باشد، رفتن به داخلش معنی ندارد
    }
  }

  if (Array.isArray(schema.enum) && data !== undefined && !schema.enum.includes(data)) {
    out.push({ path: at, expected: schema.enum.join('/'), got: String(data),
               why: `${at} باید یکی از ${schema.enum.join('/')} باشد ولی «${data}» آمد` });
  }

  const isObj = data !== null && typeof data === 'object' && !Array.isArray(data);
  if (isObj) {
    for (const r of schema.required || []) {
      if (data[r] === undefined)
        out.push({ path: path ? `${path}.${r}` : r, expected: 'وجود داشته باشد', got: 'نبود',
                   why: `${path ? `${path}.${r}` : r} الزامی است ولی نیامد` });
    }
    for (const [k, sub] of Object.entries(schema.properties || {})) {
      if (data[k] !== undefined)
        out.push(...schemaViolations(sub, data[k], path ? `${path}.${k}` : k));
    }
  }

  if (Array.isArray(data) && schema.items) {
    data.forEach((v, i) => out.push(...schemaViolations(schema.items, v, `${at}[${i}]`)));
  }

  if (typeof data === 'number') {
    if (typeof schema.minimum === 'number' && data < schema.minimum)
      out.push({ path: at, expected: `>= ${schema.minimum}`, got: String(data),
                 why: `${at} نباید کمتر از ${schema.minimum} باشد ولی ${data} آمد` });
    if (typeof schema.maximum === 'number' && data > schema.maximum)
      out.push({ path: at, expected: `<= ${schema.maximum}`, got: String(data),
                 why: `${at} نباید بیشتر از ${schema.maximum} باشد ولی ${data} آمد` });
  }

  return out;
}

/** متنی که به مدل گفته می‌شود چه چیزی را غلط داده — نه «دوباره تلاش کن». */
export function correctionNote(violations, toolName = 'result') {
  const lines = violations.slice(0, 8).map(v => `- ${v.why}`).join('\n');
  const more = violations.length > 8 ? `\n(و ${violations.length - 8} مورد دیگر)` : '';
  return `

## ⚠️ خروجی قبلی‌ات رد شد — با اسکیما نخواند

${lines}${more}

دوباره همان ابزار «${toolName}» را صدا بزن، این بار با شکل درست:

- آرایه یعنی آرایه‌ی واقعی، نه متنِ آرایه. **هیچ فیلدی را به‌صورت رشته‌ی JSON نده.**
- هر کلید سرِ جای خودش؛ چند فیلد را داخل یک فیلد نچپان.
- فیلدهای الزامی باید باشند.

خروجی نامعتبر ذخیره نمی‌شود — این آخرین فرصت این مرحله است.`;
}

/**
 * یک تماس با مدل، با دروازه‌ی اسکیما دورش.
 *
 * `attempt({ n, retryNote })` باید { data, meta } برگرداند. جدا از callWithSchema
 * است تا هر دو سرویس از یک دروازه رد شوند و بشود بدون خرج توکن تستش کرد.
 *
 * توکن‌های هر دو تلاش با هم جمع می‌شوند — تلاش دوم هم پول خرج کرده و
 * حساب باید صادق بماند. اگر آخرش هم رد شد، همان جمع روی خطا می‌نشیند
 * (err.usage) تا صداکننده بتواند حسابش کند.
 */
export async function guardSchema({ schema, toolName = 'result', attempt, maxAttempts = 2 }) {
  const acc = { inputTokens: 0, outputTokens: 0, ms: 0 };
  let firstBad = null;

  for (let n = 1; n <= maxAttempts; n++) {
    const r = await attempt({ n, retryNote: firstBad ? correctionNote(firstBad, toolName) : null });

    acc.inputTokens  += r?.meta?.inputTokens  || 0;
    acc.outputTokens += r?.meta?.outputTokens || 0;
    acc.ms           += r?.meta?.ms           || 0;

    const bad = schemaViolations(schema, r?.data);
    if (!bad.length) {
      const meta = { ...(r?.meta || {}), attempts: n,
                     inputTokens: acc.inputTokens, outputTokens: acc.outputTokens, ms: acc.ms };
      if (firstBad) meta.schemaRetry = firstBad.map(v => v.why);
      return { ...r, meta };
    }

    if (!firstBad) firstBad = bad;
    console.error(`[اسکیما] ${toolName} تلاش ${n}: ` + bad.map(v => v.why).join(' · ').slice(0, 400));

    if (n === maxAttempts) {
      const err = new Error(
        `مدل خروجیِ بدشکل داد و تلاش دوباره هم درست نشد — ${bad.slice(0, 3).map(v => v.why).join('؛ ')}`);
      err.hint = 'این مرحله ذخیره نشد: خروجیِ نامعتبر از نبودش بدتر است، چون مرحله‌های بعدی '
               + 'روی آن ساخته می‌شوند. دوباره بزن؛ اگر تکرار شد، مدل را عوض کن.';
      err.violations = bad;
      err.usage = acc;
      throw err;
    }
  }
}

/**
 * فیلدی که باید آرایه یا شیء می‌بود و رشته‌ی JSON آمده را برمی‌گرداند سر جایش.
 *
 * این **برای داده‌ی قدیمیِ در انبار** است، نه برای خروجی تازه‌ی مدل. خروجی تازه
 * از دروازه رد می‌شود (guardSchema)؛ ولی اجرایی که دیروز ذخیره شده را نمی‌شود
 * بدون دوباره پول‌دادن ساخت، و داده‌اش قابل بازیابی است.
 *
 * دو حالتِ دیده‌شده:
 *   ۱. رشته خودش همان مقدار است:      "[{...}]"
 *   ۲. مدل کل شیء را از وسط یک فیلد ریخته: "[...],\"flatSpots\": [...], ...}"
 *      → با پیچیدنش در `{"<field>":` دوباره یک شیء کامل می‌شود و کلیدهای
 *        خواهر و برادر هم برمی‌گردند.
 *
 * برمی‌گرداند: { data, repaired: [{field, recovered}], failed: [field] }
 */
export function repairStringified(schema, data) {
  const repaired = [], failed = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { data, repaired, failed };

  const props = schema?.properties || {};
  const out = { ...data };

  for (const [k, sub] of Object.entries(props)) {
    if (typeof out[k] !== 'string') continue;
    const types = sub?.type ? (Array.isArray(sub.type) ? sub.type : [sub.type]) : [];
    if (!types.includes('array') && !types.includes('object')) continue;   // رشته واقعاً مجاز است
    if (types.includes('string')) continue;

    const s = out[k].trim();
    let got = null, recovered = [k];

    try {                                        // حالت ۱ — خودِ مقدار
      const v = JSON.parse(s);
      if (typeOk(types[0], v)) got = { [k]: v };
    } catch { /* حالت بعدی */ }

    if (!got) {                                  // حالت ۲ — شیء از وسط این فیلد شروع شده
      for (const cand of [`{${JSON.stringify(k)}:${s}`, `{${JSON.stringify(k)}:${s}}`]) {
        try {
          const v = JSON.parse(cand);
          if (v && typeof v === 'object' && !Array.isArray(v) && typeOk(types[0], v[k])) {
            got = v;
            recovered = Object.keys(v);
            break;
          }
        } catch { /* بعدی */ }
      }
    }

    if (!got) { failed.push(k); continue; }

    // کلیدی که همین حالا در داده هست، دست‌نخورده می‌ماند — بازیابی جای
    // چیزی را نمی‌گیرد، فقط جای خالی را پر می‌کند.
    for (const [kk, vv] of Object.entries(got))
      if (kk === k || out[kk] === undefined) out[kk] = vv;

    repaired.push({ field: k, recovered });
  }

  return { data: out, repaired, failed };
}

/**
 * حالت خشک — برای تست جریان بدون صدا زدن مدل و بدون سوزاندن توکن.
 *
 *   VOHU_DRY_RUN=1 VOHU_FIXTURES=./fixtures node run-vohu.js <url>
 *
 * برای هر toolName یک فایل <toolName>.json در پوشه‌ی fixtures می‌خواند.
 * **نبودِ fixture خطاست، نه دعوت به ساختن.**
 *
 * قبلاً اینجا یک خروجی حداقلی ساخته می‌شد ({ __dry: true, confident: 0.9, ... }).
 * آن چیز شبیه جواب بود ولی جواب نبود: از هیچ اسکیمایی رد نمی‌شد، فیلدهای
 * الزامی را نداشت، و `confident: 0.9` یک عددِ از هوا آمده بود که دروازه‌ها را
 * باز می‌کرد. مرحله‌ای که رویش بنا می‌شد سبز می‌ماند و ما فکر می‌کردیم آن مسیر
 * را تست کرده‌ایم — در حالی که چیزی جز stub از آن رد نشده بود.
 *
 * حالا اگر fixture نباشد، همان‌جا صریح می‌ایستد. نبودِ پوشش، بهتر است دیده شود
 * تا اینکه شبیه پوشش به نظر برسد.
 */
async function dryRun(toolName) {
  const { readFile } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const dir = process.env.VOHU_FIXTURES || './fixtures';
  const f = `${dir}/${toolName}.json`;
  if (!existsSync(f)) {
    const err = new Error(`fixture برای «${toolName}» وجود ندارد — ${f}`);
    err.hint = 'حالت خشک چیزی از خودش نمی‌سازد: خروجیِ ساختگی از هیچ اسکیمایی رد نمی‌شود '
             + 'و مرحله‌های بعدی را روی داده‌ی توخالی بنا می‌کند. یا fixture واقعیِ این مرحله '
             + 'را در پوشه بگذار، یا این مسیر را در حالت خشک اجرا نکن.';
    err.fixture = f;
    throw err;
  }
  return JSON.parse(await readFile(f, 'utf8'));
}

export async function callWithSchema({
  prompt,
  schema,
  toolName = 'result',
  model,                            // اگر ندهی، از سرویس فعال گرفته می‌شود
  maxTokens = 8000,
  engine                            // سرویس قفل‌شده‌ی این اجرا — از run.engine می‌آید
}) {
  // حالت خشک از دروازه‌ی اسکیما رد نمی‌شود: آنجا مدلی در کار نیست و خروجی
  // fixture خودمان است. دروازه برای بی‌انضباطیِ مدل است، نه برای داده‌ی خودمان.
  if (process.env.VOHU_DRY_RUN) {
    const data = await dryRun(toolName);
    const meta = { model: 'dry-run', provider: 'dry-run', ms: 0 };
    return { data: stamp(data, meta), meta };
  }

  const now = activeEngine();

  const provider = now.provider;
  const useModel = model || now.model;

  // ── قفلِ سرویس و مدل ────────────────────────────────────────
  // اجرا با هر سرویس و مدلی شروع شده، با همان تمام می‌شود. اگر .env وسط کار
  // عوض شده باشد، اینجا صریح می‌ایستد.
  //
  // چرا مدل هم قفل است و ردیابی‌پذیری کافی نیست: دوری که نیمش را یک مدل
  // ساخته و نیم دیگرش را مدلی دیگر، برای مقایسه‌ی دوربه‌دور بی‌اعتبار است —
  // و حافظه‌ی یادگیری دقیقاً روی همان مقایسه بنا می‌شود.
  if (engine?.provider && engine.provider !== provider) {
    const err = new Error(
      `این اجرا با ${engine.provider} شروع شده ولی VOHU_PROVIDER حالا ${provider} است`);
    err.hint = `یا VOHU_PROVIDER را به ${engine.provider} برگردان، یا با «شروع از نو» یک اجرای تازه بساز. `
             + 'یک اجرا نصفه با یک سرویس و نصفه با سرویس دیگر ساخته نمی‌شود.';
    throw err;
  }
  if (engine?.model && engine.model !== useModel) {
    const envVar = provider === 'openai' ? 'OPENAI_MODEL' : 'VOHU_MODEL';
    const err = new Error(
      `این اجرا با ${engine.model} شروع شده ولی ${envVar} حالا ${useModel || '؟'} است`);
    err.hint = `یا ${envVar} را به ${engine.model} برگردان، یا با «شروع از نو» یک اجرای تازه بساز. `
             + 'یک اجرا نصفه با یک مدل و نصفه با مدل دیگر ساخته نمی‌شود — آن دور برای '
             + 'مقایسه‌ی دوربه‌دور و حافظه‌ی یادگیری بی‌اعتبار می‌شود.';
    throw err;
  }
  const timeoutMs = Number(process.env.VOHU_CALL_TIMEOUT_MS || 180000);

  // ── OpenAI ──────────────────────────────────────────────────
  if (provider === 'openai') {
    if (!process.env.OPENAI_API_KEY) {
      const err = new Error('VOHU_PROVIDER=openai است ولی OPENAI_API_KEY در .env نیست');
      err.hint = 'یا کلید را بگذار، یا VOHU_PROVIDER را روی anthropic برگردان.';
      throw err;
    }
    try {
      const out = await guardSchema({ schema, toolName, attempt: ({ retryNote }) =>
        callOpenAISchema({ prompt: retryNote ? prompt + retryNote : prompt,
                           schema, toolName, maxTokens, timeoutMs, model: useModel }) });
      return { ...out, data: stamp(out.data, out.meta) };
    } catch (e) {
      // ردشدن از دروازه‌ی اسکیما ربطی به سرویس ندارد — پیامش دست‌نخورده بماند،
      // وگرنه کاربر به‌جای «مدل بدشکل جواب داد» می‌خواند «سرویس را عوض کن».
      if (e?.violations) throw e;
      console.error('[مدل/openai]', e?.message || e);
      const err = new Error(e.message);
      err.hint = 'اجرا همین‌جا ایستاد و با سرویس دیگری تمام نمی‌شود. '
               + 'اگر می‌خواهی با Anthropic ادامه دهی: VOHU_PROVIDER=anthropic و یک اجرای تازه.';
      err.cause = e;
      throw err;
    }
  }

  // ── Anthropic ───────────────────────────────────────────────
  // مسیر anthropic نام مدل را فقط از VOHU_MODEL می‌خواند — پیام باید همان اسم
  // را بگوید و اگر مدل در متغیرِ آن‌یکی سرویس نشسته باشد، صریح بگوید کجاست.
  if (!useModel) {
    const err = new Error(
      'VOHU_MODEL در .env تعریف نشده — با VOHU_PROVIDER=anthropic نام مدل فقط از VOHU_MODEL خوانده می‌شود');
    err.hint = process.env.OPENAI_MODEL
      ? `الان OPENAI_MODEL=«${process.env.OPENAI_MODEL}» در .env هست، ولی آن فقط مسیر openai را تغذیه می‌کند. `
        + `یک خط  VOHU_MODEL=${process.env.OPENAI_MODEL}  به .env اضافه کن و سرور را دوباره بالا بیاور.`
      : 'یک خط  VOHU_MODEL=claude-sonnet-5  به .env اضافه کن و سرور را دوباره بالا بیاور.';
    throw err;
  }

  const client = await getClient();

  // tool_choice مدل را مجبور می‌کند ابزار را صدا بزند، ولی هیچ تضمینی نمی‌دهد
  // که *داخل* ابزار شکل درستی باشد. آن تضمین کار دروازه است، نه کار مدل.
  const once = async ({ retryNote }) => {
    const t0 = Date.now();
    let res;
    try {
      res = await client.messages.create({
        model: useModel,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: retryNote ? prompt + retryNote : prompt }],
        tools: [{
          name: toolName,
          // یک جمله‌ی پیشگیرانه، ارزان‌تر از یک تلاش دوباره: بدشکل‌ترین خطایی
          // که دیدیم این بود که کل خروجی داخل *یک* فیلد رشته‌ای ریخته شد.
          description: 'خروجی ساختاریافته را با این ابزار برگردان. '
                     + 'هر فیلد با نوع خودش — هیچ فیلدی را به‌صورت رشته‌ی JSON نده و چند فیلد را داخل یکی نچپان.',
          input_schema: schema
        }],
        tool_choice: { type: 'tool', name: toolName }   // مدل مجبور است این را صدا بزند
      }, { timeout: timeoutMs, maxRetries: 1 });
    } catch (e) {
      // متن خام فقط اینجا می‌ماند — نه روی صفحه‌ی کاربر
      console.error('[مدل]', e?.status || '', e?.message || e);
      const err = new Error(faModelError(e, { timeoutMs, model: useModel }));
      err.hint  = faModelHint(e);
      err.cause = e;
      throw err;
    }

    const block = res.content.find(c => c.type === 'tool_use');
    if (!block) throw new Error('مدل خروجی ساختاریافته برنگرداند');

    return {
      data: block.input,
      meta: {
        model: useModel,
        provider: 'anthropic',
        ms: Date.now() - t0,
        inputTokens: res.usage?.input_tokens,
        outputTokens: res.usage?.output_tokens
      }
    };
  };

  const out = await guardSchema({ schema, toolName, attempt: once });
  return { data: stamp(out.data, out.meta), meta: out.meta };
}
