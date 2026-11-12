
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const db = new sqlite3.Database(path.join(__dirname, 'database.sqlite'));

db.serialize(() => {
  // Check songs table columns
  db.all("PRAGMA table_info(songs)", (err, cols) => {
    console.log("=== SONGS TABLE COLUMNS ===");
    cols.forEach(c => console.log(`  ${c.name} (${c.type})`));
  });
  
  // Check play_history table columns
  db.all("PRAGMA table_info(play_history)", (err, cols) => {
    console.log("\n=== PLAY_HISTORY TABLE COLUMNS ===");
    cols.forEach(c => console.log(`  ${c.name} (${c.type})`));
  });

  // Check total number of distinct songs
  db.get("SELECT COUNT(DISTINCT id) as total FROM songs", (err, row) => {
    console.log("\nTotal distinct songs:", row.total);
  });
  
  // Check how many songs have genre set
  db.get("SELECT COUNT(*) as c FROM songs WHERE genre IS NOT NULL AND genre != '' AND genre != 'Unknown'", (err, row) => {
    console.log("Songs with genre:", row.c);
  });
  
  // Check how many songs have discovered_via set  
  db.get("SELECT COUNT(*) as c FROM songs WHERE discovered_via IS NOT NULL AND discovered_via != ''", (err, row) => {
    console.log("Songs with discovered_via:", row.c);
  });
  
  // Count distinct users
  db.all("SELECT DISTINCT username FROM play_history WHERE username IS NOT NULL", (err, rows) => {
    console.log("\nUsers in play_history:", rows?.map(r => r.username));
  });

  // Sample a song row to see all available data
  db.get("SELECT * FROM songs LIMIT 1", (err, row) => {
    console.log("\nSample song row:", JSON.stringify(row, null, 2));
  });
  
  // Check year range of plays
  db.all("SELECT strftime('%Y-%m', played_at) as ym, COUNT(*) as cnt FROM play_history GROUP BY ym ORDER BY ym", (err, rows) => {
    console.log("\n=== PLAYS BY MONTH ===");
    rows?.forEach(r => console.log(`  ${r.ym}: ${r.cnt} plays`));
  });
});
