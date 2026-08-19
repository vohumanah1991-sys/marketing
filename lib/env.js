/**
 * خواندن .env — بدون هیچ وابستگی.
 *
 * فقط همین یک بار در ابتدای هر نقطه‌ی شروع (server.js، run-vohu.js، اسکریپت‌ها)
 * import شود. متغیری که از قبل در محیط تعریف شده باشد را بازنویسی نمی‌کند،
 * پس  VOHU_DRY_RUN=1 npm start  همچنان کار می‌کند.
 *
 * چرا دستی و نه dotenv: یک وابستگی کمتر، و مهم‌تر اینکه در هر نسخه‌ی node ۲۰ به بالا
 * کار می‌کند — flag--env-file فقط از 20.6 به بعد هست.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.env.VOHU_ENV_FILE || path.join(root, '.env');

if (existsSync(file)) {
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!key || key in process.env) continue;          // محیط بر فایل مقدم است

    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export const envFile = existsSync(file) ? file : null;
