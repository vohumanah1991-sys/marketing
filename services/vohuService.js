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

/**
 * حالت خشک — برای تست جریان بدون صدا زدن مدل و بدون سوزاندن توکن.
 *
 *   VOHU_DRY_RUN=1 VOHU_FIXTURES=./fixtures node run-vohu.js <url>
 *
 * برای هر toolName یک فایل <toolName>.json در پوشه‌ی fixtures می‌خواند.
 * اگر نبود، یک خروجی حداقلی می‌سازد. این‌طور می‌شود دروازه‌ها، ادغام جواب‌ها
 * و قابلیت ادامه‌دادن را بدون هزینه تست کرد.
 */
async function dryRun(toolName) {
  const { readFile } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const dir = process.env.VOHU_FIXTURES || './fixtures';
  const f = `${dir}/${toolName}.json`;
  if (existsSync(f)) return JSON.parse(await readFile(f, 'utf8'));
  return { __dry: true, toolName, confident: 0.9, chosen: { sentence: '(اجرای خشک)' } };
}

export async function callWithSchema({
  prompt,
  schema,
  toolName = 'result',
  model,                            // اگر ندهی، از سرویس فعال گرفته می‌شود
  maxTokens = 8000,
  engine                            // سرویس قفل‌شده‌ی این اجرا — از run.engine می‌آید
}) {
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
      const out = await callOpenAISchema({ prompt, schema, toolName, maxTokens, timeoutMs, model: useModel });
      return { ...out, data: stamp(out.data, out.meta) };
    } catch (e) {
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

  const t0 = Date.now();
  const client = await getClient();
  let res;
  try {
    res = await client.messages.create({
      model: useModel,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
      tools: [{
        name: toolName,
        description: 'خروجی ساختاریافته را با این ابزار برگردان.',
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

  const meta = {
    model: useModel,
    provider: 'anthropic',
    ms: Date.now() - t0,
    inputTokens: res.usage?.input_tokens,
    outputTokens: res.usage?.output_tokens
  };
  return { data: stamp(block.input, meta), meta };
}
