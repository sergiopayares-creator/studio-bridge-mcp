import { getMediaInfo, extractAudio, losslessCut, detectSilences, FFMPEG_BIN } from '../lib/ffmpeg.js';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function test() {
  const sampleVideo = path.join(__dirname, 'sample_test.mp4');
  const sampleAudio = path.join(__dirname, 'sample_audio.wav');
  const sampleCut = path.join(__dirname, 'sample_cut.mp4');

  console.log('Using ffmpeg binary:', FFMPEG_BIN);
  console.log('Generating test 3s video with ffmpeg...');
  execFileSync(FFMPEG_BIN, [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=3:size=640x360:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=3',
    '-c:v', 'libx264',
    '-c:a', 'aac',
    sampleVideo
  ], { stdio: 'ignore' });

  console.log('Testing getMediaInfo...');
  const info = await getMediaInfo(sampleVideo);
  console.log('Media info:', info.file, 'duration:', info.durationSeconds, 's');

  console.log('Testing extractAudio...');
  await extractAudio(sampleVideo, sampleAudio);
  console.log('Audio extracted. File exists:', fs.existsSync(sampleAudio));

  console.log('Testing losslessCut...');
  await losslessCut(sampleVideo, sampleCut, '0', '1.5');
  console.log('Cut done. File exists:', fs.existsSync(sampleCut));

  console.log('Testing detectSilences...');
  const silenceResult = await detectSilences(sampleVideo, -50, 0.5);
  console.log('Silence detection ran successfully. Total silences:', silenceResult.totalSilencesFound);

  // Clean test files
  [sampleVideo, sampleAudio, sampleCut].forEach(f => {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  });

  console.log('✔ All FFmpeg operations verified successfully!');
}

test().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
