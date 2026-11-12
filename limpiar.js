const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const db = new sqlite3.Database('database.sqlite');
const musicDir = path.join(__dirname, 'music');

db.all(`SELECT id, file_path FROM songs WHERE artist = 'Unknown' OR artist = 'Unknown Artist' OR artist = 'Unknown artist'`, [], (err, rows) => {
  if (err) { console.error("Error leyendo DB:", err); process.exit(1); }
  
  if (!rows || rows.length === 0) {
    console.log("No se han encontrado canciones con artista desconocido.");
    process.exit(0);
  }

  console.log(`Borrando ${rows.length} canciones...`);
  
  rows.forEach(song => {
    const fullPath = path.join(musicDir, song.file_path);
    const coverPath = fullPath.replace(/\.opus$/, '.jpg');
    
    // Borrar de la base de datos (se borrarán también de las playlists gracias a CASCADE si existiera, o manual si no)
    db.run(`DELETE FROM songs WHERE id = ?`, [song.id]);
    db.run(`DELETE FROM playlist_songs WHERE song_id = ?`, [song.id]);
    
    // Borrar físicamente el .opus y su carátula
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    if (fs.existsSync(coverPath)) fs.unlinkSync(coverPath);
    
    console.log(`Borrada: ${song.file_path}`);
  });
  
  console.log("\n¡Limpieza terminada con éxito!");
});
