import { spawn } from 'node:child_process';
import { once } from 'node:events';
import ffmpegPath from 'ffmpeg-static';
import { assertPublicUrl, safeFetch } from '../lib/net.js';
import { resolveStream } from '../lib/hls.js';

const TIME_BUDGET_MS = 52_000; // Vercel stops the function at 60 s
const MAX_BYTES = 400 * 1024 * 1024;
const MAX_SEGMENT = 60 * 1024 * 1024;
const WINDOW = 4; // segments downloaded ahead, in parallel

// Downloads segments in order (a few at a time) and writes them into `sink`
// (FFmpeg's stdin). Every request goes through safeFetch, so playlists can't
// point FFmpeg at internal addresses or local files.
async function feed(playlist, sink, ctx, referer) {
  const urls = [playlist.map, ...playlist.segments].filter(Boolean);

  const get = async (u) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await safeFetch(u, { referer, timeout: 20000 });
        if (!r.ok) {
          r.body?.cancel();
          continue;
        }
        if (Number(r.headers.get('content-length') || 0) > MAX_SEGMENT) {
          r.body?.cancel();
          return null;
        }
        const buf = Buffer.from(await r.arrayBuffer());
        return buf.length > MAX_SEGMENT ? null : buf;
      } catch {
        /* retry */
      }
    }
    return null; // never rejects
  };

  const pending = new Array(urls.length);
  const kick = (i) => {
    if (i < urls.length && !pending[i]) pending[i] = get(urls[i]);
  };
  for (let i = 0; i < Math.min(WINDOW, urls.length); i++) kick(i);
  sink.on('error', () => {
    ctx.stopped = true;
  });

  try {
    for (let i = 0; i < urls.length; i++) {
      if (ctx.stopped) break;
      if (Date.now() > ctx.deadline || ctx.bytes > MAX_BYTES) {
        ctx.truncated = true;
        break;
      }
      const buf = await pending[i];
      pending[i] = null;
      kick(i + WINDOW);
      if (!buf) {
        ctx.skipped++;
        continue;
      }
      ctx.bytes += buf.length;
      if (!sink.write(buf)) {
        try {
          await Promise.race([once(sink, 'drain'), once(sink, 'close')]);
        } catch {
          ctx.stopped = true;
        }
      }
    }
  } finally {
    sink.end();
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET.' });

  const { url, page, name, check } = req.query;
  if (typeof url !== 'string' || !url) return res.status(400).json({ error: 'Missing stream address.' });
  try {
    await assertPublicUrl(url);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const referer = typeof page === 'string' && /^https?:\/\//i.test(page) ? page : undefined;

  let stream;
  try {
    stream = await resolveStream(url, referer);
  } catch (err) {
    const msg = err?.name === 'TimeoutError' ? 'The stream took too long to respond.' : err.message;
    return res.status(422).json({ error: msg });
  }

  if (check) {
    return res.status(200).json({
      ok: true,
      segments: stream.video.segments.length,
      seconds: Math.round(stream.video.durations.reduce((a, b) => a + b, 0)),
      live: !stream.video.endlist,
    });
  }

  const filename = (typeof name === 'string' && name.trim() ? name : 'video')
    .replace(/[^\w\- ]+/g, '_')
    .slice(0, 80);

  // Segments are remuxed (copied, not re-encoded) into a fragmented MP4 that can be
  // written to a pipe, the same "-c copy" approach as the desktop tool.
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    ...(stream.audio ? ['-i', 'pipe:3'] : []),
    '-map', '0:v:0?',
    '-map', stream.audio ? '1:a:0?' : '0:a:0?',
    '-sn', '-dn',
    '-c', 'copy',
    // AAC from MPEG-TS needs this fix when piped; other audio codecs must not get it.
    ...(stream.aac ? ['-bsf:a', 'aac_adtstoasc'] : []),
    '-movflags', 'frag_keyframe+empty_moov+delay_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1',
  ];
  const ff = spawn(process.env.FFMPEG_PATH || ffmpegPath, args, {
    stdio: ['pipe', 'pipe', 'pipe', ...(stream.audio ? ['pipe'] : [])],
  });

  const ctx = { stopped: false, truncated: false, skipped: 0, bytes: 0, deadline: Date.now() + TIME_BUDGET_MS };
  let errText = '';
  let sentData = false;
  const closed = new Promise((resolve) => ff.on('close', resolve));
  ff.on('error', (e) => {
    errText = e.message;
  });
  ff.stderr.on('data', (d) => {
    errText = (errText + d.toString()).slice(-600);
  });
  res.on('close', () => {
    ctx.stopped = true;
    ff.kill('SIGKILL');
  });

  // Don't commit to a download until FFmpeg produces its first output.
  ff.stdout.once('data', (first) => {
    sentData = true;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.mp4"`);
    res.write(first);
    ff.stdout.pipe(res);
  });

  const feeds = [feed(stream.video, ff.stdin, ctx, referer)];
  if (stream.audio) feeds.push(feed(stream.audio, ff.stdio[3], ctx, referer));
  await Promise.all(feeds);
  await closed;

  if (!sentData && !res.headersSent) {
    return res.status(502).json({
      error: `FFmpeg could not convert this stream. ${errText.trim()}`.trim(),
    });
  }
}
