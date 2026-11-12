const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpeg = require('ffmpeg-static');

const musicDir = path.join(__dirname, 'music');
const pythonScript = path.join(__dirname, 'generate_subtitles.py');

function getAudioFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      getAudioFiles(filePath, fileList);
    } else if (filePath.endsWith('.opus') || filePath.endsWith('.mp3') || filePath.endsWith('.m4a')) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

const files = getAudioFiles(musicDir).sort((a, b) => {
  const aIsSkiper = a.includes(`${path.sep}skiper${path.sep}`) || a.includes('/skiper/') ? -1 : 1;
  const bIsSkiper = b.includes(`${path.sep}skiper${path.sep}`) || b.includes('/skiper/') ? -1 : 1;
  return aIsSkiper - bIsSkiper;
});

async function processFiles() {
  console.log(`Found ${files.length} audio files. Checking for missing subtitles...`);
  for (let i = 0; i < files.length; i++) {
    const audioPath = files[i];
    const baseName = path.basename(audioPath);
    const nameWithoutExt = path.parse(baseName).name;
    const dir = path.dirname(audioPath);
    const vttPath = path.join(dir, `${nameWithoutExt}.vtt`);

    if (fs.existsSync(vttPath)) {
      console.log(`[${i+1}/${files.length}] Skipping (already exists): ${baseName}`);
      continue;
    }

    console.log(`[${i+1}/${files.length}] Generating subtitles for: ${baseName}`);
    await new Promise((resolve) => {
      const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
      const child = spawn(pyCmd, [pythonScript, ffmpeg, audioPath]);
      child.stdout.on('data', d => console.log(d.toString().trim()));
      child.stderr.on('data', d => console.log(d.toString().trim())); // Whisper outputs progress to stderr
      child.on('close', code => {
        if (code !== 0) console.error(`Error generating subtitle for ${baseName}`);
        resolve();
      });
    });
  }
  console.log('Finished generating subtitles for all existing songs.');
}

processFiles();
