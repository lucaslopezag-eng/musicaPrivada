#!/usr/bin/env node
'use strict';
// Muestra tablas, columnas y algunas filas de ejemplo (solo lectura).
//   node tools/inspect_db.js

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const path = require('path');
const { openDatabase } = require('../src/db');

(async () => {
  const db = await openDatabase(path.resolve(__dirname, '..', process.env.DB_PATH || 'database.sqlite'), { readonly: true });
  try {
    const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    for (const { name } of tables) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
      console.log(`\n=== ${name} ===`);
      for (const c of await db.all(`PRAGMA table_info(${name})`)) {
        console.log(`  ${c.cid}. ${c.name} [${c.type}]${c.notnull ? ' NOT NULL' : ''}${c.dflt_value !== null ? ` DEFAULT ${c.dflt_value}` : ''}${c.pk ? ' PK' : ''}`);
      }
      if (name === 'sessions') continue; // no mostrar hashes de sesión
      const sample = name === 'users'
        ? await db.all('SELECT username, role, created_at, password_updated_at FROM users LIMIT 3') // sin hashes
        : await db.all(`SELECT * FROM ${name} LIMIT 3`);
      console.log(JSON.stringify(sample, null, 2));
    }
  } finally {
    await db.close();
  }
})().catch((err) => { console.error(err); process.exit(1); });
