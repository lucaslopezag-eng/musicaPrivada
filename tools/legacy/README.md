# Scripts heredados (no se usan en producción)

- `compare.js`, `compare2.js`: comparaciones puntuales de listas de canciones escritas a mano.
- `fix_ai_songs.js`: migración antigua de archivos `ai_*` a `.ai_music/`. **Obsoleta**: ahora la hacen las migraciones idempotentes de `src/migrations.js`. Escribía URLs `http://localhost:3001` y rutas absolutas en la BD; no ejecutar.
- `limpiar.js`: borra de la BD y del disco las canciones con artista desconocido, **sin copia de seguridad**. Solo arranca con `CONFIRMO_BORRADO=si`. Para canciones sin archivo usa `tools/clean.js`.
- `check_db.js`, `check_db_full.js`: consultas sueltas a la BD. Sustituidas por `tools/inspect_db.js`.

Se conservan solo como referencia histórica.

> Fase 2: el servidor ya no depende de `sqlite3` (usa `better-sqlite3`), así que `fix_ai_songs.js` ni siquiera arranca sin instalar ese paquete aparte.
