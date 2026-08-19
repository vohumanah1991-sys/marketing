# فرستادن روی گیت‌هاب

مخزن آماده است — با یک کامیت. فقط باید مقصدش را بگویی.

## اگر مخزن تازه می‌خواهی

روی گیت‌هاب یک مخزن **خالی** بساز (بدون README، بدون .gitignore، بدون لایسنس)
— مثلاً به اسم `vohu` — بعد:

```bash
unzip vohu-repo.zip && cd repo

git remote add origin https://github.com/vohumanah1991-sys/vohu.git
git push -u origin main
```

## اگر می‌خواهی کنار Spark-saas بماند

می‌توانی به‌عنوان یک شاخه‌ی جدا بفرستی تا کد قدیمی دست‌نخورده بماند:

```bash
unzip vohu-repo.zip && cd repo

git remote add origin https://github.com/vohumanah1991-sys/Spark-saas.git
git push -u origin main:vohu-architecture
```

بعد در گیت‌هاب شاخه‌ی `vohu-architecture` را می‌بینی، بدون اینکه `main` عوض شود.

## نکته

`.gitignore` این‌ها را کنار گذاشته: `node_modules/` · `.vohu/` · `.env` · خروجی‌های موقت استخراج.

فایل `.env` در مخزن نیست — فقط `.env.example`. کلیدت هیچ‌جا نرفته.
