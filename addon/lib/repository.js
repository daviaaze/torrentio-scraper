import { Sequelize } from 'sequelize';
import { getCinemetaTitle, searchTorrentIndexerByImdb, searchTorrentIndexerByText, searchProwlarr, mergeResults } from './syncSources.js';
const Op = Sequelize.Op;

const DATABASE_URI = process.env.DATABASE_URI;

const database = new Sequelize(DATABASE_URI, { logging: false, pool: { max: 30, min: 5, idle: 20 * 60 * 1000 } });

const Torrent = database.define('torrent',
    {
      infoHash: { type: Sequelize.STRING(64), primaryKey: true },
      provider: { type: Sequelize.STRING(32), allowNull: false },
      torrentId: { type: Sequelize.STRING(128) },
      title: { type: Sequelize.STRING(256), allowNull: false },
      size: { type: Sequelize.BIGINT },
      type: { type: Sequelize.STRING(16), allowNull: false },
      uploadDate: { type: Sequelize.DATE, allowNull: false },
      seeders: { type: Sequelize.SMALLINT },
      trackers: { type: Sequelize.STRING(4096) },
      languages: { type: Sequelize.STRING(4096) },
      resolution: { type: Sequelize.STRING(16) }
    }
);

const File = database.define('file',
    {
      id: { type: Sequelize.BIGINT, autoIncrement: true, primaryKey: true },
      infoHash: {
        type: Sequelize.STRING(64),
        allowNull: false,
        references: { model: Torrent, key: 'infoHash' },
        onDelete: 'CASCADE'
      },
      fileIndex: { type: Sequelize.INTEGER },
      title: { type: Sequelize.STRING(256), allowNull: false },
      size: { type: Sequelize.BIGINT },
      imdbId: { type: Sequelize.STRING(32) },
      imdbSeason: { type: Sequelize.INTEGER },
      imdbEpisode: { type: Sequelize.INTEGER },
      kitsuId: { type: Sequelize.INTEGER },
      kitsuEpisode: { type: Sequelize.INTEGER }
    },
);

const Subtitle = database.define('subtitle',
    {
      infoHash: {
        type: Sequelize.STRING(64),
        allowNull: false,
        references: { model: Torrent, key: 'infoHash' },
        onDelete: 'CASCADE'
      },
      fileIndex: { type: Sequelize.INTEGER, allowNull: false },
      fileId: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: File, key: 'id' },
        onDelete: 'SET NULL'
      },
      title: { type: Sequelize.STRING(512), allowNull: false },
      size: { type: Sequelize.BIGINT, allowNull: false },
    },
    { timestamps: false }
);

Torrent.hasMany(File, { foreignKey: 'infoHash', constraints: false });
File.belongsTo(Torrent, { foreignKey: 'infoHash', constraints: false });
File.hasMany(Subtitle, { foreignKey: 'fileId', constraints: false });
Subtitle.belongsTo(File, { foreignKey: 'fileId', constraints: false });

export function getTorrent(infoHash) {
  return Torrent.findOne({ where: { infoHash: infoHash } });
}

export function getFiles(infoHashes) {
  return File.findAll({ where: { infoHash: { [Op.in]: infoHashes} } });
}

export function getImdbIdMovieEntries(imdbId) {
  return File.findAll({
    where: {
      imdbId: { [Op.eq]: imdbId }
    },
    include: [Torrent],
    limit: 500,
    order: [
      [Torrent, 'seeders', 'DESC']
    ]
  });
}

export function getImdbIdSeriesEntries(imdbId, season, episode) {
  return File.findAll({
    where: {
      imdbId: { [Op.eq]: imdbId },
      imdbSeason: { [Op.eq]: season },
      imdbEpisode: { [Op.eq]: episode }
    },
    include: [Torrent],
    limit: 500,
    order: [
      [Torrent, 'seeders', 'DESC']
    ]
  });
}

export function getKitsuIdMovieEntries(kitsuId) {
  return File.findAll({
    where: {
      kitsuId: { [Op.eq]: kitsuId }
    },
    include: [Torrent],
    limit: 500,
    order: [
      [Torrent, 'seeders', 'DESC']
    ]
  });
}

export function getKitsuIdSeriesEntries(kitsuId, episode) {
  return File.findAll({
    where: {
      kitsuId: { [Op.eq]: kitsuId },
      kitsuEpisode: { [Op.eq]: episode }
    },
    include: [Torrent],
    limit: 500,
    order: [
      [Torrent, 'seeders', 'DESC']
    ]
  });
}

