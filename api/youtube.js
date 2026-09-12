// YouTube Data API proxy for Spotlight Shorts (/api/youtube)
// Explicitly targets UK/Ireland (GB, IE) and America (US) regions with
// cross-region blending so Spotlight surfaces a TikTok-style mix of
// geo-relevant content alongside top-performing English-language Shorts.
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "AIzaSyDV9pQngAgMAwN6VLSfYYJV22uJQ4bYigo";
const { isTeenEligible, validRegionCode, VALID_REGIONS } = require('../assets/spotlight-ranking');

const PRIMARY_REGIONS = ['US', 'GB', 'IE'];
const REGION_GROUPS = {
  'en-US': ['US'],
  'en-GB': ['GB', 'IE'],
  'en-IE': ['IE', 'GB'],
  'en': ['US', 'GB']
};
const DEFAULT_REGION = process.env.SPOTLIGHT_REGION || 'US';
const DEFAULT_LANGUAGE = process.env.SPOTLIGHT_LANGUAGE || 'en';
const MAX_RESULTS_PER_REGION = 24;
const MAX_CANDIDATE_POOL = 48;

function validRegion(value) {
  const region = String(value || '').trim().toUpperCase();
  if (PRIMARY_REGIONS.includes(region)) return region;
  const normalized = /^[A-Z]{2}$/.test(region) ? region : null;
  if (normalized) return normalized;
  return DEFAULT_REGION;
}

function validLanguage(value) {
  const language = String(value || '').trim();
  return /^(?:[a-z]{2,3}|zh-Hans|zh-Hant)$/i.test(language) ? language : DEFAULT_LANGUAGE;
}

function resolveRegionBlend(primaryRegion) {
  const primary = validRegion(primaryRegion);
  const blend = new Set([primary]);
  PRIMARY_REGIONS.forEach(region => blend.add(region));
  const ordered = [primary];
  blend.forEach(region => {
    if (region !== primary) ordered.push(region);
  });
  return ordered.slice(0, PRIMARY_REGIONS.length);
}

function parseDurationSeconds(iso) {
  if (!iso || typeof iso !== "string") return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
}

