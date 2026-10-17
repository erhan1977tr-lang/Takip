// Telegram asistanı sırları yalnızca işçide (karar 289; güvenlik denetimi 3.93.2 Y-4): internete açık uygulama ve araç
// kapsayıcıları .env'deki değeri boş değerle ezer; işçi ezmez.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const compose = fs.readFileSync(new URL('../deploy/docker-compose.yml', import.meta.url), 'utf8');
const KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USER_ID', 'OPENAI_API_KEY'];

function service(name) {
  const start = compose.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, name);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n|\nnetworks:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

test('app ve tools asistan sırlarını boş değerle ezer', () => {
  for (const s of ['app', 'tools']) {
    const block = service(s);
    assert.match(block, /env_file: \.env/, s);
    for (const k of KEYS) assert.match(block, new RegExp(`\\n {6}${k}: ""\\n`), `${s}: ${k}`);
  }
});

test('işçi sırları .env\'den alır; cad hiçbir sırrı görmez', () => {
  const worker = service('worker');
  assert.match(worker, /env_file: \.env/);
  for (const k of KEYS) assert.doesNotMatch(worker, new RegExp(`${k}:`));
  assert.doesNotMatch(service('cad'), /env_file/);
});
