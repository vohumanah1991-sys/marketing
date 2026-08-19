/**
 * راستی‌آزمایی خودکار — مهم‌ترین ابزار تست تو.
 *
 * کاری که می‌کند: هر فیلدی که مدل «واقعیت» علامت زده را برمی‌دارد و
 * چک می‌کند عبارتی که به‌عنوان منبع داده، واقعاً در متن صفحه هست یا نه.
 * هیچ قضاوت انسانی لازم نیست.
 *
 * اجرا:  node verify-facts.js page.txt extraction.json
 */

import { readFileSync } from 'node:fs';

const [, , pagePath, jsonPath] = process.argv;
if (!pagePath || !jsonPath) {
  console.error('استفاده: node verify-facts.js <page.txt> <extraction.json>');
  process.exit(1);
}

const page = norm(readFileSync(pagePath, 'utf8'));
const data = JSON.parse(readFileSync(jsonPath, 'utf8'));

const facts = [];
walk(data, v => { if (v?.status === 'fact') facts.push(v); });

let ok = 0, noSource = 0, notFound = 0, tooShort = 0, stitched = 0;
const problems = [];

for (const f of facts) {
  if (!f.source) {
    noSource++;
    problems.push({ kind: 'بدون منبع', value: f.value });
    continue;
  }
  // منبع ممکن است چند تکه‌ی جدا باشد که با / یا ؛ یا … به هم چسبیده‌اند.
  // هر تکه را جدا چک می‌کنیم. تکه‌های خیلی کوتاه شمرده نمی‌شوند.
  const parts = String(f.source)
    .split(/\s*[\/؛;|…]+\s*|\s*\.\.\.\s*/)
    .map(norm)
    .filter(p => p.length >= 8);

  if (parts.length === 0) {
    tooShort++;
    problems.push({ kind: 'منبع خیلی کوتاه برای بررسی', value: f.value, source: f.source });
    continue;
  }

  const missing = parts.filter(p => !page.includes(p));
  if (missing.length === 0) {
    ok++;
    if (parts.length > 1) stitched++;
  } else {
    notFound++;
    problems.push({ kind: `${missing.length} تکه از ${parts.length} تکه پیدا نشد`,
                    value: f.value, source: missing.join(' ⟂ ') });
  }
}

const total = facts.length;
const badRate = total ? ((noSource + notFound + tooShort) / total * 100).toFixed(1) : '0.0';

console.log('\n══════ راستی‌آزمایی ══════\n');
console.log(`  کل «واقعیت»ها:        ${total}`);
console.log(`  ✓ منبع تأیید شد:      ${ok}`);
console.log(`  ✗ منبع پیدا نشد:      ${notFound}`);
console.log(`  ✗ اصلاً منبع نداشت:   ${noSource}`);
console.log(`  ✗ منبع خیلی کوتاه:    ${tooShort}`);
if (stitched) console.log(`  ⓘ منبع چندتکه‌ای:     ${stitched}  (همه‌ی تکه‌ها تأیید شد)`);
console.log(`\n  نرخ تأیید غلط:        ${badRate}%   ← این عددی است که مدل‌ها را با آن مقایسه کن`);

if (problems.length) {
  console.log('\n  ── موارد مشکل‌دار ──');
  problems.forEach(p => {
    console.log(`  ✗ [${p.kind}] ${String(p.value).slice(0, 60)}`);
    if (p.source) console.log(`     ادعا کرد منبعش این است: "${String(p.source).slice(0, 80)}"`);
  });
  console.log('\n  حکم: این مدل برای وُهو قابل اعتماد نیست.');
  console.log('  یک تأیید غلط از ده فیلد خالی بدتر است.\n');
  process.exit(1);
} else {
  console.log('\n  ✓ هیچ ادعای بی‌پشتوانه‌ای پیدا نشد.\n');
}

function norm(s) { return String(s).replace(/[\s‌]+/g, ' ').trim().toLowerCase(); }
function walk(o, fn) {
  if (!o || typeof o !== 'object') return;
  if ('status' in o && 'value' in o) fn(o);
  for (const v of Object.values(o)) {
    if (Array.isArray(v)) v.forEach(x => walk(x, fn));
    else walk(v, fn);
  }
}
