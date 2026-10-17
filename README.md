# Media Zipper

Paste a page address, pick the images, audio and video it loads, and download them as one .zip.
Streamed (HLS / .m3u8) videos can be saved as a single MP4.

## Deploy
Push this folder's contents to a GitHub repo, import it in Vercel (Framework Preset: Other), deploy.

## Files
- `public/index.html` the web page
- `api/scan.js` opens the page in a headless browser and lists its media and streams
- `api/zip.js` downloads the selected files into a zip
- `api/stream.js` turns an HLS stream into an MP4 (FFmpeg, no re-encoding)
- `lib/` shared helpers (address safety checks, media detection, HLS playlists)
- `desktop/hls_downloader.py` desktop app for long videos (no time limit; needs Python and FFmpeg)

## Limits
- Web MP4 downloads stop after about a minute of downloading. Use the desktop app for long videos.
- Encrypted/DRM streams, DASH (.mpd) streams and in-page players with no playlist address are not supported.
- If the bundled FFmpeg won't run on your host, set an `FFMPEG_PATH` environment variable in Vercel.
- Only download media you have the right to use.
