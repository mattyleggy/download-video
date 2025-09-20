@echo off
echo Installing dependencies for Bilibili downloader...
echo.

echo Installing Node.js dependencies...
npm install

echo.
echo Checking if FFmpeg is installed...
ffmpeg -version >nul 2>&1
if %errorlevel% neq 0 (
    echo FFmpeg is not installed or not in PATH.
    echo Please install FFmpeg from https://ffmpeg.org/download.html
    echo Make sure to add it to your system PATH.
    echo.
) else (
    echo FFmpeg is already installed.
)

echo.
echo Checking if yt-dlp is installed...
python -m yt_dlp --version >nul 2>&1
if %errorlevel% neq 0 (
    echo yt-dlp is not installed or not in PATH.
    echo Please install yt-dlp: pip install yt-dlp
    echo.
) else (
    echo yt-dlp is already installed.
)

echo.
echo Setup complete! You can now run: node index.js "https://www.bilibili.tv/en/video/YOUR_VIDEO_ID"
pause
