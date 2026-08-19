#!/usr/bin/env node
/**
 * وُهو از ترمینال — کل مسیر، روی یک کسب‌وکار واقعی.
 *
 *   node run-vohu.js https://example.com "یک خط توضیح"
 *
 * اگر وسط کار قطع شد، همان دستور را دوباره بزن؛ از جایی که مانده ادامه می‌دهد.
 * برای شروع از صفر:  node run-vohu.js <url> --fresh
 */

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { runPipeline } from './lib/pipeline.js';

const url   = process.argv[2];
const note  = process.argv.find((a, i) => i > 2 && !a.startsWith('--')) || '';
const fresh = process.argv.includes('--fresh');

if (!url) {
  console.error('استفاده: node run-vohu.js <url> ["توضیح کوتاه"] [--fresh]');
  process.exit(1);
}

const rl = readline.createInterface({ input, output });
const C  = { dim: s => `\x1b[2m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`,
             v: s => `\x1b[35m${s}\x1b[0m`, g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m` };
const line = (c = '─') => console.log(C.dim(c.repeat(68)));
const wrap = (t, w = 64) => String(t).replace(new RegExp(`(.{${w}}\\S*)\\s`, 'g'), '$1\n  ');

const io = {
  log: m => console.log(C.dim(m)),

  async askCompetitors() {
    console.log('\n' + C.b('سه رقیبت را اسم ببر') + C.dim('  (آدرس سایت یا پیج، با کاما جدا کن — خالی بگذار تا رد شود)'));
    const a = await rl.question('› ');
    return a.split(/[,،\s]+/).map(s => s.trim()).filter(Boolean)
            .map(s => s.startsWith('http') ? s : `https://${s}`);
  },

  async askQuestions(q) {
    const answers = {}, assumptionResponses = {}, constraints = [];

    if (q.questions?.length) {
      console.log('\n' + C.b(`${q.questions.length} چیز را نمی‌دانم و جوابشان مسیر را عوض می‌کند:`) + '\n');
      for (const [i, x] of q.questions.entries()) {
        console.log(C.b(`${i + 1}. ${wrap(x.question)}`));
        console.log(C.dim(`   چرا مهم است: ${wrap(x.whyItMatters, 60)}`));
        if (x.options?.length) console.log(C.dim(`   ${x.options.join('  |  ')}`));
        const a = await rl.question('   › ');
        answers[`q${i + 1}`] = a || 'نمی‌دانم';
        if (!a) console.log(C.dim(`   ← ${x.ifUnknown}`));
        console.log('');
      }
    }

    if (q.assumptions?.length) {
      console.log(C.b('و چند چیز را حدس زده‌ام. فقط بگو درست است یا نه:') + '\n');
      for (const a of q.assumptions) {
        console.log(`  ${wrap(a.statement)}`);
        const r = await rl.question(C.dim('  درست است؟ [بله / نه + توضیح] › '));
        assumptionResponses[a.statement] = r || 'نمی‌دانم';
        console.log('');
      }
    }

    console.log(C.b('چیزی هست که نمی‌خواهی درباره‌اش حرف بزنم؟') + C.dim('  (خالی = نه)'));
    const c = await rl.question('› ');
    if (c.trim()) {
      const why = await rl.question(C.dim('چرا؟ (دلیلش را نگه می‌دارم، چون معمولاً راه دورزدنش را نشان می‌دهد) › '));
      constraints.push({ what: c.trim(), reason: why.trim() || 'نگفته',
                         kind: 'concern_based', setAt: new Date().toISOString().slice(0, 10),
                         revisitWhen: ['اگر کاربر خودش دوباره مطرح کند'] });
    }
    return { answers, assumptionResponses, constraints };
  },

  show(o) {
    console.log('');
    if (o.type === 'need_more') {
      line(); console.log(C.r('  هنوز به اندازه‌ی کافی نمی‌شناسمت'));
      console.log('  ' + wrap(o.message || '—')); line(); return;
    }
    if (o.type === 'insight') {
      line('═');
      console.log('  ' + C.b(wrap(o.sentence)));
      console.log('\n  ' + C.v('[ خب، حالا چه کار کنم؟ ]') + C.dim('     از کجا فهمیدی؟'));
      if (o.supporting?.length) {
        console.log(C.dim('\n  ── و ' + o.supporting.length + ' چیز دیگر که دیدم ──'));
        o.supporting.forEach(s => console.log(C.dim('  · ' + wrap(s.finding, 62))));
      }
      if (o.scope) console.log(C.dim(`\n  ${o.scope.pagesRead ?? 0} صفحه · ${o.scope.competitorsRead ?? 0} رقیب · ${o.scope.postsRead ?? 0} پست`));
      line('═'); return;
    }
    if (o.type === 'campaign') {
      const c = o.campaign, fa = { attention: 'جلب توجه', case: 'ساختن دلیل', objection: 'برداشتن مانع', ask: 'درخواست اقدام' };
      line('═');
      console.log('  ' + C.b(`کمپین — ${c.pieces?.length ?? 0} قطعه`) + C.dim(`   ${c.channel ? c.channel.slice(0, 40) : ''}`));
      c.pieces?.forEach(p => {
        console.log(`\n  ${C.b(`قطعه ${p.n}`)} ${C.dim('· ' + (fa[p.purpose] || p.purpose))}`);
        console.log(`   ${wrap(p.angle, 60)}`);
        if (p.product) console.log(C.dim(`   محصول: ${p.product}`));
        if (p.timing)  console.log(C.dim(`   زمان: ${wrap(p.timing, 58)}`));
        console.log(C.dim(`   وصل به: ${String(p.tracesTo).slice(0, 60)}`));
      });
      console.log(C.dim('\n  ثابت می‌ماند: ') + (c.heldConstant || []).map(h => h.split('—')[0].split(':')[0].trim()).join(' · '));
      console.log(C.g('  فقط این تغییر می‌کند: ') + wrap(c.varies?.what, 58));
      if (c.dropOrder?.length) console.log(C.dim(`  اگر وقت کم آمد، حذف به ترتیب: ${c.dropOrder.join(' → ')}`));
      const cc = c.capacityCheck;
      if (cc) console.log(C.dim(`  ظرفیت: ${cc.statedTotal} ادعایی → ${cc.realisticTotal} واقع‌بینانه · ${cc.planned} ساخته شد`));
      line('═'); return;
    }
    if (o.type === 'strategy') {
      const c = o.card;
      line('═'); console.log('  ' + C.b('سه راه'));
      c.options?.forEach((x, i) => console.log(`\n  ${i + 1}. ${C.b(x.title)}\n     ${wrap(x.summary, 60)}`));
      console.log('\n  ' + C.g('توصیه: ' + c.recommended?.title));
      console.log('  ' + C.dim(wrap(c.recommended?.why, 62)));
      line();
      const fa = { goal: 'هدف', audience: 'مخاطب', tension: 'کشش', message: 'پیام',
                   reasonToBelieve: 'دلیل باور', action: 'اقدام', successSignal: 'نشانه' };
      console.log('  ' + C.b(`برنامه`) + C.dim(`   (${c.mode === 'small_test' ? 'آزمایش کوچک — بیشتر خانه‌ها حدس است' : 'کمپین کامل'})`));
      for (const [k, v] of Object.entries(c.cells || {}))
        console.log(`  ${(fa[k] || k).padEnd(11)} ${v.origin === 'fact' ? C.g('[واقعیت]') : C.dim('[حدس  ]')} ${wrap(v.value, 52)}`);
      if (c.builtAround?.length) console.log(C.dim('\n  حول: ' + c.builtAround.join(' · ').slice(0, 300)));
      if (c.reachCaveat) console.log(C.r('\n  ⚠ ' + wrap(c.reachCaveat, 62)));
      console.log(C.dim('\n  پیش‌بینی: ' + wrap(c.prediction?.observable, 60)));
      console.log(C.dim('  خطرناک‌ترین فرض: ' + wrap(c.riskiestAssumption, 60)));
      line('═'); return;
    }
  },

  async approveCard() {
    const a = await rl.question('\n' + C.b('تأیید می‌کنی؟ ') + C.dim('[بله / نه] › '));
    return /^(بله|آره|y|yes|ok)/i.test(a.trim());
  }
};

try {
  console.log(C.dim(`\nوُهو · ${url}\n`));
  const r = await runPipeline({ url, note, io, resume: !fresh });
  if (r.stopped) console.log(C.dim(`\nمتوقف شد: ${r.stopped}`));
  console.log(C.dim(`\nوضعیت اجرا در .vohu/ ذخیره شد. برای ادامه همین دستور را دوباره بزن.\n`));
} catch (e) {
  console.error(C.r('\nخطا: ' + e.message + '\n'));
  process.exitCode = 1;
} finally {
  rl.close();
}
