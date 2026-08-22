/**
 * هم‌گام‌کردن مغز: مخزن marketing → spark-saas.
 *
 *   npm run sync:brain            نگاه کن و بگو چه چیزی عوض می‌شود (چیزی نمی‌نویسد)
 *   npm run sync:brain -- --write  واقعاً کپی کن
 *   npm run sync:brain -- --write --force lib/session.js
 *                                  یک فایل را حتی اگر آنجا دستی عوض شده، بازنویس
 *
 * ── مسئله‌ای که این اسکریپت حل می‌کند ──────────────────────
 * مغز در دو جا زندگی می‌کند ولی **یک نسخه** است. مرجع اینجاست؛ spark یک کپی
 * دارد. کپیِ دستی دو خطر دارد و هر دو بی‌سروصدایند:
 *
 *   ۱. مخزن مرجع جلو می‌رود و کسی یادش می‌رود کپی را به‌روز کند. آن‌وقت یک
 *      باگِ رفع‌شده در آزمون تسترها دوباره ظاهر می‌شود.
 *   ۲. کسی مستقیم در spark یک فایل را عوض می‌کند و کپیِ بعدی آن را **دور
 *      می‌ریزد**. تغییری که کسی یادش نیست کجا رفت.
 *
 * جلوی دومی با یک مانیفست گرفته می‌شود: هر بار که کپی می‌کنیم، هشِ همان
 * لحظه ثبت می‌شود. دفعه‌ی بعد اگر فایلِ آنجا با هشِ ثبت‌شده فرق داشته باشد،
 * یعنی دستی عوض شده — **هشدار می‌دهد و کپی نمی‌کند.**
 *
 * ── چرا store.js کپی نمی‌شود ───────────────────────────────
 * تنها فایلی از مغز که در دو میزبان عمداً فرق دارد: اینجا روی فایل JSON،
 * آنجا روی SQLite تنانت. بازنویسی‌اش یعنی خراب‌کردن جداسازیِ کاربرها.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const SRC  = path.resolve(new URL('..', import.meta.url).pathname);
const DEST = process.env.SPARK_DIR || '/root/spark-saas/server/vohu';
const MANIFEST = path.join(DEST, '.sync-manifest.json');

/** ۱۷ فایل مغز — هرچه در `prompts/` و `lib/` و `services/` است، جز store.js. */
const BRAIN = [
  'prompts/vohuPrompts.js',
  'lib/env.js', 'lib/followUp.js', 'lib/igAnalyze.js', 'lib/igSync.js',
  'lib/instagram.js', 'lib/pipeline.js', 'lib/selftest.js', 'lib/session.js',
  'lib/userContext.js',
  'services/apify.js', 'services/fetchPage.js', 'services/jobs.js',
  'services/media.js', 'services/memory.js', 'services/openai.js',
  'services/vohuService.js'
];

/**
 * فایل‌هایی که مغز نیستند ولی آن‌ها هم کپی‌اند و بی‌سروصدا از هم دور می‌افتند.
 * تستی که در دو میزبان دو چیز را می‌سنجد، بدتر از تست نداشتن است.
 */
const COMPANIONS = [
  'scripts/test.js', 'scripts/test-once.js', 'scripts/test-loop.js',
  'public/index.html',
  ...['assumptions', 'business_knowledge', 'campaign', 'content_analysis', 'first_insight',
      'learning', 'market', 'performance', 'playing_field', 'questions', 'strategy_card']
      .map(n => `fixtures/${n}.json`),
  'fixtures/apify-posts.json', 'fixtures/apify-reels.json', 'fixtures/page.txt'
];

/** عمداً کپی نمی‌شوند — با دلیلش، تا کسی نپرسد چرا جا افتاده. */
const EXCLUDED = {
  'services/store.js': 'در spark روی SQLite تنانت است، نه فایل — بازنویسی یعنی خرابکردن جداسازی کاربرها'
};

const args    = process.argv.slice(2);
const WRITE   = args.includes('--write');
const BRAIN_ONLY = args.includes('--brain-only');
const FORCED  = new Set(args.filter((a, i) => args[i - 1] === '--force'));

const hash = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

const C = { red: s => `\x1b[31m${s}\x1b[0m`, green: s => `\x1b[32m${s}\x1b[0m`,
            amber: s => `\x1b[33m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m` };

async function loadManifest() {
  if (!existsSync(MANIFEST)) return {};
  try { return JSON.parse(await readFile(MANIFEST, 'utf8')).files || {}; }
  catch { return {}; }
}

/**
 * حکم یک فایل. چهار حالت، و فقط دوتایشان کپی می‌شوند.
 *
 * نکته‌ی ظریف: «آنجا نیست» با «آنجا هست ولی مانیفست ندارد» یکی نیست. دومی
 * یعنی نمی‌دانیم این فایل از کجا آمده — شاید کپیِ قبل از وجود مانیفست باشد،
 * شاید دست‌نویس. اگر با مرجع یکی باشد مسئله‌ای نیست؛ اگر نه، حدس نمی‌زنیم.
 */
function verdict(rel, srcHash, destHash, recorded) {
  if (destHash === null)                 return { kind: 'new',      copy: true };
  if (destHash === srcHash)              return { kind: 'same',     copy: false };
  if (FORCED.has(rel))                   return { kind: 'forced',   copy: true };
  if (!recorded)                         return { kind: 'unknown',  copy: false };
  if (destHash !== recorded)             return { kind: 'local',    copy: false };
  return { kind: 'stale', copy: true };   // آنجا همان چیزی است که ما گذاشته بودیم
}

