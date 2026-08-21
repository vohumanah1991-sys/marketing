import json, sys, glob, os

files = sorted(glob.glob('.vohu/**/*.json', recursive=True), key=os.path.getmtime, reverse=True)
files = [f for f in files if '/jobs/' not in f and '/memory-' not in f and '/ig-' not in f]
if not files:
    print('هیچ اجرایی پیدا نشد در .vohu/'); sys.exit()

path = sys.argv[1] if len(sys.argv) > 1 else files[0]
print(f'── فایل: {path} ──')
r = json.load(open(path, encoding='utf-8'))
S = r.get('stages', {})
def head(t): print(f'\n{"="*54}\n  {t}\n{"="*54}')
def dump(o): print(json.dumps(o, ensure_ascii=False, indent=1))

head('منابع')
p = S.get('page') or {}
for s in p.get('sources', []):
    print(f"  {'ok' if s.get('ok') else 'no'} | {s.get('label')} | {s.get('kind')} | "
          f"{s.get('chars') or ''} نویسه | {s.get('posts') or ''} محتوا | {s.get('error') or ''}")

head('جمله‌ی اول')
i = S.get('insight') or {}
c = i.get('chosen') or {}
print(' جمله:', c.get('sentence'))
print(' شاهد:', c.get('evidence'))
print(' اطمینان:', i.get('confident'))
print('\n مشاهده‌های دیگر:')
for s in (i.get('supporting') or []):
    print('  -', s if isinstance(s, str) else json.dumps(s, ensure_ascii=False))
print('\n هفت الگو:')
for k in (i.get('candidates') or []): print('  ', k.get('pattern'), k.get('strength'))

head('زبان خریدار');    dump((S.get('market') or {}).get('buyerVocabulary'))
head('سوال‌ها و حدس‌ها'); dump(S.get('questions'))
head('جواب کاربر');      dump(S.get('replies'))
head('کارت استراتژی');   dump(S.get('strategy'))
head('کمپین');           dump(S.get('campaign'))
head('شناخت محتوا');     dump(S.get('content'))
head('مصرف');            dump(r.get('usage'))
