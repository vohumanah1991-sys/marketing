# فرستادن روی گیت‌هاب

مخزن آماده است، با سه کامیت و remote از قبل تنظیم‌شده روی مخزن `marketing`.

توجه: در محیطی که مخزن ساخته شد، آدرس SSH به‌صورت خودکار به HTTPS بازنویسی شده.
اگر SSH ترجیح می‌دهی، اول این را بزن:

```bash
git remote set-url origin git@github.com:vohumanah1991-sys/marketing.git
```

## دستور

```bash
unzip vohu-repo.zip
cd repo
git push -u origin main
```

همین. `origin` از قبل تنظیم شده.

## اگر مخزن خالی نیست

اگر موقع ساختن، README یا لایسنس اضافه کرده‌ای، اول یک بار بگیرش:

```bash
git pull --rebase origin main
git push -u origin main
```

یا اگر می‌خواهی هرچه آنجاست جایگزین شود:

```bash
git push -u --force origin main
```

## بررسی قبل از فرستادن

```bash
git log --oneline          # باید دو کامیت باشد
git ls-files | wc -l       # ۳۴ فایل
git status                 # باید تمیز باشد
```

## چه چیزی نمی‌رود

`.gitignore` این‌ها را کنار گذاشته:

```
node_modules/     .vohu/     .env     *.log     extraction-*.json
```

**فایل `.env` در مخزن نیست** — فقط `.env.example`. کلیدت هیچ‌جا نرفته.