const LABEL = {
  new:     [C.green, 'تازه',            'در spark نیست — کپی می‌شود'],
  stale:   [C.green, 'عقب',             'مرجع جلو رفته — کپی می‌شود'],
  forced:  [C.amber, 'اجباری',          '⚠ تغییر محلی spark دور ریخته می‌شود'],
  same:    [C.dim,   'یکی',             ''],
  local:   [C.red,   'دستی عوض شده',    'کپی نشد — اول ببین آنجا چه شده'],
  unknown: [C.red,   'مبدأ نامعلوم',    'کپی نشد — مانیفستی از آن نداریم و با مرجع فرق دارد']
};

async function run() {
  if (!existsSync(DEST)) {
    console.error(C.red(`مقصد پیدا نشد: ${DEST}`));
    console.error('اگر spark جای دیگری است: SPARK_DIR=/path/to/server/vohu npm run sync:brain');
    process.exit(1);
  }

  const recorded = await loadManifest();
  const files = BRAIN_ONLY ? BRAIN : [...BRAIN, ...COMPANIONS];
  const results = [];

  for (const rel of files) {
    const from = path.join(SRC, rel);
    const to   = path.join(DEST, rel);
    if (!existsSync(from)) { results.push({ rel, kind: 'missing-src' }); continue; }

    const srcBuf   = await readFile(from);
    const srcHash  = hash(srcBuf);
    const destHash = existsSync(to) ? hash(await readFile(to)) : null;
    const v = verdict(rel, srcHash, destHash, recorded[rel]);
    results.push({ rel, ...v, srcBuf, to, srcHash });
  }

  // ── گزارش ──
  const isBrain = r => BRAIN.includes(r.rel);
  for (const [title, group] of [['مغز', results.filter(isBrain)],
                                ['همراه', results.filter(r => !isBrain(r))]]) {
    if (!group.length) continue;
    console.log(`\n── ${title} (${group.length}) ──`);
    for (const r of group) {
      if (r.kind === 'missing-src') { console.log(`  ${C.red('؟')} ${r.rel} — در مرجع نیست`); continue; }
      const [color, tag, note] = LABEL[r.kind];
      const mark = r.copy ? '→' : (r.kind === 'same' ? '·' : '✗');
      console.log(`  ${color(mark)} ${r.rel.padEnd(30)} ${color(tag)}${note ? '  ' + C.dim(note) : ''}`);
    }
  }

  console.log(`\n── کپی نمی‌شوند، عمداً ──`);
  for (const [rel, why] of Object.entries(EXCLUDED))
    console.log(`  ${C.dim('—')} ${rel.padEnd(30)} ${C.dim(why)}`);

  const toCopy  = results.filter(r => r.copy);
  const blocked = results.filter(r => r.kind === 'local' || r.kind === 'unknown');

  console.log('');
  if (blocked.length) {
    console.log(C.red(`  ⚠ ${blocked.length} فایل در spark دستی عوض شده و کپی نشد.`));
    console.log(C.dim('    ببین آنجا چه تغییری داده شده. اگر آن تغییر لازم است، همین‌جا در'));
    console.log(C.dim('    مخزن مرجع اعمالش کن تا هر دو یکی بمانند. اگر لازم نیست:'));
    console.log(C.dim(`    npm run sync:brain -- --write --force ${blocked[0].rel}`));
    console.log('');
  }

  if (!WRITE) {
    console.log(`  ${toCopy.length} فایل آماده‌ی کپی. چیزی نوشته نشد — برای نوشتن: --write`);
    // وجودِ فایلِ دستی‌عوض‌شده یک وضعیت است، نه شکستِ اجرا
    process.exit(0);
  }

  for (const r of toCopy) {
    await mkdir(path.dirname(r.to), { recursive: true });
    await writeFile(r.to, r.srcBuf);
  }

  // مانیفست فقط برای فایل‌هایی که واقعاً آنجا هستند به‌روز می‌شود — نه آن‌هایی
  // که کپی نشدند، وگرنه دفعه‌ی بعد تغییر دستی‌شان «تأییدشده» به‌نظر می‌رسد.
  const next = { ...recorded };
  for (const r of results) {
    if (r.kind === 'missing-src') continue;
    if (r.copy) next[r.rel] = r.srcHash;
    else if (r.kind === 'same') next[r.rel] = r.srcHash;
  }
  await writeFile(MANIFEST, JSON.stringify({
    note: 'هشِ آخرین کپی. اگر فایل spark با این فرق داشته باشد یعنی دستی عوض شده.',
    syncedAt: new Date().toISOString(),
    source: SRC,
    files: next
  }, null, 2) + '\n');

  console.log(C.green(`  ✓ ${toCopy.length} فایل کپی شد و مانیفست به‌روز شد.`));
  if (blocked.length) console.log(C.red(`  ✗ ${blocked.length} فایل کپی نشد (بالا).`));
  console.log(C.dim('\n  حالا آنجا تست بگیر:  cd /root/spark-saas && npm run test:vohu'));
}

run().catch(e => { console.error(C.red('sync-brain شکست خورد: ' + e.message)); process.exit(1); });
