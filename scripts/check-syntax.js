#!/usr/bin/env node
'use strict';
// Comprueba la sintaxis de todos los .js del backend sin ejecutarlos.
//   npm run check

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['src', 'routes', 'jobs', 'scripts', 'tools', 'test', 'scraper'];
const files = ['server.js', 'ecosystem.config.js'];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) files.push(path.relative(ROOT, full));
  }
}
DIRS.forEach(d => fs.existsSync(path.join(ROOT, d)) && walk(path.join(ROOT, d)));

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' });
  } catch (err) {
    failed += 1;
    console.error(`✖ ${f}\n${String(err.stderr || err.message)}`);
  }
}
console.log(`${files.length - failed}/${files.length} archivos sin errores de sintaxis.`);
process.exit(failed ? 1 : 0);
