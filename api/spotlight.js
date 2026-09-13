// Ranked Spotlight feed. The ranking state is carried as a compact per-user
// profile so the endpoint remains stateless and safe to prefetch on Vercel.
const { fetchShortCandidates, fetchMultiRegionCandidates, validRegion, validLanguage, PRIMARY_REGIONS } = require('./youtube');
const { fetchTikTokCandidates, fetchMultiRegionTikTok, probeTikTokConnectivity } = require('./tiktok');
const Ranking = require('../assets/spotlight-ranking');

const MAX_PAGE_SIZE = 24;
const MIN_PAGE_SIZE = 6;
const DEFAULT_PAGE_SIZE = 12;
const PREFETCH_HINT_VIDEO_COUNT = 4;
const TIKTOK_SOURCE_PREFERENCE = process.env.SPOTLIGHT_PREFERRED_SOURCE !== 'youtube';

function parseCursor(value) {
  if (!value || typeof value !== 'string') return { page: 0, popular: {}, fresh: {}, seed: Date.now(), blend: true, tiktokPage: '', tiktokTokens: {} };
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return {
      page: Math.max(0, Number(decoded.page) || 0),
      popular: decoded.popular && typeof decoded.popular === 'object' ? decoded.popular : (typeof decoded.popular === 'string' ? { _legacy: decoded.popular } : {}),
      fresh: decoded.fresh && typeof decoded.fresh === 'object' ? decoded.fresh : (typeof decoded.fresh === 'string' ? { _legacy: decoded.fresh } : {}),
      seed: Number(decoded.seed) || Date.now(),
      blend: decoded.blend !== false,
      tiktokPage: decoded.tiktokPage || '',
      tiktokTokens: decoded.tiktokTokens && typeof decoded.tiktokTokens === 'object' ? decoded.tiktokTokens : {}
    };
  } catch (error) {
    return { page: 0, popular: {}, fresh: {}, seed: Date.now(), blend: true, tiktokPage: '', tiktokTokens: {} };
  }
}

function makeCursor(cursor, popularTokens, freshTokens, blend, tiktokPage, tiktokTokens) {
  const hasPopular = popularTokens && (typeof popularTokens === 'object' ? Object.keys(popularTokens).length > 0 : popularTokens);
  const hasFresh = freshTokens && (typeof freshTokens === 'object' ? Object.keys(freshTokens).length > 0 : freshTokens);
  const hasTikTok = Boolean(tiktokPage) || (tiktokTokens && typeof tiktokTokens === 'object' && Object.keys(tiktokTokens).length > 0);
  if (!hasPopular && !hasFresh && !hasTikTok) return null;
  return Buffer.from(JSON.stringify({
    v: 3,
    page: cursor.page + 1,
    popular: popularTokens || {},
    fresh: freshTokens || {},
    seed: cursor.seed + 0x19991,
    blend: blend !== false,
    tiktokPage: tiktokPage || '',
    tiktokTokens: tiktokTokens || {}
  })).toString('base64url');
}

function mergeLegacyTokens(tokens, region) {
  if (!tokens) return '';
  if (typeof tokens === 'string') return tokens;
  if (typeof tokens === 'object') {
    if (tokens[region]) return tokens[region];
    if (tokens._legacy) return tokens._legacy;
  }
  return '';
}

async function collectCandidatesByOrder({ cursor, q, order, regionCode, relevanceLanguage, useMultiRegion }) {
  const region = validRegion(regionCode);
  if (useMultiRegion) {
    const popularTokens = order === 'viewCount' ? cursor.popular : cursor.fresh;
    const result = await fetchMultiRegionCandidates({
      pageTokens: popularTokens || {},
      q,
      order,
      maxResultsPerRegion: Math.ceil(MAX_PAGE_SIZE * 1.2),
      regionCode: region,
      relevanceLanguage
    });
    return {
      videos: result.videos,
      tokens: result.nextPageTokens,
      primaryRegion: result.primaryRegion,
      regionsBlended: result.regionsBlended
    };
  }

  const tokenKey = order === 'viewCount' ? cursor.popular : cursor.fresh;
  const pageToken = mergeLegacyTokens(tokenKey, region);
  const single = await fetchShortCandidates({
    pageToken,
    q,
    order,
    maxResults: MAX_PAGE_SIZE,
    regionCode: region,
    relevanceLanguage
  });
  return {
    videos: single.videos,
    tokens: { [region]: single.nextPageToken || '' },
    primaryRegion: region,
    regionsBlended: [region]
  };
}

