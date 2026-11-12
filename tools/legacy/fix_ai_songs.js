const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const musicDir = path.join(__dirname, 'music');
const aiMusicDir = path.join(__dirname, '.ai_music');
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

if (!fs.existsSync(aiMusicDir)) {
  fs.mkdirSync(aiMusicDir, { recursive: true });
}

const files = fs.readdirSync(musicDir);
const aiFiles = files.filter(f => f.startsWith('ai_'));

let movedCount = 0;

db.serialize(() => {
  aiFiles.forEach(f => {
    const oldPath = path.join(musicDir, f);
    const newPath = path.join(aiMusicDir, f);
    
    try {
      fs.renameSync(oldPath, newPath);
      movedCount++;
      
      if (f.endsWith('.opus')) {
        const coverUrl = `http://localhost:3001/api/cover/ai/${encodeURIComponent(f + '.jpg')}`;
        db.run(`UPDATE ai_recommendations SET file_path = ?, cover_url = ? WHERE file_path = ?`, [newPath, coverUrl, oldPath]);
      }
    } catch (e) {
      console.error(`Error moving ${f}:`, e.message);
    }
  });

  db.run(`DELETE FROM songs WHERE file_path LIKE '%\\music\\ai_%' OR file_path LIKE '%/music/ai_%'`, function(err) {
    if (err) console.error(err);
    console.log(`Deleted ${this?.changes || 0} orphaned AI tracks from the songs table.`);
    console.log(`Successfully moved ${movedCount} AI files to .ai_music.`);
    db.close();
  });
});
