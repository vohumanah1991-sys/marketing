# استخراج اینستاگرام

## نصب ابزارهای سیستم

```bash
apt update
apt install -y ffmpeg tesseract-ocr tesseract-ocr-fas tesseract-ocr-eng
```

بدون `ffmpeg` نوشته‌های داخل ویدئو خوانده نمی‌شوند.
بدون `tesseract-ocr-fas` متن **فارسی** روی تصویر ضعیف خوانده می‌شود.
در هر دو حالت، برنامه صریح می‌گوید — بی‌سروصدا رد نمی‌شود.

بررسی:

```bash
curl http://localhost:3000/api/instagram/capabilities
```

## اجرا

```bash
# شروع استخراج — بلافاصله شناسه‌ی کار برمی‌گردد
curl -X POST http://localhost:3000/api/instagram/sync \
  -H 'content-type: application/json' \
  -d '{"target":"https://www.instagram.com/YOUR_PAGE/"}'
# → {"jobId":"jxxxx","status":"queued"}

# پیگیری
curl http://localhost:3000/api/instagram/job/jxxxx

# محتواهای ذخیره‌شده‌ی یک پیج
curl "http://localhost:3000/api/instagram/items?username=YOUR_PAGE"
```

`target` می‌تواند پیج، پست یا ریلز باشد.

پارامترهای اختیاری بدنه:

| کلید | پیش‌فرض | کار |
|---|---|---|
| `withMedia` | `true` | `false` یعنی فقط متادیتا، بدون دانلود و OCR (سریع) |
| `analyze` | `true` | `false` یعنی فقط استخراج، بدون تحلیل مدل |
| `force` | `false` | `true` یعنی از اول بخوان، حتی چیزهایی که قبلاً دیده شده |
| `posts` | `10` | چند پست. `0` یعنی اصلاً پست نخوان |
| `reels` | `10` | چند ریلز. `0` یعنی اصلاً ریلز نخوان |

بیشتر خواستن:

```bash
curl -X POST http://localhost:3000/api/instagram/sync \
  -H 'content-type: application/json' \
  -d '{"target":"https://www.instagram.com/YOUR_PAGE/","posts":30,"reels":20}'
```

سقف مطلق `IG_MAX` است (پیش‌فرض ۲۰۰). اگر تعداد برگشتی دقیقاً به سقف خورد،
در `notes` می‌گوید «احتمالاً بیشتر هم هست» — سکوت نمی‌کند.

## چه چیزی از هر محتوا درمی‌آید

```
type              reel · image · carousel
sourceUrl         لینک اصلی پست
ownerUsername     نام پیج
publishedAt       تاریخ انتشار
caption           کپشن
hashtags          هشتگ‌ها
mentions          منشن‌ها
speechText        متن کامل گفتار داخل ویدئو
speechStatus      ok · failed · not_available · not_attempted
imageText         نوشته‌های روی تصویر و زیرنویس (با OCR)
imageTextStatus   ok · failed · not_attempted
slides[]          برای اسلایدی: n · mediaType · imageText · speechText، به‌ترتیب
metrics           likes · comments · shares · views · plays · saves · reach
comments[]        متن کامنت‌ها اگر در دسترس بود
raw               داده‌ی خام Apify، دست‌نخورده
extraction        status (ok · partial · failed · metadata_only) و فهرست خطاها
```

## قاعده‌هایی که در کد سفت شده‌اند

**لینک متن نیست.** اگر `transcript` به‌جای متن یک لینک فایل صوتی برگرداند،
وضعیت `failed` می‌شود، نه اینکه لینک به‌عنوان «متن گفتار» ذخیره شود.

**متن خالی استخراج موفق نیست.** رشته‌ی خالی هیچ‌وقت `ok` نمی‌گیرد.

**عدد ساخته نمی‌شود.** `saves` و `reach` در داده‌ی عمومی اینستاگرام وجود ندارند،
پس همیشه `null` می‌مانند. `shares` فقط اگر اکتور داد. نبودِ عدد `null` است، نه صفر.

**نخوانده ≠ نبوده.** اگر OCR شکست خورد، به مدل گفته می‌شود «خوانده نشد»،
نه اینکه «متنی روی تصویر نبود».

**توکن جایی نمی‌رود.** `APIFY_TOKEN` فقط در متغیر محیطی سرور است، فقط در هدر
`Authorization` می‌رود (نه در query string که لاگ می‌شود)، و هر متنی که لاگ یا
برگردانده می‌شود از `redact()` رد می‌شود.

## ترتیب اجباری

استخراج (Apify → transcript → فریم‌گیری → OCR) **قبل** از تحلیل.
مدل هیچ‌وقت مستقیم با اینستاگرام حرف نمی‌زند و چیزی را که استخراج نشده حدس نمی‌زند.

## همگام‌سازی

هر بار ۱۰ پست و ۱۰ ریلز (قابل تغییر). بار اول همه‌شان، بارهای بعد فقط
جدیدتر از آخرین همگام‌سازی.
وضعیت در `.vohu/ig-<username>.json`.

## محدودیت‌های صریح

- اگر سرور وسط یک کار ری‌استارت شود، آن کار `interrupted` علامت می‌خورد — نه `done`.
- صف در حافظه است و یک کار در لحظه اجرا می‌شود. برای چند کاربر هم‌زمان باید صف واقعی بیاید.
- ریلز از اکتور `instagram-reel-scraper` می‌آید که با **نام کاربری** کار می‌کند، نه `directUrls`.
  سه گزینه‌ی `includeTranscript` و `includeDownloadedVideo` و `includeSharesCount` افزونه‌ی پولی‌اند.

## مدل تحلیل

تحلیل با همان `VOHU_MODEL` انجام می‌شود — همان زنجیره‌ی وُهو، همان قواعد
(واقعیت/فرضیه، دروازه‌ی شواهد، «آزمایش بی‌اعتبار شمرده نمی‌شود»).
هیچ ارائه‌دهنده‌ی دیگری در این مسیر نیست.
