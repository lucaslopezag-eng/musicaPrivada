
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const db = new sqlite3.Database(path.join(__dirname, 'database.sqlite'));

db.serialize(() => {
  db.get("SELECT COUNT(*) as c FROM play_history", (err, row) => console.log("Total plays:", row.c));
  db.get("SELECT COUNT(*) as c FROM play_history WHERE listen_duration_ms > 10000", (err, row) => console.log("Plays > 10000ms:", row.c));
  db.get("SELECT COUNT(*) as c FROM play_history WHERE listen_duration_ms IS NULL OR listen_duration_ms = 0", (err, row) => console.log("Plays 0/NULL ms:", row.c));
  db.all("SELECT id, song_id, listen_duration_ms, played_at FROM play_history LIMIT 5", (err, rows) => console.log("Sample:", rows));
});
