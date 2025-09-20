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

      // Suggest file names
      const baseTitle = (entry.title || 'bilibili_video')
        .replace(/[\\/:*?"<>|]+/g, '')    // sanitize for filesystem
        .slice(0, 80);

      const videoFile = `${baseTitle}_720p.${v.ext || 'mp4'}`;
      const audioFile = `${baseTitle}_audio.${a.ext || 'm4a'}`;
      const mergedFile = `${baseTitle}_720p_merged.mp4`;

      const ffmpegCmd = [
        'ffmpeg -y',
        `-i "${v.url}"`,
        `-i "${a.url}"`,
        '-c copy',
        `"${mergedFile}"`
      ].join(' ');

      const out = {
        type: 'dash',
        video: { height: v.height, ext: v.ext, url: v.url },
        audio: { abr: a.abr || null, ext: a.ext, url: a.url },
        howToMerge: ffmpegCmd,
        note: 'Bilibili often serves separate video+audio at 720p. Download both URLs and merge with ffmpeg.'
      };
      console.log(JSON.stringify(out, null, 2));
    }
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(2);
  }
})();
