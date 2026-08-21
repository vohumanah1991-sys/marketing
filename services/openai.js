/**
 * لایه‌ی OpenAI — تنها جایی از برنامه که کلید OpenAI را می‌شناسد.
 *
 * این لایه فقط «چطور با OpenAI حرف بزنیم» را می‌داند. اینکه اصلاً کدام سرویس
 * صدا زده شود تصمیم services/vohuService.js است و از VOHU_PROVIDER می‌آید —
 * اینجا هیچ منطق انتخاب یا جایگزینی نیست.
 *
 * دو مسیر، یک قرارداد:
 *   · مدل استدلالی (o-series و خانواده‌ی gpt-5) → POST /responses
 *   · مدل معمولی                                → POST /chat/completions
 * مسیر را نام مدل تعیین می‌کند، نه یک متغیر محیطی جدا — تا نشود مدل استدلالی
 * را روی مسیری فرستاد که استدلالش را دور می‌ریزد.
 *
 * هر دو مسیر همان `{ data, meta }` را برمی‌گردانند. بقیه‌ی زنجیره نباید
 * بفهمد کدام مسیر رفته است.
 *
 * قاعده‌های امنیتی — همان‌های Apify:
 *   · کلید فقط از process.env.OPENAI_API_KEY خوانده می‌شود.
 *   · فقط در هدر Authorization می‌رود، هرگز در query string.
 *   · هرچه لاگ می‌شود از redactOpenAI() رد می‌شود.
 *
 * بدون وابستگی تازه: fetch خود Node 20. یعنی npm install لازم نیست.
 */

const DEFAULT_BASE  = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4.1';

