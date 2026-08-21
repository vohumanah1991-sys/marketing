/**
 * حافظه‌ی کسب‌وکار — چیزی که بین دورها می‌ماند.
 *
 * تا امروز `learningMemory` فقط **خوانده** می‌شد و هیچ‌جا نوشته نمی‌شد. یعنی
 * هر دور از صفر شروع می‌کرد: همان سؤال‌ها دوباره پرسیده می‌شدند، همان گلوگاه
 * دوباره هدف می‌گرفت، و threadFatigue همیشه فهرست خالی می‌دید پس هیچ نخی
 * هرگز «خسته» نمی‌شد. کل نیمه‌ی دوم حلقه بی‌اثر بود.
 *
 * چرا فایل جدا از اجرا:
 *   · «شروع از نو» اجرا را دور می‌ریزد — و باید بریزد. ولی درسی که از دور
 *     قبل گرفته‌ایم دانشِ کسب‌وکار است، نه وضعیتِ یک اجرا. با اجرا پاک نمی‌شود.
 *   · فقط learn() رویش می‌نویسد. استخراج، شناخت و کارت هرگز — وگرنه حافظه
 *     پر می‌شود از چیزهایی که هنوز آزموده نشده‌اند.
 *
 * مسیر: `.vohu/<user>/memory-<slug>.json` — همان slug اجرا، پس یک کسب‌وکار
 * یک حافظه دارد حتی اگر ده بار از نو شروع شده باشد.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { userDir, ensureDir, writeJsonAtomic, slug } from './store.js';

export const memoryFile = (url) => path.join(userDir(), `memory-${slug(url)}.json`);

/** شکل حداقلی — هر خواننده‌ای می‌تواند بدون چک روی آرایه‌ها حلقه بزند. */
const EMPTY = () => ({
  campaignHistory: [],   // ← threadFatigue دقیقاً همین را می‌خواهد
  hypotheses:      [],
  tonePreferences: [],
  askedQuestions:  [],
  contentPatterns: [],
  needForNext:     null
});

export async function loadMemory(url) {
  const file = memoryFile(url);
  if (!existsSync(file)) return EMPTY();
  try {
    return { ...EMPTY(), ...JSON.parse(await readFile(file, 'utf8')) };
  } catch {
    // حافظه‌ی خراب نباید اجرا را بخواباند. از دست‌دادن درس‌ها بد است،
    // ولی گیرکردن کاربر پشت یک فایل نیم‌نوشته بدتر است.
    console.warn(`[حافظه] ${file} خوانده نشد — با حافظه‌ی خالی ادامه می‌دهم`);
    return EMPTY();
  }
}

export async function saveMemory(url, mem) {
  await ensureDir(userDir());
  const out = { ...EMPTY(), ...mem, url, updatedAt: new Date().toISOString() };
  await writeJsonAtomic(memoryFile(url), out);
  return out;
}

/**
 * ادغام خروجی یک دور در حافظه.
 *
 * قاعده‌ها:
 *   · campaignHistory همیشه اضافه می‌شود — **حتی وقتی نتیجه نداده**. اینکه
 *     چه چیزی امتحان شد و جواب نداد، خودش دانش است و دقیقاً همان چیزی است
 *     که threadFatigue را کار می‌اندازد.
 *   · فرضیه‌ها با متن خودشان یکی می‌شوند، نه با ایندکس: شماره بین دورها
 *     جابه‌جا می‌شود و آن‌وقت درسِ یکی روی دیگری می‌نشیند.
 *   · فرضیه‌ی بازنشسته (retire) می‌ماند ولی علامت می‌خورد — پاک‌کردنش یعنی
 *     دور بعد دوباره همان را پیشنهاد می‌دهیم.
 *   · سؤال‌های پرسیده‌شده انباشته می‌شوند تا دور بعد تکرارشان نکند.
 */
