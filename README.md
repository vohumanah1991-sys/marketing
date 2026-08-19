# وُهو

سیستم تصمیم‌سازی بازاریابی. محتوا یکی از خروجی‌هایش است، نه کارش.

مستندات:
- `VOHU-SIMPLE.md` — همه‌چیز به زبان ساده
- `COVERAGE.md` — چه ساخته شده، چه نه، و هر تصمیم از کجا آمد

---

## راه‌اندازی

```bash
npm install
cp .env.example .env      # کلید و مدل را بگذار
```

## سه دستور

### ۱ · تست‌ها — همین حالا، بدون هیچ چیز

```bash
node scripts/test.js
```

۶۶ تست. نه کلید می‌خواهد نه اینترنت نه npm install.

### ۲ · برنامه، بدون خرج کردن

```bash
npm run dev          # VOHU_DRY_RUN=1 node server.js
```

مرورگر را باز کن روی `http://localhost:3000`.
مدل صدا زده نمی‌شود؛ جواب‌های آماده از `fixtures/` می‌آیند.
**کل تجربه را ببین بدون یک ریال هزینه.**

### ۳ · برنامه، واقعی

```bash
npm start
```

همان آدرس. این‌بار مدل واقعاً صدا زده می‌شود.

اگر مرورگر را ببندی، وضعیت در `.vohu/` می‌ماند — همان آدرس را دوباره بزن، ادامه می‌دهد.

### روی سرور

```bash
PORT=8080 npm start
```

پشت nginx یا هر پراکسی دیگری. هیچ دیتابیسی لازم نیست؛
وقتی خواستی، فقط `services/store.js` را با پستگرس عوض کن.

### یا از ترمینال

```bash
npm run cli -- https://یک-سایت.com "توضیح کوتاه"
```

---

## اگر فقط می‌خواهی مدل‌ها را مقایسه کنی

قدم اول را جدا اجرا کن:

```bash
node scripts/test-extraction.js https://یک-سایت.com
node scripts/verify-facts.js page.txt extraction-<تاریخ>.json
```

عددی که برمی‌گردد **نرخ تأیید غلط** است: چند درصد چیزهایی که مدل «واقعیت»
علامت زده، منبعشان واقعاً در صفحه نبود.

**این تنها عددی است که برای مقایسه‌ی مدل‌ها اهمیت دارد** —
نه اینکه کدام بیشتر پر کرده. مدلی که ۹۰٪ پر می‌کند با ۱۰٪ دروغ،
از مدلی که ۶۰٪ پر می‌کند با صفر دروغ بدتر است.

برای سنجش پایداری، همان ورودی را چند بار بزن:

```bash
node scripts/stability-check.js out1.json out2.json out3.json
```

اگر توافق زیر ۹۰٪ افتاد، با کد خطا برمی‌گردد — قابل گذاشتن در CI.

---

## قبل از انتشار هر محتوایی

```js
import { checkContent } from './lib/pipeline.js';

const { gate } = await checkContent({ content: کپشن, knowledge, market });

if (!gate.pass) {
  gate.blocked;   // ادعای بی‌پشتوانه — حذف شود
  gate.stale;     // واقعیت کهنه — دوباره بررسی شود
  gate.askUser;   // مدرک شخصی یا قول — از کاربر بپرس
}
```

آخرین ایست. در طلا، لوازم آرایشی، سلامت و مالی هرگز دور زده نشود.

---

## اتصال به اپلیکیشن

`routes/vohu.js` یک مسیر `POST /api/vohu/onboard` دارد.
**موازی** با کد فعلی است — چیزی از اپ موجود را عوض نمی‌کند.

```js
import vohuRouter from './routes/vohu.js';
app.use('/api/vohu', vohuRouter);
```

وضعیت اجرا در `.vohu/` ذخیره می‌شود. برای پستگرس فقط `services/store.js` عوض می‌شود.

---

## نقشه‌ی فایل‌ها

```
server.js                 سرور وب — ۶ مسیر API
public/index.html         رابط کاربری، تک‌فایل، فارسی و موبایل‌محور
lib/session.js            ماشین حالت — هر بار تا جایی می‌رود که به تو نیاز داشته باشد
prompts/vohuPrompts.js    ۱۱ پرامپت · ۱۱ اسکیما · ۸ تابع قطعی · ۴ دروازه
lib/pipeline.js           همان مسیر برای CLI و دروازه‌ی شواهد
services/vohuService.js   صدا زدن مدل با خروجی ساختاریافته
services/fetchPage.js     خواندن صفحه — برای اینستاگرام اینجا را با Apify عوض کن
services/store.js         ذخیره‌ی وضعیت
run-vohu.js               اجرا از ترمینال
scripts/test.js           ۶۶ تست رگرسیون
scripts/verify-facts.js   نرخ تأیید غلط
scripts/stability-check.js  توافق بین اجراها
fixtures/                 خروجی‌های واقعی، برای حالت خشک
```

---

## یک قاعده‌ی طراحی که همه‌جا تکرار شده

هشت تابع در کد نوشته شده‌اند نه در پرامپت:

```
condenseMemory · evidenceStrength · isStale · knowledgeFor
mergeAnswers · realisticCapacity · threadFatigue · upcomingOccasions
```

همه یک چیز مشترک دارند: **کاری می‌کنند که اگر به مدل سپرده شود، بالاخره یک روز اشتباه می‌شود** —
شمردن، حساب تاریخ، سنجش کفایت نمونه، تشخیص کهنگی، برش داده.

مدل برای قضاوت است. حساب و شمارش، کار کد.

---

## مسیرهای API

| مسیر | کار |
|---|---|
| `POST /api/run` | شروع یا ادامه — `{url, note, fresh}` |
| `GET  /api/run?url=` | وضعیت فعلی بدون اجرای چیزی |
| `POST /api/run/competitors` | `{url, competitors:[...]}` |
| `POST /api/run/answers` | `{url, answers, assumptions, constraints}` |
| `POST /api/run/approve` | `{url}` — بدون این، کمپین ساخته نمی‌شود |
| `POST /api/check` | `{url, content}` — دروازه‌ی شواهد قبل از انتشار |

هر پاسخ یک فیلد `needs` دارد: `competitors` · `answers` · `approval` · `null`.
رابط کاربری فقط همین را نگاه می‌کند و تصمیم می‌گیرد چه صفحه‌ای نشان بدهد.