async function collectTikTokCandidates({ cursor, regionCode, useMultiRegion, limit }) {
  const region = validRegion(regionCode);
  if (useMultiRegion) {
    return await fetchMultiRegionTikTok({
      pageTokens: cursor.tiktokTokens || {},
      maxResultsPerRegion: Math.ceil(MAX_PAGE_SIZE * 1.2),
      regionCode: region,
      blend: true,
      cursorSeed: cursor.seed
    }).catch(err => ({ videos: [], nextPageTokens: {}, reachable: false, source: 'tiktok-error', primaryRegion: region, regionsBlended: [region], error: err }));
  }
  const result = await fetchTikTokCandidates({
    pageToken: cursor.tiktokPage || '',
    maxResults: Math.max(limit, MAX_PAGE_SIZE),
    regionCode: region,
    cursorSeed: cursor.seed
  }).catch(err => ({ videos: [], nextPageToken: null, reachable: false, source: 'tiktok-error', error: err }));
  return {
    videos: result.videos || [],
    tokens: { [region]: result.nextPageToken || '' },
    nextPage: result.nextPageToken || '',
    primaryRegion: result.primaryRegion || region,
    regionsBlended: result.regionsBlended || [region],
    reachable: result.reachable !== false
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.setHeader('Vary', 'Accept-Encoding, Accept-Language');
  res.setHeader('X-Spotlight-Region', validRegion(req.query.region));

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });

  try {
    const cursor = parseCursor(String(req.query.cursor || ''));
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, Number(req.query.limit) || DEFAULT_PAGE_SIZE));
    const query = String(req.query.q || '#shorts #fyp #viral').trim() || '#shorts';
    const regionCode = validRegion(req.query.region);
    const relevanceLanguage = validLanguage(req.query.language);
    const useMultiRegion = String(req.query.blend || (cursor.blend ? '1' : '0')) !== '0';
    const profile = Ranking.decodeProfile(String(req.query.profile || ''));
    const forceSource = String(req.query.source || '').toLowerCase();
    const probeOnly = String(req.query.probe || '0') === '1';

    if (profile && !profile.region) profile.region = regionCode;
    else if (profile && validRegion(profile.region)) profile.region = validRegion(profile.region);

    if (probeOnly) {
      const [tiktokReachable] = await Promise.all([
        probeTikTokConnectivity().catch(() => false)
      ]);
      return res.status(200).json({
        success: true,
        probe: true,
        tiktok: { reachable: tiktokReachable, preferred: TIKTOK_SOURCE_PREFERENCE },
        region: regionCode
      });
    }

    const tryTikTokFirst = forceSource !== 'youtube' && (forceSource === 'tiktok' || TIKTOK_SOURCE_PREFERENCE);

    let tiktokResult = null;
    let youtubePopular = null;
    let youtubeFresh = null;
    let activeSource = 'youtube';
    let tiktokReachable = false;

    if (tryTikTokFirst) {
      try {
        tiktokResult = await collectTikTokCandidates({ cursor, regionCode, useMultiRegion, limit });
        tiktokReachable = tiktokResult.reachable !== false;
        const tiktokVideos = (tiktokResult.videos || []).filter(v => v && v.id);
        if (tiktokReachable && tiktokVideos.length >= Math.ceil(limit / 2)) {
          activeSource = 'tiktok';
        }
      } catch (_) {
        tiktokResult = null;
        tiktokReachable = false;
      }
    }

    if (activeSource === 'youtube' || !tiktokReachable) {
      [youtubePopular, youtubeFresh] = await Promise.all([
        collectCandidatesByOrder({
          cursor,
          q: query,
          order: 'viewCount',
          regionCode,
          relevanceLanguage,
          useMultiRegion
        }).catch(err => ({ videos: [], tokens: {}, primaryRegion: regionCode, regionsBlended: [regionCode], error: err })),
        collectCandidatesByOrder({
          cursor,
          q: query,
          order: 'date',
          regionCode,
          relevanceLanguage,
          useMultiRegion
        }).catch(err => ({ videos: [], tokens: {}, primaryRegion: regionCode, regionsBlended: [regionCode], error: err }))
      ]);
      activeSource = 'youtube';
    }

    let candidatePool = [];
    if (activeSource === 'tiktok' && tiktokResult) {
      candidatePool = [...(tiktokResult.videos || [])];
    }
    if (activeSource === 'youtube') {
      candidatePool = [...(youtubePopular?.videos || []), ...(youtubeFresh?.videos || [])];
    }
    if (candidatePool.length < Math.ceil(limit / 2) && youtubePopular && youtubeFresh) {
      const supplement = [...(youtubePopular?.videos || []), ...(youtubeFresh?.videos || [])];
      const existingIds = new Set(candidatePool.map(v => String(v.id)));
      for (const v of supplement) {
        if (v && v.id && !existingIds.has(String(v.id))) {
          candidatePool.push(v);
          existingIds.add(String(v.id));
        }
      }
      if (supplement.length > 0 && candidatePool.length >= limit) activeSource = activeSource === 'tiktok' ? 'hybrid' : 'youtube';
    }

    const deduped = [];
    const seen = new Set();
    for (const video of candidatePool) {
      const id = String(video && video.id || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      deduped.push(video);
    }

    const ranked = Ranking.rankCandidates(
      deduped,
      profile,
      { limit, seed: cursor.seed }
    );

    const hasMoreTikTok = tiktokResult && tiktokReachable && (
      Boolean(tiktokResult.nextPage) ||
      Object.values(tiktokResult.tokens || {}).some(Boolean)
    );
    const hasMoreYoutube = youtubePopular && youtubeFresh && (
      deduped.length > ranked.videos.length ||
      Object.values(youtubePopular.tokens || {}).some(Boolean) ||
      Object.values(youtubeFresh.tokens || {}).some(Boolean)
    );
    const hasMoreVideos = hasMoreTikTok || hasMoreYoutube;

    const nextCursor = hasMoreVideos
      ? makeCursor(
          cursor,
          youtubePopular?.tokens || {},
          youtubeFresh?.tokens || {},
          useMultiRegion,
          tiktokResult?.nextPage || '',
          tiktokResult?.tokens || cursor.tiktokTokens || {}
        )
      : null;

    const prefetchHint = ranked.videos.slice(Math.max(0, ranked.videos.length - PREFETCH_HINT_VIDEO_COUNT))
      .map(v => String(v.id));

    return res.status(200).json({
      success: true,
      videos: ranked.videos.map(v => ({ ...v, platform: v.platform || (activeSource === 'tiktok' ? 'tiktok' : 'youtube') })),
      nextCursor,
      page: cursor.page,
      pageSize: ranked.videos.length,
      source: activeSource,
      tiktok: {
        reachable: tiktokReachable,
        preferred: TIKTOK_SOURCE_PREFERENCE,
        delivered: (tiktokResult?.videos || []).filter(v => ranked.videos.some(r => String(r.id) === String(v?.id))).length
      },
      locale: {
        region: regionCode,
        primaryRegion: (youtubePopular?.primaryRegion || tiktokResult?.primaryRegion) || regionCode,
        regionsBlended: (youtubePopular?.regionsBlended || tiktokResult?.regionsBlended) || PRIMARY_REGIONS,
        language: relevanceLanguage,
        multiRegion: useMultiRegion
      },
      exploration: {
        rate: ranked.explorationRateUsed || Ranking.EXPLORATION_RATE,
        delivered: ranked.explorationCount,
        exploitationDelivered: ranked.exploitationCount,
        minRate: Ranking.EXPLORATION_MIN,
        maxRate: Ranking.EXPLORATION_MAX
      },
      prefetch: {
        recommendedLimit: Math.min(MAX_PAGE_SIZE, limit + 6),
        nextVideoIds: prefetchHint,
        cursorRequired: Boolean(nextCursor)
      },
      profile: {
        encoded: Ranking.encodeProfile(Ranking.markVideosSeen(profile, ranked.videos)),
        interestsCount: Object.values(profile?.interests || {}).reduce((s, o) => s + Object.keys(o || {}).length, 0),
        seenCount: profile?.seenVideoIds?.length || 0
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Spotlight feed failed',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};
