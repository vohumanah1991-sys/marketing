/**
 * وقتی اسکریپت تست جواب داد، این را به اپ وصل کن.
 * فایل aiService.js فعلی را دست نزن — این مسیر موازی است تا چیزی نشکند.
 *
 * در server.js:
 *   import vohuRouter from './routes/vohu.js';
 *   app.use('/api/vohu', vohuRouter);
 */

import express from 'express';
import { fetchPageText } from '../services/fetchPage.js';
import { callWithSchema } from '../services/vohuService.js';
import {
  EXTRACTION_PROMPT, EXTRACTION_SCHEMA,
  FIRST_INSIGHT_PROMPT, FIRST_INSIGHT_SCHEMA,
  GATES, MISSION
} from '../prompts/vohuPrompts.js';

const router = express.Router();

// POST /api/vohu/onboard   { url, note }
router.post('/onboard', async (req, res) => {
  const { url, note } = req.body;
  if (!url) return res.status(400).json({ error: 'url لازم است' });

  try {
    const page = await fetchPageText(url);
    if (!page.ok) {
      return res.status(422).json({ error: 'صفحه خوانده نشد', detail: page.error });
    }

    // قدم ۱ — شناخت
    const { data: knowledge } = await callWithSchema({
      prompt: EXTRACTION_PROMPT({ pageContent: page.text, userNote: note }),
      schema: EXTRACTION_SCHEMA,
      toolName: 'business_knowledge'
    });

    // TODO قدم ۲ و ۳ — رقبا و محتوای قبلی. فعلاً رد می‌شویم.
    // بدون آنها سه الگو از شش الگوی جمله‌ی اول خاموش می‌مانند — طبق طراحی.
    const { data: insight } = await callWithSchema({
      prompt: FIRST_INSIGHT_PROMPT({ knowledge, competitorMap: null, contentAnalysis: null }),
      schema: FIRST_INSIGHT_SCHEMA,
      toolName: 'first_insight'
    });

    // دروازه ۳ — در کد، نه در پرامپت
    const gate = GATES.canShowInsight(insight);

    // TODO: knowledge را در دیتابیس ذخیره کن (حافظه‌ی کسب‌وکار)
    // جدول پیشنهادی: business_knowledge(user_id, data jsonb, updated_at)

    if (!gate.pass) {
      return res.json({
        mission: MISSION,
        type: 'need_more',
        message: gate.reason || 'هنوز به اندازه‌ی کافی نمی‌شناسمت',
        knowledge
      });
    }

    return res.json({
      mission: MISSION,
      type: 'insight',
      sentence:   insight.chosen?.sentence,
      evidence:   insight.chosen?.evidence,   // پشت دکمه‌ی «از کجا فهمیدی؟»
      supporting: insight.supporting || [],   // دو یافته‌ی کوچک‌تر زیرش
      scope:      insight.scope,              // «۴۲ پست و ۵ رقیب را خواندم»
      knowledge                               // نقشه — فقط اگر کاربر خواست نشان بده
    });

  } catch (e) {
    console.error('[vohu/onboard]', e);
    return res.status(500).json({ error: e.message });
  }
});

export default router;
