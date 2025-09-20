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

// Download file using yt-dlp (more reliable for Bilibili)
async function downloadFileWithYtDlp(url, filePath) {
  return new Promise((resolve, reject) => {
    console.log(`Downloading with yt-dlp: ${path.basename(filePath)}`);
    console.log(`URL: ${url}`);
    
    execFile(
      'python',
      [
        '-m', 'yt_dlp',
        '--no-warnings',
        '--no-check-certificates',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '--referer', 'https://www.bilibili.tv/',
        '--output', filePath,
        url
      ],
      { maxBuffer: 1024 * 1024 * 10 },
      (err, stdout, stderr) => {
        if (err) {
          console.error(`yt-dlp download error for ${path.basename(filePath)}:`, err.message);
          console.error('stderr:', stderr);
          return reject(new Error(`yt-dlp download failed: ${err.message}`));
        }
        console.log(`Downloaded with yt-dlp: ${path.basename(filePath)}`);
        resolve();
      }
    );
  });
}

// Download file from URL with retry logic and proper headers
async function downloadFile(url, filePath, retries = 3) {
  console.log(`Downloading: ${path.basename(filePath)}`);
  console.log(`URL: ${url}`);
  
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': 'https://www.bilibili.tv/',
    'Origin': 'https://www.bilibili.tv',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache'
  };

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`Attempt ${attempt}/${retries} for ${path.basename(filePath)}`);
      
      const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'stream',
        timeout: 300000, // 5 minutes timeout
        headers: headers,
        maxRedirects: 5,
        validateStatus: function (status) {
          return status >= 200 && status < 300; // Only resolve for 2xx status codes
        }
      });

      const writer = fs.createWriteStream(filePath);
      response.data.pipe(writer);

      return new Promise((resolve, reject) => {
        writer.on('finish', () => {
          console.log(`Downloaded: ${path.basename(filePath)}`);
          resolve();
        });
        writer.on('error', (err) => {
          console.error(`Write error for ${path.basename(filePath)}:`, err.message);
          reject(err);
        });
        
        response.data.on('error', (err) => {
          console.error(`Stream error for ${path.basename(filePath)}:`, err.message);
          reject(err);
        });
      });
    } catch (error) {
      console.error(`Download error for ${path.basename(filePath)} (attempt ${attempt}):`, error.message);
      
      if (error.response) {
        console.error(`HTTP Status: ${error.response.status}`);
        if (error.response.status === 403) {
          console.error('403 Forbidden - This might be due to missing authentication or blocked access');
        }
        if (error.response.data) {
          console.error(`Response data:`, error.response.data);
        }
      }
      
      if (attempt === retries) {
        throw error;
      } else {
        console.log(`Retrying in ${attempt * 2} seconds...`);
        await new Promise(resolve => setTimeout(resolve, attempt * 2000));
      }
    }
  }
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
        // Download video and audio files with individual error handling
        console.log('Starting downloads...');
        
        const downloadPromises = [];
        
        // Download video (try axios first)
        console.log('Downloading video...');
        downloadPromises.push(
          downloadFile(v.url, videoFile).catch(err => {
            console.error('Video download with axios failed, trying yt-dlp...');
            return downloadFileWithYtDlp(v.url, videoFile).catch(ytdlpErr => {
              console.error('Video download failed with both methods:', ytdlpErr.message);
              throw new Error(`Video download failed: ${err.message}`);
            });
          })
        );
        
        // Download audio (try yt-dlp first as it handles 403 better)
        console.log('Downloading audio...');
        downloadPromises.push(
          downloadFileWithYtDlp(a.url, audioFile).catch(err => {
            console.error('Audio download with yt-dlp failed, trying axios...');
            return downloadFile(a.url, audioFile).catch(axiosErr => {
              console.error('Audio download failed with both methods:', axiosErr.message);
              throw new Error(`Audio download failed: ${err.message}`);
            });
          })
        );
        
        await Promise.all(downloadPromises);
        console.log('Both video and audio downloaded successfully!');

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