export const openaiBase  = () => (process.env.OPENAI_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
export const openaiModel = () => process.env.OPENAI_MODEL || DEFAULT_MODEL;

/**
 * مدل‌های استدلالی OpenAI — o1/o3/o4 و خانواده‌ی gpt-5.
 * این تشخیص فقط برای لاگ نیست: مسیر درخواست را همین تعیین می‌کند.
 */
export const isReasoningModel = (model) =>
  /^(o\d|gpt-5)/i.test(String(model || '').trim());

/** کدام سر (endpoint) برای این مدل؟ نام مدل تصمیم می‌گیرد، نه .env. */
export const openaiRoute = (model) =>
  isReasoningModel(model) ? '/responses' : '/chat/completions';

/**
 * مقدارهای معتبر reasoning.effort. اگر کسی چیز دیگری بگذارد، بهتر است همین‌جا
 * بایستد تا اینکه یک ۴۰۰ انگلیسی از OpenAI برگردد.
 */
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'];

/**
 * reasoning_effort دیگر دور ریخته نمی‌شود — روی مسیر /responses واقعاً فرستاده
 * می‌شود و مدل هم‌زمان استدلال و ابزار دارد.
 *
 * ولی روی مدل غیراستدلالی این پارامتر جایی ندارد: مسیر chat/completions آن را
 * نمی‌شناسد. در آن حالت بی‌سروصدا نمی‌افتد — یک خط در لاگ سرور می‌گوید چه
 * خواسته شد و چرا اعمال نشد. یک بار برای هر ترکیب مدل+مقدار، نه یک خط به ازای
 * هر تماس، چون یک اجرا ده‌ها تماس دارد و لاگ را کور می‌کند.
 */
const _effortLogged = new Set();

export function noteDroppedReasoningEffort(effort, model) {
  const want = String(effort ?? '').trim();
  if (!want) return null;                                 // چیزی خواسته نشده
  if (isReasoningModel(model)) return null;               // اعمال می‌شود — چیزی برای گفتن نیست

  const line = `[openai] reasoning_effort=«${want}» اعمال نشد — مدل «${model}» استدلالی نیست و `
    + 'از مسیر chat/completions می‌رود. برای اینکه اثر کند، OPENAI_MODEL را روی یک مدل '
    + 'استدلالی (o-series یا gpt-5) بگذار';

  const key = `${model} ${want}`;
  if (!_effortLogged.has(key)) {
    _effortLogged.add(key);
    console.warn(line);
  }
  return line;
}

/** فقط یعنی «کلید هست؟» — نه اینکه سرویس انتخاب‌شده کدام است. */
export const openaiEnabled = () => Boolean(process.env.OPENAI_API_KEY);

export function redactOpenAI(s) {
  return String(s ?? '')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1***');
}

/**
 * «این مدل در حساب تو نیست» — یک پیام، هر جا که لازم شود.
 * نام مدل همیشه داخل پیام است؛ کاربر نباید حدس بزند کدام اسم را عوض کند.
 */
const faModelMissing = (model) =>
  `مدل «${model || openaiModel()}» در حساب OpenAI موجود نیست — OPENAI_MODEL در .env را `
  + 'به مدلی که حسابت دارد عوض کن. /api/selftest فهرست مدل‌های همین حساب را نشان می‌دهد.';

/**
 * خطای OpenAI به فارسی — دقیقاً به همان دلیلی که سمت Anthropic این کار شد:
 * کاربر نباید JSON انگلیسی ببیند.
 */
export function faOpenAIError(status, body, { timeoutMs, model, route } = {}) {
  const raw = String(body?.error?.message || body?.message || body || '');
  const code = body?.error?.code || body?.error?.type || '';

  if (status === 'timeout')
    return `OpenAI در ${Math.round((timeoutMs || 0) / 1000)}s جواب نداد`;
  if (status === 'network')
    return `به ${openaiBase()} نرسیدیم — اگر سرور ایران است، OPENAI_BASE_URL را روی یک درگاه واسط بگذار`;

  // مدلِ نبوده از چند در می‌آید: ۴۰۴ روی chat/completions، ولی روی /responses
  // معمولاً ۴۰۰ با code=model_not_found. هر دو یک حرف می‌زنند، پس یک پیام.
  if (/model_not_found|does not exist|do not have access to (the )?model/i.test(`${code} ${raw}`))
    return faModelMissing(model);

  if (status === 401)
    return 'کلید OPENAI_API_KEY پذیرفته نشد — کلید داخل .env را چک کن';
  if (status === 403)
    return 'OpenAI این درخواست را نپذیرفت (۴۰۳) — معمولاً یعنی از این کشور/منطقه اجازه نمی‌دهد';
  if (status === 404 && route === '/responses')
    // درگاه واسطی که فقط chat/completions را بلد است. مدل استدلالی از این در می‌رود،
    // پس نبودن این سر یعنی همین‌جا بن‌بست — و راه دررو باید در خود پیام باشد.
    return `${openaiBase()} سرِ /responses را ندارد — مدل استدلالی «${model || openaiModel()}» از همین‌جا می‌رود. `
         + 'یا OPENAI_BASE_URL را روی درگاهی بگذار که /responses دارد، یا OPENAI_MODEL را روی یک مدل معمولی بگذار.';
  if (status === 404)
    return faModelMissing(model);
  if (status === 429 && /quota|billing/i.test(raw + code))
    return 'اعتبار حساب OpenAI تمام شده — شارژ کن یا VOHU_PROVIDER را عوض کن';
  if (status === 429)
    return 'سقف نرخ درخواست OpenAI پر شد — چند لحظه بعد دوباره بزن';
  if (status >= 500)
    return `خطای سرور OpenAI (${status}) — چند لحظه بعد دوباره بزن`;
  return `OpenAI رد کرد (${status})${raw ? ' — ' + redactOpenAI(raw).slice(0, 200) : ''}`;
}

/** یک POST با مهلت، با همان نگاشت خطای فارسی. مشترک بین دو مسیر. */
async function postOpenAI(route, payload, { timeoutMs, model }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res, text;
  try {
    res = await fetch(`${openaiBase()}${route}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'content-type': 'application/json'
      },
      signal: ctrl.signal,
      body: JSON.stringify(payload)
    });
    text = await res.text();
  } catch (e) {
    clearTimeout(timer);
    const kind = e?.name === 'AbortError' ? 'timeout' : 'network';
    throw new Error(faOpenAIError(kind, e?.message, { timeoutMs, model, route }));
  }
  clearTimeout(timer);

  let body = null;
  try { body = JSON.parse(text); } catch {}

  if (!res.ok) throw new Error(faOpenAIError(res.status, body ?? text, { timeoutMs, model, route }));
  if (!body)   throw new Error('خروجی OpenAI اصلاً JSON نبود');
  return body;
}

/**
 * همان قرارداد callWithSchema، ولی روی OpenAI:
 * مدل مجبور می‌شود یک تابع با همان اسکیما را صدا بزند، پس خروجی
 * ساختاریافته است و لازم نیست متن پارس شود.
 *
 * مسیر را نام مدل تعیین می‌کند؛ شکل برگشتی در هر دو مسیر یکی است.
 */
export async function callOpenAISchema({ prompt, schema, toolName = 'result', maxTokens = 8000, timeoutMs = 180000, model, reasoningEffort }) {
  model = model || openaiModel();
  const t0 = Date.now();

  const effort = String(reasoningEffort ?? process.env.OPENAI_REASONING_EFFORT ?? '').trim();
  if (effort && !EFFORTS.includes(effort))
    throw new Error(`OPENAI_REASONING_EFFORT=«${effort}» معتبر نیست — یکی از ${EFFORTS.join('، ')} را بگذار`);

  const route = openaiRoute(model);
  const description = 'خروجی ساختاریافته را با این تابع برگردان.';

  const { body, args } = route === '/responses'
    ? await callResponses({ prompt, schema, toolName, description, maxTokens, timeoutMs, model, effort })
    : await callChat({ prompt, schema, toolName, description, maxTokens, timeoutMs, model, effort });

  let data;
  try { data = JSON.parse(args); }
  catch { throw new Error('خروجی OpenAI JSON معتبر نبود'); }

  // اسکیما را خود کد چک می‌کند، نه پرامپت — قاعده‌ی ۲.
  // فقط فیلدهای اجباریِ سطح اول؛ نبودشان یعنی خروجی به درد بقیه‌ی زنجیره نمی‌خورد.
  const missing = (schema?.required || []).filter(k => data?.[k] === undefined);
  if (missing.length)
    throw new Error(`خروجی OpenAI فیلدهای اجباری را ندارد: ${missing.join(', ')}`);

  // شکل meta در هر دو مسیر یکی است — بقیه‌ی زنجیره نباید بفهمد از کدام سر آمده.
  return {
    data,
    meta: {
      model,
      provider: 'openai',
      ms: Date.now() - t0,
      inputTokens:  body?.usage?.prompt_tokens ?? body?.usage?.input_tokens,
      outputTokens: body?.usage?.completion_tokens ?? body?.usage?.output_tokens
    }
  };
}

/**
 * مسیر مدل استدلالی: /responses.
 * اینجا reasoning و function tools با هم می‌آیند — دلیل کل این جابه‌جایی همین است.
 */
async function callResponses({ prompt, schema, toolName, description, maxTokens, timeoutMs, model, effort }) {
  const body = await postOpenAI('/responses', {
    model,
    input: [{ role: 'user', content: prompt }],
    max_output_tokens: maxTokens,
    // در /responses ابزار تخت است: name کنار type، نه داخل function.
    tools: [{ type: 'function', name: toolName, description, parameters: schema }],
    tool_choice: { type: 'function', name: toolName },
    ...(effort ? { reasoning: { effort } } : {})
  }, { timeoutMs, model });

  const out = Array.isArray(body?.output) ? body.output : [];
  const call = out.find(o => o?.type === 'function_call' && (!toolName || o?.name === toolName))
            || out.find(o => o?.type === 'function_call');
  const args = call?.arguments;

  if (!args) {
    // حالت واقعی و آزاردهنده: استدلال کل سقف را خورد و نوبت به ابزار نرسید.
    // پیام باید بگوید کدام دو دستگیره را می‌شود چرخاند، وگرنه کاربر گیر می‌کند.
    if (body?.status === 'incomplete' && body?.incomplete_details?.reason === 'max_output_tokens')
      throw new Error(
        `مدل «${model}» پیش از ساختن خروجی به سقف ${maxTokens} توکن رسید — استدلال کل بودجه را خورد. `
        + 'یا OPENAI_REASONING_EFFORT را کمتر بگذار (low/minimal)، یا سقف توکن را بالا ببر.');
    throw new Error('OpenAI خروجی ساختاریافته برنگرداند');
  }
  return { body, args };
}

/** مسیر مدل معمولی: همان chat/completions قبلی، بی‌تغییر. */
async function callChat({ prompt, schema, toolName, description, maxTokens, timeoutMs, model, effort }) {
  // reasoning اینجا جا ندارد؛ اگر خواسته شده بود، بی‌صدا نمی‌افتد.
  noteDroppedReasoningEffort(effort, model);

  const body = await postOpenAI('/chat/completions', {
    model,
    max_completion_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
    tools: [{
      type: 'function',
      function: { name: toolName, description, parameters: schema }
    }],
    tool_choice: { type: 'function', function: { name: toolName } }
  }, { timeoutMs, model });

  const args = body?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!args) throw new Error('OpenAI خروجی ساختاریافته برنگرداند');
  return { body, args };
}
