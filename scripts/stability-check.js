/**
 * سنجش پایداری — همان ورودی، چند اجرا، چقدر جواب یکی است؟
 *
 *   node scripts/stability-check.js out1.json out2.json out3.json
 *
 * چرا لازم است: استخراج واقعیت معمولاً پایدار است، ولی **قضاوت** نه.
 * اگر «کدام محصول قابل استفاده است» بین اجراها فرق کند،
 * کمپین هر بار حول محصولات متفاوتی ساخته می‌شود و کسی متوجه نمی‌شود.
 *
 * این را بعد از هر تغییر در پرامپت اجرا کن. اگر توافق افت کرد، پرامپت مبهم شده.
 */

import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (files.length < 2) {
  console.error('استفاده: node scripts/stability-check.js <خروجی۱.json> <خروجی۲.json> [...]');
  process.exit(1);
}

const runs = files.map(f => ({ f, d: JSON.parse(readFileSync(f, 'utf8')) }));
const key  = p => String(p.product).replace(/\s+/g, ' ').trim();

// سازگاری با خروجی‌های قدیمی که usable بولی بود
const norm = u => u === true ? 'yes' : u === false ? 'no' : (u ?? 'missing');

// ── ۱ · شمارش وضعیت‌ها ──
console.log('\n═══ شمارش ═══');
console.log('فایل'.padEnd(24) + 'ثبت‌شده  هست  نیست  نمی‌دانم  واقعیت');
for (const r of runs) {
  const pu = r.d.productUsability || [];
  const g  = s => pu.filter(p => norm(p.usable) === s).length;
  let facts = 0;
  (function walk(o){ if(!o||typeof o!=='object')return;
    if('status'in o&&'value'in o){ if(o.status==='fact')facts++; return; }
    for(const v of Object.values(o)) Array.isArray(v)?v.forEach(walk):walk(v); })(r.d);
  console.log(r.f.split('/').pop().padEnd(24) +
    String(pu.length).padEnd(9) + String(g('yes')).padEnd(6) +
    String(g('no')).padEnd(6) + String(g('unknown')).padEnd(10) + facts);
}

// ── ۲ · توافق روی وضعیت هر قلم ──
const maps = runs.map(r => new Map((r.d.productUsability || []).map(p => [key(p), norm(p.usable)])));
const all  = [...new Set(maps.flatMap(m => [...m.keys()]))].sort();

const disagree = [];
let agree = 0;
for (const p of all) {
  const v = maps.map(m => m.get(p) ?? '—');
  if (v.every(x => x === v[0])) agree++; else disagree.push([p, v]);
}

const pct = all.length ? Math.round(agree / all.length * 100) : 100;
console.log(`\n═══ توافق ═══`);
console.log(`  اقلام ثبت‌شده در همه‌ی اجراها: ${all.filter(p => maps.every(m => m.has(p))).length} از ${all.length}`);
console.log(`  توافق کامل روی وضعیت:         ${agree} از ${all.length}  →  ${pct}٪`);

if (disagree.length) {
  console.log('\n  ── اختلاف‌ها ──');
  disagree.forEach(([p, v]) => console.log(`  ${p.slice(0, 44).padEnd(45)} ${v.join(' / ')}`));
}

// ── ۳ · سبد کمپین — مهم‌ترین عدد ──
const yes    = maps.map(m => new Set([...m].filter(([, v]) => v === 'yes').map(([k]) => k)));
const common = [...yes[0]].filter(p => yes.every(s => s.has(p)));
const union  = [...new Set(yes.flatMap(s => [...s]))];
const basket = union.length ? Math.round(common.length / union.length * 100) : 0;

console.log(`\n═══ سبد کمپین ═══`);
console.log(`  «قابل استفاده» در همه‌ی اجراها: ${common.length} از ${union.length}  →  ${basket}٪`);
console.log('  این مهم‌ترین عدد است — کمپین حول همین‌ها ساخته می‌شود.\n');

if (!union.length) {
  console.log('  ⛔ هیچ قلمی در هیچ اجرایی «قابل استفاده» علامت نخورد.');
  console.log('     یا ورودی اشتباه است، یا خروجی‌ها با نسخه‌ی فعلی اسکیما نمی‌خوانند.\n');
  process.exit(1);
}

if (basket < 90) {
  console.log('  ⛔ زیر ۹۰٪. یعنی پرامپت جایی مبهم است و مدل بین دو خوانش معقول انتخاب می‌کند.');
  console.log('     دنبال جایی بگرد که «نمی‌دانم» گزینه‌ی صریحی نیست.\n');
  process.exit(1);
}
console.log('  ✓ پایدار.\n');
