/**
 * Intro skip enrichment: generates a second stream entry per episode that
 * plays the HLS stream starting after the intro (via ffmpeg -ss seek).
 *
 * Architecture:
 *   - The addon checks if intro timestamps are cached (stremio server's
 *     /intro/{hash}/{idx}/status endpoint).
 *   - If cached → adds a skip-intro stream with `url` pointing to the
 *     HLSv2 endpoint with `?start=INTRO_END`.
 *   - If not cached → fires a background detection request; the next
 *     time the episode is requested, the skip-intro stream will appear.
 *
 * The HLS URL uses the external stremio server URL (reachable by the TV)
 * with the internal mediaURL for the libtorrent HTTP server (used by ffmpeg).
 */
const STREMIO_EXTERNAL_URL = process.env.STREMIO_EXTERNAL_URL || process.env.STREMIO_SERVER_URL || 'http://127.0.0.1:8080';
const STREMIO_INTERNAL_URL = 'http://127.0.0.1:11470';

/**
 * Enrich a stream list with skip-intro variants.
 * Called after applyLiveScores and before applyStaticInfo.
 */
export async function enrichSkipIntro(streams, args) {
  if (!args || !args.id || !args.id.startsWith('tt')) return streams;

  // Deduplicate by infoHash — only one skip-intro per torrent
  const seen = new Set();
  const extraStreams = [];

  for (const stream of streams) {
    if (!stream.infoHash) continue;
    const hash = stream.infoHash.toLowerCase();
    if (seen.has(hash)) continue;
    seen.add(hash);

    const fileIdx = stream.fileIdx != null ? stream.fileIdx : 0;
    const introEnd = await checkIntro(hash, fileIdx);
    if (introEnd == null) continue;

    const skipStream = buildSkipStream(stream, hash, fileIdx, introEnd, args);
    extraStreams.push(skipStream);
  }

  // Prepend skip-intro streams so they appear first in the list
  streams.unshift(...extraStreams);
  return streams;
}

async function checkIntro(infoHash, fileIdx) {
  try {
    const statusUrl = `${STREMIO_EXTERNAL_URL}/intro/${infoHash}/${fileIdx}/status`;
    const res = await fetch(statusUrl, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.cached && data.introEnd != null && data.introEnd > 0) {
      return data.introEnd;
    }
    // Not cached — fire background detection request
    const detectUrl = `${STREMIO_EXTERNAL_URL}/intro/${infoHash}/${fileIdx}?server=${encodeURIComponent(STREMIO_INTERNAL_URL)}`;
    fetch(detectUrl, { signal: AbortSignal.timeout(5000) }).catch(() => {});
    return null;
  } catch {
    return null;
  }
}

function buildSkipStream(origStream, infoHash, fileIdx, introEnd, args) {
  const mediaURL = `${STREMIO_INTERNAL_URL}/${infoHash}/${fileIdx}`;
  const jobId = `skip_${infoHash}_${fileIdx}_${Math.round(introEnd)}`;
  const hlsUrl = `${STREMIO_EXTERNAL_URL}/hlsv2/${jobId}/master.m3u8` +
    `?mediaURL=${encodeURIComponent(mediaURL)}` +
    `&start=${introEnd}` +
    `&videoCodecs=h264`;

  // Parse quality from original stream name
  const lines = (origStream.name || '').split('\n');
  const quality = lines.slice(1).join('\n').trim() || 'Auto';

  return {
    url: hlsUrl,
    name: `Torrentio ⏭\n${quality} · Pular Intro`,
    title: `⏭ Pular introdução\n${origStream.title || ''}`,
    // Same behaviorHints as original for binge group
    behaviorHints: origStream.behaviorHints || undefined,
  };
}