/**
 * تست قدم اول، بدون دست‌زدن به اپلیکیشن.
 *
 * اجرا:
 *   node scripts/test-extraction.js https://example.com "یک خط توضیح اختیاری"
 *
 * چه چیزی به تو می‌گوید:
 *   ۱. آیا سرورت اصلاً می‌تواند این سایت را بخواند
 *   ۲. مدل چند فیلد را پر کرد
 *   ۳. چند تا را «واقعیت» علامت زد  ← این عددی است که باید بررسی کنی
 *   ۴. چه چیزهایی را غایب تشخیص داد  ← ورودی جمله‌ی اول
 */

import { fetchPageText } from '../services/fetchPage.js';
import { callWithSchema } from '../services/vohuService.js';
import { EXTRACTION_PROMPT, EXTRACTION_SCHEMA } from '../prompts/vohuPrompts.js';
import { writeFileSync } from 'node:fs';

const url = process.argv[2];
const note = process.argv[3] || '';

if (!url) {
  console.error('استفاده: node scripts/test-extraction.js <url> ["توضیح کوتاه"]');
  process.exit(1);
}

console.log(`\n[۱/۳] خواندن صفحه: ${url}`);
const page = await fetchPageText(url);

if (!page.ok) {
  console.error(`\n❌ صفحه خوانده نشد: ${page.error}`);
  console.error('اگر timeout بود، یعنی سرور تو به این سایت دسترسی ندارد → سراغ Apify برو.\n');
  process.exit(1);
}
console.log(`    ✓ ${page.text.length} کاراکتر متن استخراج شد`);

console.log('[۲/۳] فرستادن به مدل...');
const { data, meta } = await callWithSchema({
  prompt: EXTRACTION_PROMPT({ pageContent: page.text, userNote: note }),
  schema: EXTRACTION_SCHEMA,
  toolName: 'business_knowledge'
});
console.log(`    ✓ ${meta.ms}ms · ${meta.inputTokens} توکن ورودی · ${meta.outputTokens} خروجی`);

// ── شمارش ──
let fact = 0, hyp = 0, unknown = 0;
const facts = [];
walk(data, (v) => {
  if (v?.status === 'fact')            { fact++; facts.push(v); }
  else if (v?.status === 'hypothesis') { hyp++; }
  else if (v?.status === 'unknown')    { unknown++; }
});

console.log('\n[۳/۳] نتیجه\n');
console.log(`  واقعیت:        ${fact}`);
console.log(`  حدس:           ${hyp}`);
console.log(`  نمی‌دانم:       ${unknown}`);

console.log('\n  ── چیزهایی که غایب تشخیص داد ──');
(data.absences || []).forEach(a => console.log(`  · ${a.what}  (${a.weight || '?'})`));

console.log('\n  ── هر چیزی که «واقعیت» علامت خورده ──');
console.log('  این مهم‌ترین بخش تست است. هر کدام را در صفحه جستجو کن.');
console.log('  اگر عبارتی در صفحه نبود، آن مدل قابل اعتماد نیست.\n');
facts.forEach(f => {
  console.log(`  • ${String(f.value).slice(0, 70)}`);
  console.log(`    منبع ادعایی: ${f.source ? String(f.source).slice(0, 90) : '⚠️  منبع نداده — این خودش ایراد است'}`);
});

const out = `extraction-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.json`;
writeFileSync(out, JSON.stringify({ url, meta, data }, null, 2));
console.log(`\n  خروجی کامل: ${out}\n`);

function walk(obj, fn) {
  if (!obj || typeof obj !== 'object') return;
  if ('status' in obj && 'value' in obj) fn(obj);
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) v.forEach(x => walk(x, fn));
    else walk(v, fn);
  }
}
