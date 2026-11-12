#!/usr/bin/env node
'use strict';
// Genera una entrada "usuario:hash" para APP_USERS.
//   npm run hash-password -- <usuario>
// La contraseña se lee por stdin (no queda en el historial de la shell).

const bcrypt = require('bcryptjs');

const user = (process.argv[2] || '').toLowerCase();
if (!/^[a-z0-9_-]{1,32}$/.test(user)) {
  console.error('Uso: npm run hash-password -- <usuario>   (contraseña por stdin)');
  process.exit(1);
}

let input = '';
process.stdin.setEncoding('utf8');
if (process.stdin.isTTY) process.stderr.write('Contraseña (Enter para terminar): ');
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (process.stdin.isTTY && input.includes('\n')) process.stdin.emit('end');
});
process.stdin.on('end', () => {
  const password = input.split('\n')[0];
  if (password.length < 10) {
    console.error('\nLa contraseña debe tener al menos 10 caracteres.');
    process.exit(1);
  }
  process.stdout.write(`${user}:${bcrypt.hashSync(password, 12)}\n`);
  process.exit(0);
});
