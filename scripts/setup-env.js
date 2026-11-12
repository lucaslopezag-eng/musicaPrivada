#!/usr/bin/env node
'use strict';
// ─── ASISTENTE DE CONFIGURACIÓN (.env) ───────────────────────────────────────
// Genera el archivo .env con contraseñas hasheadas (bcrypt) y secretos
// aleatorios. Sustituye a las credenciales que estaban escritas en el código.
//
//   npm run setup

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const bcrypt = require('bcryptjs');

const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const USERNAME_RE = /^[a-z0-9_-]{1,32}$/;

function ask(rl, question, { silent = false } = {}) {
  return new Promise((resolve) => {
    if (!silent) return rl.question(question, (a) => resolve(a.trim()));
    const output = rl.output;
    const origWrite = output.write.bind(output);
    output.write = (chunk) => (String(chunk).includes(question) ? origWrite(chunk) : origWrite(''));
    rl.question(question, (answer) => {
      output.write = origWrite;
      origWrite('\n');
      resolve(answer);
    });
  });
}

async function main() {
  if (fs.existsSync(ENV_PATH)) {
    console.error('Ya existe un .env. Bórralo o edítalo a mano (usa "npm run hash-password" para nuevas contraseñas).');
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const users = [];
  console.log('Configuración de usuarios de MusicaPrivada. Deja el nombre vacío para terminar.\n');
  for (;;) {
    const name = (await ask(rl, 'Usuario: ')).toLowerCase();
    if (!name) break;
    if (!USERNAME_RE.test(name)) { console.log('  Solo a-z, 0-9, "_" y "-" (máx. 32).'); continue; }
    const pass = await ask(rl, '  Contraseña (mín. 10 caracteres): ', { silent: true });
    if (pass.length < 10) { console.log('  Demasiado corta.'); continue; }
    const again = await ask(rl, '  Repite la contraseña: ', { silent: true });
    if (pass !== again) { console.log('  No coinciden.'); continue; }
    users.push(`${name}:${bcrypt.hashSync(pass, 12)}`);
  }
  if (users.length === 0) { console.error('Se necesita al menos un usuario.'); process.exit(1); }
  const firstUser = users[0].split(':')[0];
  const admins = (await ask(rl, `Administradores (coma) [${firstUser}]: `)) || firstUser;
  const gemini = await ask(rl, 'GEMINI_API_KEY (opcional, NUEVA clave rotada): ');
  const lastfm = await ask(rl, 'LASTFM_API_KEY (opcional, NUEVA clave rotada): ');
  rl.close();

  const template = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const values = {
    APP_USERS: users.join(','),
    ADMIN_USERS: admins,
    LEGACY_OWNER: firstUser,
    SUBTITLE_WORKER_TOKEN: crypto.randomBytes(32).toString('hex'),
    GEMINI_API_KEY: gemini,
    LASTFM_API_KEY: lastfm,
  };
  const out = template.split('\n').map((line) => {
    const m = /^([A-Z0-9_]+)=/.exec(line);
    if (m && Object.prototype.hasOwnProperty.call(values, m[1])) return `${m[1]}=${values[m[1]]}`;
    return line;
  }).join('\n');
  fs.writeFileSync(ENV_PATH, out, { mode: 0o600 });
  console.log(`\n.env creado (permisos 600). Token del worker de subtítulos:\n  ${values.SUBTITLE_WORKER_TOKEN}\n`);
}

main().catch((err) => { console.error(err); process.exit(1); });