// Insert a torrent record if it does not already exist, returning the instance.
export async function upsertTorrent(torrentData) {
  const [instance, created] = await Torrent.findOrCreate({
    where: { infoHash: torrentData.infoHash },
    defaults: torrentData
  });
  return instance;
}

// Insert a file record, returning the instance.
export async function createFile(fileData) {
  // Idempotent: pack fan-out re-syncs the same (hash, episode) repeatedly.
  const where = {
    infoHash: fileData.infoHash,
    fileIndex: fileData.fileIndex ?? null,
    imdbId: fileData.imdbId ?? null,
    imdbSeason: fileData.imdbSeason ?? null,
    imdbEpisode: fileData.imdbEpisode ?? null,
    kitsuId: fileData.kitsuId ?? null,
    kitsuEpisode: fileData.kitsuEpisode ?? null
  };
  const [instance] = await File.findOrCreate({ where, defaults: fileData });
  return instance;
}

// Parse a human-readable size string (e.g. "3.19 GB", "500 MB") to bytes.
function parseSizeBytes(sizeStr) {
  if (!sizeStr) return null;
  const match = sizeStr.trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB)$/i);
  if (!match) return null;
  const num = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const units = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
  return Math.round(num * units[unit]);
}

// Determine type from IMDb ID and title keywords.
function inferType(imdbId, title) {
  if (/S\d{2}/i.test(title)) return 'series';
  if (extractSeason(title) != null) return 'series';
  if (/[Tt]emporadas?\s+Completas?/i.test(title)) return 'series';
  if (/\b[Cc]ompleto\b/i.test(title)) return 'series';
  return 'movie';
}

// Extract season number from a title string.
function extractSeason(title) {
  // Complete-series packs ("1ª a 8ª Temporada Completa", "Temporadas Completas")
  if (/\d+[ºª]?\s*a\s+\d+[ºª]?\s*[Tt]emporada/i.test(title)) return null;
  if (/[Tt]emporadas\s+Completas/i.test(title)) return null;
  const m = title.match(/S(\d{2})(?!\d)/i);
  if (m) return parseInt(m[1], 10);
  const m2 = title.match(/(\d+)[ºªôo]?\s*[Tt]emporada/i);
  if (m2) return parseInt(m2[1], 10);
  return null;
}

// Extract episode number from a title string.
function extractEpisode(title) {
  const m = title.match(/E(\d{2})(?!\d)/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

// Extract resolution from a title string.
function extractResolution(title) {
  const m = title.match(/\b(\d{3,4}p)\b/i);
  return m ? m[1].toLowerCase() : null;
}

// Query the local torrent-indexer for a given IMDb ID and persist results into the DB.
// Returns an array of { torrent, file } records compatible with getImdbIdMovieEntries/getImdbIdSeriesEntries.
// ---------------------------------------------------------------- pack fileIdx

const packFileCache = new Map(); // infoHash -> Promise<files[]>

async function getPackFileList(infoHash, trackersStr) {
  if (packFileCache.has(infoHash)) return packFileCache.get(infoHash);
  const p = (async () => {
    const PROBER_URL = process.env.PROBER_URL || 'http://127.0.0.1:8460';
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);
      const url = `${PROBER_URL}/files/${infoHash}?trackers=${encodeURIComponent(trackersStr || '')}`;
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!resp.ok) return [];
      const data = await resp.json();
      return data.files || [];
    } catch (e) {
      return [];
    }
  })();
  packFileCache.set(infoHash, p);
  return p;
}

function findFileIndex(files, season, episode) {
  const ep = Number(episode) || 1;
  if (!files || !files.length) return Math.max(0, ep - 1); // packs are ordered: episode N at index N-1
  const re = new RegExp(`[sS]0*${season}[eE]0*${ep}(?![0-9])`);
  for (const f of files) {
    // Normalize single-char dir components (G/o/o/d/./...) and dots
    const norm = String(f.path || f.name || '').replace(/[\/\.]/g, '');
    if (re.test(norm)) return Number(f.index) || 0;
  }
  return Math.max(0, ep - 1);
}

