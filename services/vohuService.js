/**
 * تنها تابعی که برای صدا زدن مدل لازم داری.
 * از tool-use استفاده می‌کند تا خروجی حتماً مطابق اسکیما باشد و لازم نباشد متن پارس کنی.
 */

// SDK با تأخیر بارگذاری می‌شود — در حالت خشک اصلاً لازم نیست،
// پس می‌شود کل جریان را قبل از npm install هم تست کرد.
let _client = null;
async function getClient() {
  if (_client) return _client;
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
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
  model = process.env.VOHU_MODEL,   // در .env بگذار — برای تست مدل‌های مختلف همین را عوض کن
  maxTokens = 8000
}) {
  if (process.env.VOHU_DRY_RUN) {
    return { data: await dryRun(toolName), meta: { model: 'dry-run', ms: 0 } };
  }

  if (!model) throw new Error('VOHU_MODEL در .env تعریف نشده');

  const t0 = Date.now();

  const client = await getClient();
  // بدون سقف، یک تماس گیرکرده تا ده دقیقه کاربر را پشت اسپینر نگه می‌دارد
  const timeoutMs = Number(process.env.VOHU_CALL_TIMEOUT_MS || 180000);
  const res = await client.messages.create({
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
    tools: [{
      name: toolName,
      description: 'خروجی ساختاریافته را با این ابزار برگردان.',
      input_schema: schema
    }],
    tool_choice: { type: 'tool', name: toolName }   // مدل مجبور است این را صدا بزند
  }, { timeout: timeoutMs, maxRetries: 1 });

  const block = res.content.find(c => c.type === 'tool_use');
  if (!block) throw new Error('مدل خروجی ساختاریافته برنگرداند');

  return {
    data: block.input,
    meta: {
      model,
      ms: Date.now() - t0,
      inputTokens: res.usage?.input_tokens,
      outputTokens: res.usage?.output_tokens
    }
  };
}
