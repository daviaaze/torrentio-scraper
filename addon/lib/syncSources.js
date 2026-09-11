// Multi-source search for series/movie content.
// Searches all known sources in parallel, merges and dedupes by infohash.

const CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta';

// Get the title for an IMDb ID from Cinemeta
export async function getCinemetaTitle(imdbId) {
  try {
    const response = await fetch(`${CINEMETA_URL}/series/${imdbId}.json`);
    if (!response.ok) return null;
    const data = await response.json();
    return data.meta?.name || null;
  } catch (e) {
    return null;
  }
}

// Search torrent-indexer by text query
// Optimization: query only the top 3 fastest indexers (bludv, comando_torrents, filme_torrent)
// that return the most results — the other 4 are mirrors with heavy overlap
export async function searchTorrentIndexerByText(query, limit = 20) {
  const TORRENT_INDEXER_URL = process.env.TORRENT_INDEXER_URL || 'http://127.0.0.1:7006';
  const INDEXERS = ['bludv', 'comando_torrents', 'filme_torrent'];
  const TIMEOUT_MS = 20000;

  const queries = INDEXERS.map(async (indexer) => {
    try {
      const url = `${TORRENT_INDEXER_URL}/indexers/${indexer}?q=${encodeURIComponent(query)}&limit=${limit}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!response.ok) return [];
      const data = await response.json();
      return (data.results || []).map(d => ({ ...d, source: indexer }));
    } catch (e) {
      return [];
    }
  });

  try {
    const arrays = await Promise.all(queries);
    return arrays.flat();
  } catch (e) {
    return [];
  }
}

// Search torrent-indexer by IMDb ID (original behavior)
export async function searchTorrentIndexerByImdb(imdbId, limit = 20) {
  return searchTorrentIndexerByText(imdbId, limit);
}

// Search Prowlarr Torznab
// Search Prowlarr Torznab — dual query: per-episode AND per-season to catch packs
export async function searchProwlarr(title, season, episode) {
  const PROWLARR_URL = process.env.PROWLARR_URL;
  const PROWLARR_API_KEY = process.env.PROWLARR_API_KEY;
  if (!PROWLARR_URL || !PROWLARR_API_KEY) return [];

  const TIMEOUT_MS = 15000;
  try {
    // Build queries: per-episode and per-season (pack) in parallel
    const queries = [];
    if (season && episode) {
      queries.push(`${title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`);
      queries.push(`${title} S${String(season).padStart(2, '0')}`);
    } else if (season) {
      queries.push(`${title} S${String(season).padStart(2, '0')}`);
    } else {
      queries.push(title);
    }

    // Fetch all queries in parallel
    const fetches = queries.map(async (query) => {
      const url = `${PROWLARR_URL}/api/v1/search?query=${encodeURIComponent(query)}&apikey=${PROWLARR_API_KEY}&type=tvsearch`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!response.ok) return [];
        return response.json();
      } catch (e) {
        clearTimeout(timeoutId);
        return [];
      }
    });

    const results = await Promise.all(fetches);
    // Merge all query results, dedupe by infoHash
    const seen = new Set();
    const merged = [];
    for (const data of results) {
      for (const d of (data || [])) {
        const hash = (d.infoHash || '').toLowerCase() || (d.guid || '').match(/btih:([a-fA-F0-9]{40})/i)?.[1] || (d.downloadUrl || '').match(/btih:([a-fA-F0-9]{40})/i)?.[1] || '';
        if (!hash || seen.has(hash)) continue;
        seen.add(hash);
        merged.push(d);
      }
    }

    // Filter results by requested season (basic Sxx check)
    const targetSeason = season ? Number(season) : null;
    return merged.filter(d => {
      if (targetSeason != null) {
        const title_lower = (d.title || '').toLowerCase();
        const sMatch = title_lower.match(/s(\d{1,2})/);
        if (sMatch) {
          const resultSeason = parseInt(sMatch[1]);
          return resultSeason === targetSeason || !title_lower.match(/s\d{1,2}/);
        }
      }
      return true;
    }).map(d => ({
      info_hash: (d.infoHash || '').toLowerCase() || (d.guid || '').match(/btih:([a-fA-F0-9]{40})/i)?.[1] || (d.downloadUrl || '').match(/btih:([a-fA-F0-9]{40})/i)?.[1] || '',
      title: d.title,
      original_title: d.title,
      seed_count: d.seeders || d.seedCount || 0,
      size: d.size ? `${d.size} B` : '',
      date: d.publishDate || new Date().toISOString(),
      trackers: [],
      audio: [],
      source: 'prowlarr'
    })).filter(d => d.info_hash);
  } catch (e) {
    return [];
  }
}

// Merge and dedupe results from multiple sources
// Priority: prefer items with more seeders, then by source priority
export function mergeResults(itemsBySource, preferredSources = ['torrent-indexer', 'prowlarr']) {
  const allItems = [];
  for (const [source, items] of Object.entries(itemsBySource)) {
    for (const item of items) {
      allItems.push({ ...item, source });
    }
  }

  // Dedupe by infohash (case-insensitive)
  const seen = new Map();
  for (const item of allItems) {
    const h = (item.info_hash || '').toLowerCase();
    if (!h) continue;
    const existing = seen.get(h);
    if (!existing) {
      seen.set(h, item);
    } else {
      // Keep the one with more seeders
      if ((item.seed_count || 0) > (existing.seed_count || 0)) {
        seen.set(h, item);
      }
    }
  }

  return [...seen.values()];
}