// Enumerate every (season, episode) present in a pack's file list, with each
// episode's real fileIndex + size. Lets one season pack serve all its episodes
// instead of being tagged with whichever single episode triggered the sync.
function enumeratePackEpisodes(files) {
  if (!files || !files.length) return [];
  const out = [];
  const seen = new Set();
  for (const f of files) {
    // Prober paths are char-encoded (S/0/2/E/0/1); strip / and . like findFileIndex.
    const norm = String(f.path || f.name || '').replace(/[\/\.]/g, '');
    const m = norm.match(/s0*(\d{1,2})e0*(\d{1,3})(?!\d)/i);
    if (!m) continue;
    const season = parseInt(m[1], 10);
    const episode = parseInt(m[2], 10);
    const key = `${season}:${episode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ season, episode, fileIndex: Number(f.index) || 0,
               size: f.size != null ? Number(f.size) : null });
  }
  return out;
}

// In-memory sync result cache (5 min TTL) to avoid re-syncing same content
const _syncCache = new Map();
const SYNC_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function cacheGet(key) {
  const v = _syncCache.get(key);
  if (v && Date.now() - v.ts < SYNC_CACHE_TTL) return v.data;
  if (v) _syncCache.delete(key);
  return null;
}

function cacheSet(key, data) {
  _syncCache.set(key, { ts: Date.now(), data });
  // Cleanup old entries every 100 sets
  if (_syncCache.size > 100) {
    const now = Date.now();
    for (const [k, v] of _syncCache) {
      if (now - v.ts > SYNC_CACHE_TTL) _syncCache.delete(k);
    }
  }
}

export async function syncFromIndexer(imdbId, season, episode) {
  // Check cache first
  const cacheKey = `${imdbId}:${season}:${episode}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    console.log(`syncFromIndexer: cache hit for ${cacheKey}`);
    return cached;
  }

  const results = [];
  const seen = new Set();

  // Phase 1: Search by IMDb ID (fast, most accurate)
  let allItems = await searchTorrentIndexerByImdb(imdbId, 20);
  console.log(`syncFromIndexer: ${allItems.length} items from IMDb search for ${imdbId}`);

  // Phase 2: If IMDb search finds nothing OR nothing matches the requested season,
  // fall back to multi-source search (text search + Prowlarr).
  const hasSeasonMatch = allItems.some(item => {
    const title = item.title || item.original_title || '';
    const extSeason = extractSeason(title);
    return extSeason != null && extSeason === Number(season);
  });

  if (allItems.length === 0 || !hasSeasonMatch) {
    console.log(`syncFromIndexer: IMDb search ${allItems.length === 0 ? 'empty' : 'no season match'}, trying multi-source...`);

    // Get title from Cinemeta for text search
    const title = await getCinemetaTitle(imdbId);
    console.log(`syncFromIndexer: Cinemeta title: ${title}`);

    // Search both sources in parallel
    const [textResults, prowlarrResults] = await Promise.all([
      title ? searchTorrentIndexerByText(title, 20) : Promise.resolve([]),
      title ? searchProwlarr(title, season, episode) : Promise.resolve([]),
    ]);

    console.log(`syncFromIndexer: multi-source results - text:${textResults.length} prowlarr:${prowlarrResults.length}`);

    // Merge all results, dedupe by infohash
    const merged = mergeResults({
      'torrent-indexer': allItems,
      'torrent-indexer-text': textResults,
      'prowlarr': prowlarrResults,
    });

    // Rebuild seen set with original items
    for (const item of allItems) {
      seen.add((item.info_hash || '').toLowerCase());
    }

    allItems = merged;
    console.log(`syncFromIndexer: ${allItems.length} items after multi-source merge`);
  }

  // Pass 1: parse + upsert torrents, collect file rows to create
  const fileRows = [];
  const skippedSeason = [];
  for (const item of allItems) {
    if (seen.has(item.info_hash)) continue;
    seen.add(item.info_hash);

    const infoHash = item.info_hash.toLowerCase();
    const title = (item.title || item.original_title || 'Unknown')
        .replace(/&ordf;/g, 'ª').replace(/&ordm;/g, 'º')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/&#39;/g, "'");
    const sizeBytes = parseSizeBytes(item.size);
    const trackersStr = (item.trackers || []).join(',');
    const languagesStr = (item.audio || []).join(',');
    const uploadDate = item.date || new Date().toISOString();

    const torrentType = inferType(imdbId, title);
    const resolution = extractResolution(title);
    const extSeason = extractSeason(title);
    const extEpisode = extractEpisode(title);

    // Track season mismatches for fallback logic
    if (torrentType === 'series' && extSeason != null && season != null && extSeason !== Number(season)) {
      skippedSeason.push({ extSeason, extEpisode, title });
      continue;
    }

    const tData = {
      infoHash,
      provider: 'torrent-indexer',
      title,
      size: sizeBytes,
      type: torrentType,
      uploadDate,
      seeders: item.seed_count != null ? item.seed_count : 0,
      trackers: trackersStr,
      languages: languagesStr,
      resolution
    };

    try {
      const torr = await upsertTorrent(tData);
      const fData = {
        infoHash,
        fileIndex: 0,
        title,
        size: sizeBytes,
        imdbId
      };
      if (torrentType === 'series') {
        fData.imdbSeason = extSeason != null ? extSeason : season;
        fData.imdbEpisode = extEpisode != null ? extEpisode : episode;
      }
      fileRows.push({ torr, fData, trackersStr,
                      isPack: torrentType === 'series' && extEpisode == null });
    } catch (e) {
      // Skip duplicates or constraint errors silently
    }
  }

  // Fallback: if ALL items were filtered by season mismatch, insert them anyway
  // with the actual season from the data (handles series that don't have the requested season)
  if (fileRows.length === 0 && skippedSeason.length > 0 && allItems.length > 0) {
    console.log(`syncFromIndexer: season ${season} not found, falling back to ${skippedSeason[0].extSeason} from ${skippedSeason.length} items`);
    for (const item of allItems) {
      if (seen.has(item.info_hash)) continue;
      seen.add(item.info_hash);

      const infoHash = item.info_hash.toLowerCase();
      const title = (item.title || item.original_title || 'Unknown')
          .replace(/&ordf;/g, 'ª').replace(/&ordm;/g, 'º')
          .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
          .replace(/&#39;/g, "'");
      const sizeBytes = parseSizeBytes(item.size);
      const trackersStr = (item.trackers || []).join(',');
      const languagesStr = (item.audio || []).join(',');
      const uploadDate = item.date || new Date().toISOString();

      const torrentType = inferType(imdbId, title);
      const resolution = extractResolution(title);
      const extSeason = extractSeason(title);
      const extEpisode = extractEpisode(title);

      const tData = {
        infoHash,
        provider: 'torrent-indexer',
        title,
        size: sizeBytes,
        type: torrentType,
        uploadDate,
        seeders: item.seed_count != null ? item.seed_count : 0,
        trackers: trackersStr,
        languages: languagesStr,
        resolution
      };

      try {
        const torr = await upsertTorrent(tData);
        const fData = {
          infoHash,
          fileIndex: 0,
          title,
          size: sizeBytes,
          imdbId
        };
        if (torrentType === 'series') {
          fData.imdbSeason = extSeason != null ? extSeason : season;
          fData.imdbEpisode = extEpisode != null ? extEpisode : episode;
        }
        fileRows.push({ torr, fData, trackersStr,
                        isPack: torrentType === 'series' && extEpisode == null });
      } catch (e) {
        // Skip duplicates or constraint errors silently
      }
    }
  }

  // Pass 2: fetch pack file lists in parallel (deduped by infohash)
  const packTrackers = new Map(); // infoHash -> trackersStr
  for (const r of fileRows) {
    if (r.isPack && !packTrackers.has(r.fData.infoHash)) packTrackers.set(r.fData.infoHash, r.trackersStr);
  }
  const packFileLists = new Map(
    await Promise.all([...packTrackers].map(async ([h, tr]) => [h, await getPackFileList(h, tr)]))
  );

  // Pass 3: assign fileIdx for packs and create file rows.
  // Season packs fan out to one row per episode they actually contain, so a
  // pack discovered via S2E7 also answers S2E6, S2E8, ... (exact-match query).
  for (const r of fileRows) {
    if (r.isPack) {
      const packFiles = packFileLists.get(r.fData.infoHash);
      const eps = enumeratePackEpisodes(packFiles);
      if (eps.length) {
        for (const ep of eps) {
          const efData = { ...r.fData, imdbSeason: ep.season, imdbEpisode: ep.episode,
                           fileIndex: ep.fileIndex };
          if (ep.size != null) efData.size = ep.size;
          try {
            const file = await createFile(efData);
            results.push({ torrent: r.torr, file });
          } catch (e) {
            // Skip duplicates or constraint errors silently
          }
        }
        continue;
      }
      // Unparseable file list: fall back to the single requested episode.
      r.fData.fileIndex = findFileIndex(packFiles, r.fData.imdbSeason, r.fData.imdbEpisode);
    }
    try {
      const file = await createFile(r.fData);
      results.push({ torrent: r.torr, file });
    } catch (e) {
      // Skip duplicates or constraint errors silently
    }
  }

  console.log(`syncFromIndexer: inserted ${results.length} items for ${imdbId}`);
  cacheSet(cacheKey, results);
  return results;
}