function extractHashtags(value) {
  return Array.from(new Set((String(value || '').match(/#[\p{L}\p{N}_]+/gu) || [])
    .map((tag) => tag.slice(1).toLowerCase()))).slice(0, 14);
}

function inferAudioTrack(snippet) {
  const title = String(snippet?.title || '');
  const description = String(snippet?.description || '');
  const audioMatch = title.match(/\b(?:original audio|sound|audio|remix)\b[^\n\r]{0,48}/i) ||
                     description.match(/\b(?:original audio|sound|audio|remix)\b[^\n\r]{0,48}/i);
  return audioMatch ? audioMatch[0].trim().toLowerCase().slice(0, 64) : '';
}

function mapVideo(item, regionOverride) {
  const sn = item.snippet || {};
  const thumbs = sn.thumbnails || {};
  const thumb = thumbs.maxres || thumbs.standard || thumbs.high || thumbs.medium || thumbs.default || {};
  const duration = parseDurationSeconds(item.contentDetails?.duration);
  const views = Number(item.statistics?.viewCount || 0);
  const likes = Number(item.statistics?.likeCount || 0);
  const comments = Number(item.statistics?.commentCount || 0);
  const shares = Math.round(Math.max(0, likes * (0.12 + Math.random() * 0.08)));
  const saves = Math.round(Math.max(0, likes * (0.18 + Math.random() * 0.1)));
  const estimatedCompletion = clampEstimatedCompletion(duration, views, likes);
  const region = validRegionCode(regionOverride) || validRegionCode(sn.regionCode) || '';
  return {
    id: item.id,
    title: sn.title || "YouTube Short",
    channel: sn.channelTitle || "Creator",
    description: sn.description || "",
    thumbnail: thumb.url || "",
    views,
    likes,
    shares,
    saves,
    comments,
    duration,
    publishedAt: sn.publishedAt || null,
    category: sn.categoryId || '',
    hashtags: extractHashtags(`${sn.title || ''} ${sn.description || ''}`),
    audioTrack: inferAudioTrack(sn),
    creatorId: sn.channelId || sn.channelTitle || '',
    madeForKids: Boolean(item.status?.madeForKids || item.status?.selfDeclaredMadeForKids),
    region,
    signals: {
      views,
      likes,
      shares,
      saves,
      comments,
      impressions: views,
      watchedPast80Count: Math.round(views * estimatedCompletion),
      rewatches: Math.round(Math.max(0, views * estimatedCompletion * 0.15)),
      completionRate: estimatedCompletion,
      estimatedCompletionRate: estimatedCompletion
    }
  };
}

function clampEstimatedCompletion(duration, views, likes) {
  const base = duration < 15 ? 0.62 : duration < 30 ? 0.54 : duration < 60 ? 0.42 : 0.33;
  const engagement = views > 0 ? likes / Math.max(1, views) : 0;
  const boost = Math.min(0.22, engagement * 12);
  return Math.max(0.08, Math.min(0.92, base + boost));
}

async function fetchShortCandidates({
  pageToken = '',
  q = '#shorts',
  order = 'viewCount',
  maxResults = 20,
  regionCode = DEFAULT_REGION,
  relevanceLanguage = DEFAULT_LANGUAGE
} = {}) {
  const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
  searchUrl.searchParams.set('part', 'snippet');
  searchUrl.searchParams.set('type', 'video');
  searchUrl.searchParams.set('videoDuration', 'short');
  searchUrl.searchParams.set('maxResults', String(Math.min(50, Math.max(1, Number(maxResults) || 20))));
  searchUrl.searchParams.set('order', order === 'date' ? 'date' : 'viewCount');
  searchUrl.searchParams.set('safeSearch', 'strict');
  searchUrl.searchParams.set('regionCode', validRegion(regionCode));
  searchUrl.searchParams.set('relevanceLanguage', validLanguage(relevanceLanguage));
  searchUrl.searchParams.set('q', q);
  searchUrl.searchParams.set('key', YOUTUBE_API_KEY);
  if (pageToken) searchUrl.searchParams.set('pageToken', pageToken);

  const searchRes = await fetch(searchUrl.toString());
  const searchJson = await searchRes.json();
  if (!searchRes.ok) throw new Error(searchJson.error?.message || 'YouTube search failed');

  const ids = (searchJson.items || [])
    .map((item) => item.id && item.id.videoId)
    .filter(Boolean);
  if (!ids.length) return { videos: [], nextPageToken: null };

  const videosUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
  videosUrl.searchParams.set('part', 'snippet,statistics,contentDetails,status');
  videosUrl.searchParams.set('id', ids.join(','));
  videosUrl.searchParams.set('key', YOUTUBE_API_KEY);
  const videosRes = await fetch(videosUrl.toString());
  const videosJson = await videosRes.json();
  if (!videosRes.ok) throw new Error(videosJson.error?.message || 'YouTube videos lookup failed');

  const effectiveRegion = validRegion(regionCode);
  const itemsById = new Map((videosJson.items || []).map(item => [String(item.id), item]));
  const orderedItems = ids.map(id => itemsById.get(id)).filter(Boolean);

  return {
    videos: orderedItems
      .map(item => mapVideo(item, effectiveRegion))
      .filter((video) => video.id && video.duration > 0 && video.duration <= 180 && isTeenEligible(video)),
    nextPageToken: searchJson.nextPageToken || null
  };
}

async function fetchMultiRegionCandidates({
  pageTokens = {},
  q = '#shorts',
  order = 'viewCount',
  maxResultsPerRegion = 20,
  regionCode = DEFAULT_REGION,
  relevanceLanguage = DEFAULT_LANGUAGE
} = {}) {
  const blend = resolveRegionBlend(regionCode);
  const regionWeights = blend.map((region, index) => ({
    region,
    weight: index === 0 ? 0.58 : index === 1 ? 0.28 : 0.14
  }));

  const requests = regionWeights.map(({ region }) =>
    fetchShortCandidates({
      pageToken: pageTokens[region] || '',
      q,
      order,
      maxResults: MAX_RESULTS_PER_REGION,
      regionCode: region,
      relevanceLanguage
    }).then(result => ({ region, result })).catch(error => ({ region, result: { videos: [], nextPageToken: null, error } }))
  );

  const responses = await Promise.all(requests);
  const videosById = new Map();
  const nextPageTokens = {};

  responses.forEach(({ region, result }) => {
    nextPageTokens[region] = result.nextPageToken || '';
    (result.videos || []).forEach(video => {
      const id = String(video.id);
      if (!videosById.has(id)) {
        videosById.set(id, { ...video, region });
      }
    });
  });

  const weightedVideos = [];
  const allVideos = Array.from(videosById.values());
  regionWeights.forEach(({ region, weight }) => {
    const regionVideos = allVideos.filter(v => String(v.region) === region);
    const slotCount = Math.ceil(MAX_CANDIDATE_POOL * weight);
    weightedVideos.push(...regionVideos.slice(0, slotCount));
  });

  const deduped = [];
  const seen = new Set();
  for (const video of weightedVideos) {
    const id = String(video.id);
    if (!seen.has(id)) {
      seen.add(id);
      deduped.push(video);
      if (deduped.length >= MAX_CANDIDATE_POOL) break;
    }
  }

  return {
    videos: deduped,
    nextPageTokens,
    primaryRegion: validRegion(regionCode),
    regionsBlended: regionWeights.map(r => r.region)
  };
}

async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const pageToken = (req.query.pageToken || "").trim();
    const q = (req.query.q || "#shorts").trim() || "#shorts";
    const regionCode = validRegion(req.query.region);
    const relevanceLanguage = validLanguage(req.query.language);
    const useMultiRegion = String(req.query.blend || '1') !== '0';

    if (useMultiRegion) {
      const result = await fetchMultiRegionCandidates({
        pageTokens: { [regionCode]: pageToken },
        q,
        order: 'viewCount',
        maxResultsPerRegion: MAX_RESULTS_PER_REGION,
        regionCode,
        relevanceLanguage
      });
      const fallbackNext = result.nextPageTokens[result.primaryRegion] ||
        Object.values(result.nextPageTokens).find(Boolean) ||
        null;
      return res.status(200).json({
        success: true,
        videos: result.videos,
        nextPageToken: fallbackNext,
        nextCursor: fallbackNext,
        primaryRegion: result.primaryRegion,
        regionsBlended: result.regionsBlended
      });
    }

    const result = await fetchShortCandidates({ pageToken, q, order: 'viewCount', maxResults: 20, regionCode, relevanceLanguage });

    return res.status(200).json({
      success: true,
      videos: result.videos,
      nextPageToken: result.nextPageToken || null,
      nextCursor: result.nextPageToken || null,
      primaryRegion: regionCode
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message || "Spotlight feed failed" });
  }
}

module.exports = handler;
module.exports.fetchShortCandidates = fetchShortCandidates;
module.exports.fetchMultiRegionCandidates = fetchMultiRegionCandidates;
module.exports.mapVideo = mapVideo;
module.exports.validRegion = validRegion;
module.exports.validLanguage = validLanguage;
module.exports.resolveRegionBlend = resolveRegionBlend;
module.exports.PRIMARY_REGIONS = PRIMARY_REGIONS;
module.exports.DEFAULT_REGION = DEFAULT_REGION;
