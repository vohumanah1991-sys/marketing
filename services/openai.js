/**
 * لایه‌ی OpenAI — تنها جایی از برنامه که کلید OpenAI را می‌شناسد.
 *
 * این لایه فقط «چطور با OpenAI حرف بزنیم» را می‌داند. اینکه اصلاً کدام سرویس
 * صدا زده شود تصمیم services/vohuService.js است و از VOHU_PROVIDER می‌آید —
 * اینجا هیچ منطق انتخاب یا جایگزینی نیست.
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

/** فقط یعنی «کلید هست؟» — نه اینکه سرویس انتخاب‌شده کدام است. */
export const openaiEnabled = () => Boolean(process.env.OPENAI_API_KEY);

export function redactOpenAI(s) {
  return String(s ?? '')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1***');
}

/**
 * خطای OpenAI به فارسی — دقیقاً به همان دلیلی که سمت Anthropic این کار شد:
 * کاربر نباید JSON انگلیسی ببیند.
 */
export function faOpenAIError(status, body, { timeoutMs, model } = {}) {
  const raw = String(body?.error?.message || body?.message || body || '');
  const code = body?.error?.code || body?.error?.type || '';

  if (status === 'timeout')
    return `OpenAI در ${Math.round((timeoutMs || 0) / 1000)}s جواب نداد`;
  if (status === 'network')
    return `به ${openaiBase()} نرسیدیم — اگر سرور ایران است، OPENAI_BASE_URL را روی یک درگاه واسط بگذار`;
  if (status === 401)
    return 'کلید OPENAI_API_KEY پذیرفته نشد — کلید داخل .env را چک کن';
  if (status === 403)
    return 'OpenAI این درخواست را نپذیرفت (۴۰۳) — معمولاً یعنی از این کشور/منطقه اجازه نمی‌دهد';
  if (status === 404)
    return `مدل «${model || openaiModel()}» در OpenAI پیدا نشد — OPENAI_MODEL در .env را چک کن`;
  if (status === 429 && /quota|billing/i.test(raw + code))
    return 'اعتبار حساب OpenAI تمام شده — شارژ کن یا VOHU_PROVIDER را عوض کن';
  if (status === 429)
    return 'سقف نرخ درخواست OpenAI پر شد — چند لحظه بعد دوباره بزن';
  if (status >= 500)
    return `خطای سرور OpenAI (${status}) — چند لحظه بعد دوباره بزن`;
  return `OpenAI رد کرد (${status})${raw ? ' — ' + redactOpenAI(raw).slice(0, 200) : ''}`;
}

/**
 * همان قرارداد callWithSchema، ولی روی OpenAI:
 * مدل مجبور می‌شود یک تابع با همان اسکیما را صدا بزند، پس خروجی
 * ساختاریافته است و لازم نیست متن پارس شود.
 */
export async function callOpenAISchema({ prompt, schema, toolName = 'result', maxTokens = 8000, timeoutMs = 180000, model }) {
  model = model || openaiModel();
  const t0 = Date.now();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res, text;
  try {
    res = await fetch(`${openaiBase()}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'content-type': 'application/json'
      },
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        max_completion_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
        tools: [{
          type: 'function',
          function: {
            name: toolName,
            description: 'خروجی ساختاریافته را با این تابع برگردان.',
            parameters: schema
          }
        }],
        tool_choice: { type: 'function', function: { name: toolName } }
      })
    });
    text = await res.text();
  } catch (e) {
    clearTimeout(timer);
    const kind = e?.name === 'AbortError' ? 'timeout' : 'network';
    throw new Error(faOpenAIError(kind, e?.message, { timeoutMs, model }));
  }
  clearTimeout(timer);

  let body = null;
  try { body = JSON.parse(text); } catch {}

  if (!res.ok) throw new Error(faOpenAIError(res.status, body ?? text, { timeoutMs, model }));
  if (!body)   throw new Error('خروجی OpenAI اصلاً JSON نبود');

  const args = body?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!args) throw new Error('OpenAI خروجی ساختاریافته برنگرداند');

  let data;
  try { data = JSON.parse(args); }
  catch { throw new Error('خروجی OpenAI JSON معتبر نبود'); }

  // اسکیما را خود کد چک می‌کند، نه پرامپت — قاعده‌ی ۲.
  // فقط فیلدهای اجباریِ سطح اول؛ نبودشان یعنی خروجی به درد بقیه‌ی زنجیره نمی‌خورد.
  const missing = (schema?.required || []).filter(k => data?.[k] === undefined);
  if (missing.length)
    throw new Error(`خروجی OpenAI فیلدهای اجباری را ندارد: ${missing.join(', ')}`);

  return {
    data,
    meta: {
      model,
      provider: 'openai',
      ms: Date.now() - t0,
      inputTokens:  body?.usage?.prompt_tokens,
      outputTokens: body?.usage?.completion_tokens
    }
  };
}
