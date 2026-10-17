import { safeFetch } from './net.js';

function parseAttrs(str) {
  const attrs = {};
  for (const m of str.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    attrs[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return attrs;
}

export function parsePlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('That is not a valid HLS playlist.');
  const resolve = (u) => new URL(u, baseUrl).href;

  const pl = {
    isMaster: false,
    variants: [],
    audio: [],
    segments: [],
    durations: [],
    map: null,
    encryption: null,
    byterange: false,
    endlist: false,
  };
  let pendingVariant = null;
  let pendingDuration = 0;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pl.isMaster = true;
      pendingVariant = parseAttrs(line.slice(18));
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttrs(line.slice(13));
      if (a.TYPE === 'AUDIO' && a.URI) pl.audio.push({ ...a, url: resolve(a.URI) });
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(line.slice(11));
      if (a.METHOD && a.METHOD !== 'NONE') pl.encryption = a.METHOD;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(line.slice(11));
      if (a.BYTERANGE) pl.byterange = true;
      if (a.URI) pl.map = resolve(a.URI);
    } else if (line.startsWith('#EXT-X-BYTERANGE')) {
      pl.byterange = true;
    } else if (line.startsWith('#EXTINF:')) {
      pendingDuration = parseFloat(line.slice(8)) || 0;
    } else if (line === '#EXT-X-ENDLIST') {
      pl.endlist = true;
    } else if (!line.startsWith('#')) {
      if (pendingVariant) {
        pl.variants.push({ ...pendingVariant, url: resolve(line) });
        pendingVariant = null;
      } else {
        pl.segments.push(resolve(line));
        pl.durations.push(pendingDuration);
        pendingDuration = 0;
      }
    }
  }
  return pl;
}

async function fetchPlaylist(url, referer) {
  const res = await safeFetch(url, { referer, timeout: 20000 });
  if (!res.ok) throw new Error(`The playlist answered with HTTP ${res.status}.`);
  const text = (await res.text()).slice(0, 3_000_000);
  return parsePlaylist(text, res.url || url);
}

// Resolves a playlist URL into one video playlist and, if the stream keeps its audio
// separate, one audio playlist. Picks the highest-bandwidth variant of a master playlist.
export async function resolveStream(url, referer) {
  let pl = await fetchPlaylist(url, referer);
  let audio = null;
  let aac = true; // assume AAC unless the master playlist says otherwise

  if (pl.isMaster) {
    if (!pl.variants.length) throw new Error('The playlist lists no video streams.');
    const best = [...pl.variants].sort((a, b) => Number(b.BANDWIDTH || 0) - Number(a.BANDWIDTH || 0))[0];
    if (best.CODECS) aac = /mp4a/i.test(best.CODECS);
    const group = best.AUDIO ? pl.audio.filter((a) => a['GROUP-ID'] === best.AUDIO) : [];
    const pick = group.find((a) => a.DEFAULT === 'YES') || group[0];
    const masterAudioUrl = pick?.url;
    pl = await fetchPlaylist(best.url, referer);
    if (masterAudioUrl && masterAudioUrl !== best.url) audio = await fetchPlaylist(masterAudioUrl, referer);
  }

  for (const p of [pl, audio].filter(Boolean)) {
    if (p.encryption) {
      throw new Error('This stream is encrypted, which this tool does not support.');
    }
    if (p.byterange) throw new Error('This stream uses byte-range segments, which are not supported.');
    if (!p.segments.length) throw new Error('The playlist has no video segments.');
  }
  return { video: pl, audio, aac };
}
