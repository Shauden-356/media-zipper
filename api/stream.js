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

async function feedDirect(url, sink, ctx, referer) {
  try {
    const response = await safeFetch(url, { referer, timeout: TIME_BUDGET_MS });
    if (!response.ok) throw new Error(`The video answered with HTTP ${response.status}.`);
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_BYTES) throw new Error('The video is larger than the download limit.');
    if (!response.body) throw new Error('The video response had no data.');

    for await (const chunk of response.body) {
      if (ctx.stopped) break;
      if (Date.now() > ctx.deadline || ctx.bytes + chunk.length > MAX_BYTES) {
        ctx.truncated = true;
        break;
      }
      ctx.bytes += chunk.length;
      if (!sink.write(chunk)) {
        try {
          await Promise.race([once(sink, 'drain'), once(sink, 'close')]);
        } catch {
          ctx.stopped = true;
        }
      }
    }
  } catch (err) {
    ctx.error = err?.name === 'TimeoutError' ? 'The video took too long to download.' : err.message;
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

  const direct = req.query.direct === '1';
  let stream;
  if (!direct) {
    try {
      stream = await resolveStream(url, referer);
    } catch (err) {
      const msg = err?.name === 'TimeoutError' ? 'The stream took too long to respond.' : err.message;
      return res.status(422).json({ error: msg });
    }
  }

  if (check && !direct) {
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

  // Remux without re-encoding. Matroska accepts a wider range of direct-file codecs;
  // HLS continues to use fragmented MP4 for browser-friendly downloads.
  const args = direct
    ? [
        '-hide_banner', '-loglevel', 'error',
        '-i', 'pipe:0',
        '-map', '0:v:0?', '-map', '0:a:0?',
        '-sn', '-dn', '-c', 'copy',
        '-f', 'matroska', 'pipe:1',
      ]
    : [
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
    stdio: ['pipe', 'pipe', 'pipe', ...(!direct && stream.audio ? ['pipe'] : [])],
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
    const extension = direct ? 'mkv' : 'mp4';
    res.setHeader('Content-Type', direct ? 'video/x-matroska' : 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.${extension}"`);
    res.write(first);
    ff.stdout.pipe(res);
  });

  const feeds = direct
    ? [feedDirect(url, ff.stdin, ctx, referer)]
    : [feed(stream.video, ff.stdin, ctx, referer)];
  if (!direct && stream.audio) feeds.push(feed(stream.audio, ff.stdio[3], ctx, referer));
  await Promise.all(feeds);
  await closed;

  if (!sentData && !res.headersSent) {
    return res.status(502).json({
      error: `${direct ? 'FFmpeg could not convert this video.' : 'FFmpeg could not convert this stream.'} ${ctx.error || errText.trim()}`.trim(),
    });
  }
}
