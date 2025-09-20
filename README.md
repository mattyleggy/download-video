# Bilibili Video Downloader with Auto-Merge

A Node.js script that downloads Bilibili videos and automatically merges separate video and audio streams when needed.

## Features

- Downloads Bilibili videos using yt-dlp
- Automatically detects if video has separate audio/video streams (DASH format)
- Downloads both streams and merges them using FFmpeg
- Cleans up temporary files after merging
- Falls back to manual merge command if automatic merging fails

## Prerequisites

1. **Node.js** (v14 or higher)
2. **Python** with yt-dlp installed: `pip install yt-dlp`
3. **FFmpeg** installed and in your system PATH

## Installation

1. Run the installation script:
   ```bash
   install.bat
   ```

   Or manually install dependencies:
   ```bash
   npm install
   ```

## Usage

```bash
node index.js "https://www.bilibili.tv/en/video/YOUR_VIDEO_ID"
```

## Output

### Progressive Format (Single File)
If the video is available as a single progressive file:
```json
{
  "type": "progressive",
  "height": 720,
  "ext": "mp4",
  "url": "https://...",
  "note": "Direct 720p (or lower) progressive URL. You can download this file directly."
}
```

### DASH Format (Separate Streams)
If the video has separate audio and video streams, the script will:
1. Download both streams
2. Merge them using FFmpeg
3. Clean up temporary files
4. Output the merged file

```json
{
  "type": "merged",
  "outputFile": "video_title_720p_merged.mp4",
  "video": { "height": 720, "ext": "mp4" },
  "audio": { "abr": 128, "ext": "m4a" },
  "note": "Video and audio have been successfully downloaded and merged!"
}
```

## Error Handling

If automatic merging fails, the script will:
- Clean up any partially downloaded files
- Provide a manual FFmpeg command for merging
- Show the separate video and audio URLs

## Dependencies

- `axios`: For downloading files
- `fluent-ffmpeg`: For video/audio merging
- `fs-extra`: For file system operations

## Notes

- The script prioritizes 720p or lower quality videos
- Temporary files are automatically cleaned up after successful merging
- The script includes progress indicators for downloads and merging
- File names are sanitized to be filesystem-safe

