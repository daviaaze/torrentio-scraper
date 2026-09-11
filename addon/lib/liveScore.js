import crypto from 'node:crypto';

const PROBER_URL = process.env.PROBER_URL || 'http://127.0.0.1:8460';
const STREMIO_SERVER_URL = process.env.STREMIO_SERVER_URL;
const RACE_MAX = 8;
const RACE_MIN = 2;

/**
 * Live scoring via the elimination-race prober (native NixOS service on
 * 127.0.0.1:8460). Attaches state to the streams array (`streams._live`)
 * which enrichCacheParams reads to decide cacheMaxAge:
 *   pending   -> 60s  (race running, Stremio refetches soon)
 *   ranEmpty  -> 300s (race finished, no live candidate — retry later)
 *   fresh     -> normal TTL (scored ranking)
 */
export async function applyLiveScores(streams, args) {
  const live = { pending: false, fresh: false, ranEmpty: false };
  // attach per-stream (stream objects survive .map() in applyStaticInfo,
  // the array does not) — enrichCacheParams reads it back and deletes it
  for (const s of streams) s._live = live;

  const candidates = [];
  const seen = new Set();
  for (const s of streams) {
    if (!s.infoHash) continue;
    const hash = s.infoHash.toLowerCase();
    if (seen.has(hash)) continue;
    seen.add(hash);
    candidates.push({
      infoHash: s.infoHash,
      title: (s.title || '').split('\n')[0] || undefined,
      trackers: (s.sources || [])
          .filter(source => source.startsWith('tracker:'))
          .map(source => source.slice('tracker:'.length)),
      fileIdx: s.fileIdx != null ? s.fileIdx : 0,
    });
    if (candidates.length >= RACE_MAX) break;
  }
  if (candidates.length < RACE_MIN) {
    for (const s of streams) delete s._live;
    return streams;
  }

  const key = raceKey(candidates);
  try {
    const status = await fetch(`${PROBER_URL}/status/${key}`, { signal: AbortSignal.timeout(3000) })
        .then(response => response.json())
        .catch(() => null);
    if (!status) {
      // prober unreachable — behave exactly as before
      for (const s of streams) delete s._live;
      return streams;
    }
    if (status.fresh && status.scores?.length) {
      live.fresh = true;
      applyScores(streams, status.scores);
    } else if (status.ranEmpty) {
      live.ranEmpty = true;
    } else if (!status.running) {
      fetch(`${PROBER_URL}/race/${key}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ candidates, stremioUrl: STREMIO_SERVER_URL }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
      live.pending = true;
    } else {
      live.pending = true;
    }
  } catch (e) {
    // ignore
  }
  return streams;
}

function raceKey(candidates) {
  const hashes = candidates.map(c => c.infoHash.toLowerCase()).sort().join(',');
  return crypto.createHash('sha1').update(hashes).digest('hex').slice(0, 16);
}

function applyScores(streams, scores) {
  const byHash = new Map(scores.map(s => [s.infoHash.toLowerCase(), s]));

  for (const stream of streams) {
    const sc = byHash.get(stream.infoHash?.toLowerCase());
    if (!sc) continue;
    const lines = (stream.name || '').split('\n');
    const quality = lines.slice(1).join('\n') || 'Unknown';
    if (sc.score === 1) {
      const speed = sc.speed ? `${sc.speed} MB/s` : 'aquecendo';
      stream.name = `Torrentio 🏆\n${quality} · ${speed}`;
    } else if (sc.score === 2) {
      stream.name = `Torrentio ⚡\n${quality}`;
    }
    if (sc.peers != null && sc.peers > 0) {
      stream.title = `${stream.title || ''}\n👥 ${sc.peers} peers ao vivo`;
    }
  }

  const originalIndex = new Map(streams.map((s, i) => [s, i]));
  const rank = s => byHash.get(s.infoHash?.toLowerCase())?.score ?? scores.length + 1;
  streams.sort((a, b) => rank(a) - rank(b) || originalIndex.get(a) - originalIndex.get(b));
}
