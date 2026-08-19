/**
 * خواندن متن یک صفحه‌ی وب.
 * نسخه‌ی ساده — برای شروع کافی است.
 * وقتی به اینستاگرام رسیدی، اینجا را با Apify عوض کن (پایین توضیح داده شده).
 */

export async function fetchPageText(url, { timeoutMs = 20000 } = {}) {
  // حالت خشک: صفحه از فایل خوانده می‌شود، نه از شبکه.
  // برای تست کل جریان بدون اینترنت و بدون توکن.
  if (process.env.VOHU_DRY_RUN) {
    const { readFile } = await import('node:fs/promises');
    const { existsSync } = await import('node:fs');
    const f = `${process.env.VOHU_FIXTURES || './fixtures'}/page.txt`;
    if (existsSync(f)) return { ok: true, url, text: await readFile(f, 'utf8'), rawLength: 0, dry: true };
    return { ok: true, url, text: '(اجرای خشک — فایل fixtures/page.txt پیدا نشد)', rawLength: 0, dry: true };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        // بعضی سایت‌ها بدون این جواب نمی‌دهند
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36',
        'accept-language': 'fa-IR,fa;q=0.9,en;q=0.8'
      }
    });

    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, url };
    }

    const html = await res.text();
    return { ok: true, url, text: stripHtml(html), rawLength: html.length };

  } catch (e) {
    // این همان حالتی است که باید لاگ بگیری:
    // اگر از سرور فنلاند/انگلیس تایم‌اوت خورد، یعنی باید Apify یا پراکسی بگذاری
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message, url };
  } finally {
    clearTimeout(timer);
  }
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40000); // سقف، تا توکن هدر نرود
}