export function mergeLearning(mem, { learning, campaignEntry, askedQuestions } = {}) {
  const out = { ...EMPTY(), ...mem };

  if (campaignEntry) out.campaignHistory = [...out.campaignHistory, campaignEntry];

  for (const q of askedQuestions || []) {
    const text = String(q?.question || q || '').trim();
    if (!text) continue;
    const seen = out.askedQuestions.find(a => a.question === text);
    if (seen) { seen.timesAsked = (seen.timesAsked || 1) + 1; if (q?.answer) seen.answer = q.answer; }
    else out.askedQuestions.push({ question: text, answer: q?.answer ?? null, askedAt: nowIso() });
  }

  // learnedNothing یعنی «خواندنی نبود» — تاریخچه ثبت می‌شود ولی فرضیه‌ای
  // جابه‌جا نمی‌شود. این همان چیزی است که learn() خودش هم می‌گوید.
  if (learning && !learning.learnedNothing) {
    for (const u of learning.hypothesisUpdates || []) {
      const claim = String(u?.hypothesis || '').trim();
      if (!claim) continue;
      const prev = out.hypotheses.find(h => h.claim === claim);
      if (prev) {
        prev.verdict       = u.verdict;
        prev.evidenceCount = Math.max(prev.evidenceCount || 0, u.evidenceCount || 0);
        prev.lastTestedAt  = u.lastTestedAt || nowIso();
        prev.retired       = Boolean(u.retire) || prev.retired || false;
        prev.promoted      = Boolean(u.promoteToFact) || prev.promoted || false;
      } else {
        out.hypotheses.push({
          claim, verdict: u.verdict, evidenceCount: u.evidenceCount || 0,
          lastTestedAt: u.lastTestedAt || nowIso(),
          retired: Boolean(u.retire), promoted: Boolean(u.promoteToFact)
        });
      }
    }
    for (const t of learning.tonePreferences || [])
      if (t && !out.tonePreferences.includes(t)) out.tonePreferences.push(t);
    if (learning.contentPattern && !out.contentPatterns.includes(learning.contentPattern))
      out.contentPatterns.push(learning.contentPattern);
  }

  return out;
}

/**
 * حافظه به شکلی که زنجیره می‌شناسد (`knowledge.learningMemory`).
 *
 * فرضیه‌های بازنشسته بیرون می‌مانند: در حافظه هستند تا دوباره پیشنهاد نشوند،
 * ولی به پرامپت نمی‌روند چون آنجا فقط نویز و توکن‌اند.
 */
export function toLearningMemory(mem) {
  const m = { ...EMPTY(), ...mem };
  return {
    campaignHistory: m.campaignHistory,
    hypotheses:      m.hypotheses.filter(h => !h.retired),
    retiredCount:    m.hypotheses.filter(h => h.retired).length,
    tonePreferences: m.tonePreferences,
    contentPatterns: m.contentPatterns,
    askedQuestions:  m.askedQuestions,
    needForNext:     m.needForNext
  };
}

/**
 * سؤال‌هایی که قبلاً پرسیده شده‌اند، از این دور حذف می‌شوند.
 *
 * پرامپت هم همین را می‌خواهد، ولی حذف کارِ کد است — قاعده‌ی ۲. اگر فقط به
 * پرامپت تکیه کنیم، یک بار که مدل فراموش کند، کاربر همان سه سؤال دور قبل را
 * می‌بیند و حس می‌کند هیچ‌چیز یادش نمانده.
 *
 * مقایسه روی متن یکسان‌شده است، نه عین رشته: یک نیم‌فاصله یا علامت سؤالِ
 * جابه‌جا نباید «سؤال تازه» بسازد.
 */
export function dropAskedQuestions(questions, askedQuestions = []) {
  const seen = new Set((askedQuestions || []).map(a => qKey(a.question)));
  const kept = [], dropped = [];
  for (const q of questions || []) (seen.has(qKey(q?.question)) ? dropped : kept).push(q);
  return { kept, dropped };
}

const qKey = (s) => String(s ?? '')
  .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک')
  .replace(/[\u200c\u200e\u200f]/g, ' ')
  .replace(/[«»"'’‘،,.…؟?!:;()\[\]-]/g, ' ')
  .replace(/\s+/g, ' ').trim().toLowerCase();

const nowIso = () => new Date().toISOString();
