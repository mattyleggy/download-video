#!/usr/bin/env node
/**
 * Usage:
 *   node index.js "https://www.bilibili.tv/en/video/4791096494916096"
 *
 * Output:
 *   - If progressive 720p exists: a single direct MP4 URL
 *   - Else: separate video/audio URLs (DASH) + a suggested ffmpeg merge command
 *
 * Requires: yt-dlp installed and in PATH
 */

const { execFile } = require('child_process');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs-extra');
const path = require('path');

if (process.argv.length < 3) {
  console.error('Usage: node index.js "<bilibili.tv URL>"');
  process.exit(1);
}

const url = process.argv[2];

function runYtDlpJSON(targetUrl) {
  return new Promise((resolve, reject) => {
    execFile(
      'python',
      // -J: JSON, --no-check-certificates helps in some environments
      ['-m', 'yt_dlp', '-J', '--no-warnings', '--no-check-certificates', targetUrl],
      { maxBuffer: 1024 * 1024 * 10 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

// Pick “best” by height<=720, then by tbr/bitrate
function pickFormats(formats) {
  const prog = formats
    .filter(f =>
      (f.vcodec && f.vcodec !== 'none') &&
      (f.acodec && f.acodec !== 'none') &&
      (typeof f.height === 'number' && f.height <= 720)
    )
    .sort((a, b) => (b.height - a.height) || ((b.tbr || 0) - (a.tbr || 0)));

  if (prog.length) {
    return { type: 'progressive', video: prog[0], audio: null };
  }

  // DASH fallback: separate video & audio
  const videos = formats
    .filter(f =>
      (f.vcodec && f.vcodec !== 'none') &&
      (!f.acodec || f.acodec === 'none') &&
      (typeof f.height === 'number' && f.height <= 720)
    )
    .sort((a, b) => (b.height - a.height) || ((b.tbr || 0) - (a.tbr || 0)));

  const audios = formats
    .filter(f => (f.acodec && f.acodec !== 'none') && (!f.vcodec || f.vcodec === 'none'))
    .sort((a, b) => ((b.abr || 0) - (a.abr || 0)) || ((b.tbr || 0) - (a.tbr || 0)));

  if (videos.length && audios.length) {
    return { type: 'dash', video: videos[0], audio: audios[0] };
  }

  return null;
}

// Download file from URL
async function downloadFile(url, filePath) {
  console.log(`Downloading: ${path.basename(filePath)}`);
  const response = await axios({
    method: 'GET',
    url: url,
    responseType: 'stream',
    timeout: 300000, // 5 minutes timeout
  });

  const writer = fs.createWriteStream(filePath);
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', () => {
      console.log(`Downloaded: ${path.basename(filePath)}`);
      resolve();
    });
    writer.on('error', reject);
  });
}

// Merge video and audio using ffmpeg
async function mergeVideoAudio(videoPath, audioPath, outputPath) {
  console.log('Merging video and audio...');
  
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions(['-c copy', '-avoid_negative_ts make_zero'])
      .output(outputPath)
      .on('start', (commandLine) => {
        console.log('FFmpeg command:', commandLine);
      })
      .on('progress', (progress) => {
        if (progress.percent) {
          console.log(`Merging progress: ${Math.round(progress.percent)}%`);
        }
      })
      .on('end', () => {
        console.log(`Merged video saved: ${path.basename(outputPath)}`);
        resolve();
      })
      .on('error', (err) => {
        console.error('FFmpeg error:', err.message);
        reject(err);
      })
      .run();
  });
}

// Clean up temporary files
async function cleanupFiles(filePaths) {
  for (const filePath of filePaths) {
    try {
      if (await fs.pathExists(filePath)) {
        await fs.remove(filePath);
        console.log(`Cleaned up: ${path.basename(filePath)}`);
      }
    } catch (err) {
      console.warn(`Could not clean up ${filePath}:`, err.message);
    }
  }
}

(async () => {
  try {
    const info = await runYtDlpJSON(url);

    // If playlist/series, yt-dlp returns entries; handle first one by default
    const entry = info.entries ? info.entries[0] : info;
    if (!entry || !entry.formats || !entry.formats.length) {
      throw new Error('No formats found.');
    }

    const chosen = pickFormats(entry.formats);
    if (!chosen) {
      throw new Error('Could not find a <=720p format.');
    }

    if (chosen.type === 'progressive') {
      const f = chosen.video;
      const out = {
        type: 'progressive',
        height: f.height,
        ext: f.ext,
        url: f.url,
        note: 'Direct 720p (or lower) progressive URL. You can download this file directly.'
      };
      console.log(JSON.stringify(out, null, 2));
    } else {
      const v = chosen.video;
      const a = chosen.audio;

      // Create file names
      const baseTitle = (entry.title || 'bilibili_video')
        .replace(/[\\/:*?"<>|]+/g, '')    // sanitize for filesystem
        .slice(0, 80);

      const videoFile = `${baseTitle}_720p.${v.ext || 'mp4'}`;
      const audioFile = `${baseTitle}_audio.${a.ext || 'm4a'}`;
      const mergedFile = `${baseTitle}_720p_merged.mp4`;

      console.log('DASH format detected - downloading and merging video and audio...');
      console.log(`Video: ${v.height}p, ${v.ext}`);
      console.log(`Audio: ${a.abr || 'unknown'}kbps, ${a.ext}`);

      const tempFiles = [videoFile, audioFile];
      
      try {
        // Download video and audio files
        await Promise.all([
          downloadFile(v.url, videoFile),
          downloadFile(a.url, audioFile)
        ]);

        // Merge the files
        await mergeVideoAudio(videoFile, audioFile, mergedFile);

        // Clean up temporary files
        await cleanupFiles(tempFiles);

        const out = {
          type: 'merged',
          outputFile: mergedFile,
          video: { height: v.height, ext: v.ext },
          audio: { abr: a.abr || null, ext: a.ext },
          note: 'Video and audio have been successfully downloaded and merged!'
        };
        console.log('\n' + JSON.stringify(out, null, 2));
        
      } catch (error) {
        console.error('Error during download/merge process:', error.message);
        
        // Clean up any partially downloaded files
        await cleanupFiles(tempFiles);
        
        // Fallback: show the manual merge command
        const ffmpegCmd = [
          'ffmpeg -y',
          `-i "${v.url}"`,
          `-i "${a.url}"`,
          '-c copy',
          `"${mergedFile}"`
        ].join(' ');

        const fallbackOut = {
          type: 'dash',
          video: { height: v.height, ext: v.ext, url: v.url },
          audio: { abr: a.abr || null, ext: a.ext, url: a.url },
          howToMerge: ffmpegCmd,
          note: 'Automatic merge failed. You can manually download and merge using the ffmpeg command above.'
        };
        console.log('\n' + JSON.stringify(fallbackOut, null, 2));
      }
    }
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(2);
  }
})();
