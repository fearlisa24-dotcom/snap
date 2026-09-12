/*
 * Shared Spotlight ranking engine — TikTok-style hybrid recommendation.
 *
 * Dependency-free UMD wrapper so identical ranking logic runs in both
 * the browser (for instant local interest updates) and the serverless
 * feed endpoint (for authoritative page ordering).
 */
(function exposeSpotlightRanking(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SpotlightRanking = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createSpotlightRanking() {
  const INTEREST_TYPES = ['categories', 'hashtags', 'audioTracks', 'creators'];
  const INTEREST_WEIGHTS = {
    categories: 0.32,
    hashtags: 0.30,
    audioTracks: 0.18,
    creators: 0.20
  };
  const ENGAGEMENT_WEIGHTS = {
    completion: 0.44,
    likes: 0.13,
    shares: 0.18,
    saves: 0.15,
    comments: 0.10
  };
  const SESSION_WEIGHTS = {
    watchTime: 0.40,
    scrollDepth: 0.22,
    rewatchRate: 0.20,
    actionDensity: 0.18
  };
  const EXPLORATION_RATE = 0.18;
  const EXPLORATION_MIN = 0.15;
  const EXPLORATION_MAX = 0.20;
  const FRESH_VIDEO_HOURS = 72;
  const TIME_DECAY_HALF_LIFE_HOURS = 168;
  const NEW_VIDEO_BOOST_HOURS = 24;
  const MAX_HISTORY = 500;
  const QUICK_SWIPE_SECONDS = 2;
  const WATCH_THRESHOLD_SECONDS = 5;
  const COMPLETION_THRESHOLD = 0.80;
  const REWATCH_THRESHOLD_VISITS = 2;
  const VALID_REGIONS = ['US', 'GB', 'IE'];
  const REGION_BIAS_WEIGHT = 0.06;
  const YOUNG_KID_CONTENT_PATTERNS = [
    /\bnursery rhymes?\b/i,
    /\b(toddler|preschool|kindergarten)\b/i,
    /\b(baby songs?|lullab(?:y|ies))\b/i,
    /\b(for toddlers|for preschoolers|for kids ages? \d|for children ages? \d)\b/i,
    /\b(learn(?:ing)? (?:colors?|abc|alphabet|numbers?) for (?:kids|toddlers))\b/i,
    /\b(toy unboxing for kids|kids cartoon|children'?s cartoon)\b/i,
    /\b(cocomelon|little baby bum|baby shark)\b/i
  ];

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, Number.isFinite(Number(value)) ? Number(value) : min));
  }

  function number(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : (fallback || 0);
  }

  function canonical(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .slice(0, 100);
  }

  function unique(values) {
    return Array.from(new Set((values || []).map(canonical).filter(Boolean)));
  }

  function uniqueIds(values) {
    return Array.from(new Set((values || []).map(value => String(value || '').trim()).filter(Boolean)));
  }

  function parseHashtags(value) {
    if (Array.isArray(value)) return unique(value.map(tag => String(tag).replace(/^#/, '')));
    return unique((String(value || '').match(/#[\p{L}\p{N}_]+/gu) || []).map(tag => tag.slice(1)));
  }

  function toEpoch(value) {
    if (!value) return 0;
    const timestamp = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function videoAgeHours(video, now) {
    const uploadedAt = toEpoch(video && (video.publishedAt || video.uploadedAt || video.createdAt));
    if (!uploadedAt) return FRESH_VIDEO_HOURS * 2;
    return Math.max(0, (number(now, Date.now()) - uploadedAt) / 3600000);
  }

  function metric(video, names) {
    const sources = [video && video.signals, video && video.metrics, video].filter(Boolean);
    for (const source of sources) {
      for (const name of names) {
        if (source[name] != null) return number(source[name], 0);
      }
    }
    return 0;
  }

  function completionRate(video) {
    const explicit = metric(video, ['completionRate', 'completedOrRewatchedRate']);
    if (explicit > 0) return clamp(explicit, 0, 1);
    const completed = metric(video, ['watchedPast80Count', 'completedViews', 'completionCount']);
    const rewatches = metric(video, ['rewatches', 'rewatchCount']);
    const impressions = metric(video, ['impressions', 'views', 'viewCount']);
    if (impressions > 0 && (completed > 0 || rewatches > 0)) {
      return clamp((completed + rewatches * 1.2) / impressions, 0, 1);
    }
    return clamp(metric(video, ['estimatedCompletionRate']), 0, 1);
  }

  function engagementScore(video) {
    const views = Math.max(1, metric(video, ['impressions', 'views', 'viewCount']));
    const completion = completionRate(video);
    const logViews = Math.log10(views + 1);
    const popularityDampening = 1 / (1 + Math.exp(-(logViews - 3) * 0.6));
    const likes = clamp(metric(video, ['likes', 'likeCount']) / views / 0.08, 0, 1);
    const shares = clamp(metric(video, ['shares', 'shareCount']) / views / 0.02, 0, 1);
    const saves = clamp(metric(video, ['saves', 'saveCount']) / views / 0.03, 0, 1);
    const comments = clamp(metric(video, ['comments', 'commentCount']) / views / 0.025, 0, 1);
    const interactionSurprise = (shares + saves) * 0.5 > likes * 0.35 ? 1.15 : 1.0;
    const viralityCoefficient = shares > 0 ? 1 + Math.log10(shares + 1) * 0.04 : 1.0;
    const rawScore = (
      completion * ENGAGEMENT_WEIGHTS.completion +
      likes * ENGAGEMENT_WEIGHTS.likes +
      shares * ENGAGEMENT_WEIGHTS.shares +
      saves * ENGAGEMENT_WEIGHTS.saves +
      comments * ENGAGEMENT_WEIGHTS.comments
    );
    const adjustedScore = rawScore * popularityDampening * interactionSurprise * viralityCoefficient;
    return {
      score: clamp(adjustedScore, 0, 1),
      completion,
      likes,
      shares,
      saves,
      comments,
      popularityDampening,
      viralityCoefficient
    };
  }

  function freshnessScore(video, now) {
    const ageHours = videoAgeHours(video, now);
    const exponentialDecay = Math.exp((-Math.LN2 * ageHours) / TIME_DECAY_HALF_LIFE_HOURS);
    if (ageHours <= NEW_VIDEO_BOOST_HOURS) {
      const linearBoost = 1 + (1 - ageHours / NEW_VIDEO_BOOST_HOURS) * 0.30;
      return clamp(exponentialDecay * linearBoost, 0, 1.25);
    }
    return exponentialDecay;
  }

  function extractFeatures(video) {
    const categoryValues = Array.isArray(video && video.categories)
      ? video.categories
      : [video && (video.category || video.categoryId)];
    const suppliedTags = video && video.hashtags;
    const descriptionAndTitle = `${video && video.title || ''} ${video && video.description || ''}`;
    const hashtags = unique([
      ...parseHashtags(suppliedTags),
      ...parseHashtags(descriptionAndTitle)
    ]).slice(0, 14);
    const audioValues = Array.isArray(video && video.audioTracks)
      ? video.audioTracks
      : [video && (video.audioTrack || video.audio)];
    const creatorValues = [video && (video.creatorId || video.creator || video.channelId || video.channel)];
    return {
      categories: unique(categoryValues).slice(0, 5),
      hashtags,
      audioTracks: unique(audioValues).slice(0, 4),
      creators: unique(creatorValues).slice(0, 2)
    };
  }

  function isTeenEligible(video) {
    if (!video || video.madeForKids === true || video.childDirected === true || video.teenEligible === false) return false;
    const text = `${video.title || ''} ${video.description || ''} ${video.channel || ''}`;
    return !YOUNG_KID_CONTENT_PATTERNS.some(pattern => pattern.test(text));
  }

  function validRegionCode(value) {
    const region = String(value || '').trim().toUpperCase();
    return VALID_REGIONS.includes(region) ? region : null;
  }

  function emptyProfile() {
    return {
      version: 2,
      interests: Object.fromEntries(INTEREST_TYPES.map(type => [type, {}])),
      hiddenVideoIds: [],
      seenVideoIds: [],
      watchHistory: {},
      region: 'US',
      language: 'en',
      session: {
        startedAt: 0,
        watchSeconds: 0,
        swipes: 0,
        actions: 0,
        videosViewed: 0
      },
      updatedAt: Date.now()
    };
  }

  function normalizeInterestEntry(value, now) {
    if (typeof value === 'number') return { value: clamp(value, -2.5, 3.5), updatedAt: now };
    return {
      value: clamp(value && value.value, -2.5, 3.5),
      updatedAt: number(value && value.updatedAt, now)
    };
  }

  function normaliseProfile(value) {
    const now = Date.now();
    const raw = value && typeof value === 'object' ? value : {};
    const profile = emptyProfile();
    profile.version = Math.max(1, number(raw.version, 1));
    profile.updatedAt = number(raw.updatedAt, now);
    profile.region = validRegionCode(raw.region) || raw.region || profile.region;
    profile.language = String(raw.language || profile.language).trim().slice(0, 8);
    for (const type of INTEREST_TYPES) {
      const source = raw.interests && raw.interests[type];
      if (!source || typeof source !== 'object') continue;
      Object.entries(source).slice(0, 150).forEach(([key, entry]) => {
        const cleanKey = canonical(key);
        if (cleanKey) profile.interests[type][cleanKey] = normalizeInterestEntry(entry, now);
      });
    }
    profile.hiddenVideoIds = uniqueIds(raw.hiddenVideoIds).slice(-MAX_HISTORY);
    profile.seenVideoIds = uniqueIds(raw.seenVideoIds).slice(-MAX_HISTORY);
    if (raw.watchHistory && typeof raw.watchHistory === 'object') {
      Object.entries(raw.watchHistory).slice(-MAX_HISTORY).forEach(([id, entry]) => {
        if (!id) return;
        profile.watchHistory[String(id)] = {
          seconds: Math.max(0, number(entry && entry.seconds, 0)),
          visits: Math.max(0, number(entry && entry.visits, 0)),
          updatedAt: number(entry && entry.updatedAt, now)
        };
      });
    }
    if (raw.session && typeof raw.session === 'object') {
      profile.session = {
        startedAt: number(raw.session.startedAt, now),
        watchSeconds: Math.max(0, number(raw.session.watchSeconds, 0)),
        swipes: Math.max(0, number(raw.session.swipes, 0)),
        actions: Math.max(0, number(raw.session.actions, 0)),
        videosViewed: Math.max(0, number(raw.session.videosViewed, 0))
      };
    }
    return profile;
  }

  function cloneProfile(profile) {
    return normaliseProfile(JSON.parse(JSON.stringify(normaliseProfile(profile))));
  }

  function decayInterest(entry, now) {
    const elapsedDays = Math.max(0, (now - number(entry.updatedAt, now)) / 86400000);
    return entry.value * Math.pow(0.982, elapsedDays);
  }

  function bumpInterests(profile, features, delta, now) {
    for (const type of INTEREST_TYPES) {
      const values = features[type] || [];
      if (!values.length) continue;
      const sortedMagnitude = values.length;
      const perFeatureDelta = delta / Math.max(1, sortedMagnitude);
      for (const feature of values) {
        const existing = profile.interests[type][feature] || { value: 0, updatedAt: now };
        const decayed = decayInterest(existing, now);
        profile.interests[type][feature] = {
          value: clamp(decayed + perFeatureDelta, -2.5, 3.5),
          updatedAt: now
        };
      }
    }
  }

  function pruneInterests(profile) {
    for (const type of INTEREST_TYPES) {
      const entries = Object.entries(profile.interests[type])
        .filter(([, entry]) => Math.abs(entry.value) >= 0.015)
        .sort((a, b) => Math.abs(b[1].value) - Math.abs(a[1].value))
        .slice(0, 100);
      profile.interests[type] = Object.fromEntries(entries);
    }
  }

  function updateInterestProfile(inputProfile, video, event) {
    const profile = cloneProfile(inputProfile);
    const now = number(event && event.at, Date.now());
    const safeEvent = event || {};
    const type = safeEvent.type || 'watch';
    const watchedSeconds = Math.max(0, number(safeEvent.watchSeconds, 0));
    const duration = Math.max(1, number(safeEvent.duration || (video && video.duration), 1));
    const watchRatio = clamp(watchedSeconds / duration, 0, 1);
    const isQuickSwipe = type === 'skip' || (safeEvent.wasSwipe && watchedSeconds <= QUICK_SWIPE_SECONDS);
    const isPastThreshold = watchedSeconds >= WATCH_THRESHOLD_SECONDS || watchRatio >= 0.18;
    const isComplete = watchRatio >= COMPLETION_THRESHOLD;
    const id = String(video && video.id || '');
    const features = extractFeatures(video || {});

    if (!profile.session.startedAt) profile.session.startedAt = now;

    if (isQuickSwipe) {
      if (id) profile.hiddenVideoIds = uniqueIds([...profile.hiddenVideoIds, id]).slice(-MAX_HISTORY);
      bumpInterests(profile, features, -0.9, now);
      profile.session.swipes += 1;
    } else {
      let delta = 0;
      switch (type) {
        case 'like': delta = 0.85; break;
        case 'share': delta = 1.15; break;
        case 'save': delta = 1.0; break;
        case 'comment': delta = 0.75; break;
        case 'complete': delta = 0.9; break;
        case 'rewatch': delta = 1.2; break;
        case 'follow': delta = 0.6; break;
        case 'watch':
        default:
          if (isComplete) delta = 0.6 + 0.35 * watchRatio;
          else if (isPastThreshold) delta = 0.22 + 0.50 * watchRatio;
          break;
      }
      if (delta) {
        bumpInterests(profile, features, delta, now);
        if (type !== 'watch' && type !== 'complete' && type !== 'rewatch') {
          profile.session.actions += 1;
        }
      }
    }

    if (id && (type === 'watch' || type === 'complete' || type === 'rewatch' || isQuickSwipe)) {
      const previous = profile.watchHistory[id] || { seconds: 0, visits: 0 };
      const isRewatch = previous.visits >= REWATCH_THRESHOLD_VISITS && watchedSeconds >= WATCH_THRESHOLD_SECONDS;
      profile.watchHistory[id] = {
        seconds: previous.seconds + watchedSeconds,
        visits: previous.visits + 1,
        updatedAt: now
      };
      if (isRewatch) bumpInterests(profile, features, 0.45, now);
      if (watchedSeconds >= 1) {
        profile.session.watchSeconds += watchedSeconds;
        profile.session.videosViewed += 1;
      }
    }

    const historyEntries = Object.entries(profile.watchHistory)
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, MAX_HISTORY);
    profile.watchHistory = Object.fromEntries(historyEntries);
    pruneInterests(profile);
    profile.updatedAt = now;
    return profile;
  }

  function markVideosSeen(inputProfile, videos) {
    const profile = cloneProfile(inputProfile);
    const ids = (videos || []).map(video => String(video && video.id || '')).filter(Boolean);
    profile.seenVideoIds = uniqueIds([...profile.seenVideoIds, ...ids]).slice(-MAX_HISTORY);
    profile.updatedAt = Date.now();
    return profile;
  }

  function preferenceScore(video, profile, now) {
    const features = extractFeatures(video);
    let weightedScore = 0;
    let availableWeight = 0;
    let activeSignals = 0;
    for (const type of INTEREST_TYPES) {
      const values = features[type];
      if (!values.length) continue;
      let featureSum = 0;
      let featureCount = 0;
      for (const value of values) {
        const entry = profile.interests[type][value];
        if (entry) {
          const affinity = decayInterest(entry, now);
          featureSum += affinity;
          featureCount += 1;
          if (Math.abs(affinity) > 0.25) activeSignals += 1;
        }
      }
      if (featureCount > 0) {
        const averageAffinity = featureSum / values.length;
        weightedScore += INTEREST_WEIGHTS[type] * clamp(averageAffinity / 2.2, -1, 1);
        availableWeight += INTEREST_WEIGHTS[type];
      }
    }
    if (!availableWeight) {
      return { score: 0.5, confidence: 0, signals: 0 };
    }
    const coldStartPenalty = activeSignals < 3 ? 0.85 + activeSignals * 0.05 : 1.0;
    const rawScore = 0.5 + weightedScore / (2 * availableWeight);
    return {
      score: clamp(rawScore * coldStartPenalty, 0, 1),
      confidence: clamp(activeSignals / 6, 0, 1),
      signals: activeSignals
    };
  }

  function regionBias(video, profileRegion) {
    if (!validRegionCode(profileRegion)) return 0;
    const videoRegion = validRegionCode(video && video.region) || '';
    if (!videoRegion) return 0;
    if (videoRegion === profileRegion) return REGION_BIAS_WEIGHT;
    const sameGroup =
      (profileRegion === 'GB' && videoRegion === 'IE') ||
      (profileRegion === 'IE' && videoRegion === 'GB');
    return sameGroup ? REGION_BIAS_WEIGHT * 0.45 : 0;
  }

  function seededRandom(seed) {
    let value = (number(seed, 1) >>> 0) || 1;
    return function random() {
      value += 0x6D2B79F5;
      let t = value;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function sampleNormal(random) {
    const u = Math.max(random(), 1e-12);
    const v = Math.max(random(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function sampleGamma(shape, random) {
    if (shape < 1) return sampleGamma(shape + 1, random) * Math.pow(random(), 1 / shape);
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    while (true) {
      const x = sampleNormal(random);
      const v = Math.pow(1 + c * x, 3);
      if (v <= 0) continue;
      const u = random();
      if (u < 1 - 0.0331 * Math.pow(x, 4)) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  function betaSample(alpha, beta, random) {
    const a = sampleGamma(Math.max(alpha, 0.1), random);
    const b = sampleGamma(Math.max(beta, 0.1), random);
    return a / (a + b);
  }

  function adaptiveExplorationRate(profile, now) {
    const p = normaliseProfile(profile);
    const totalAffinities = INTEREST_TYPES.reduce((sum, type) => sum + Object.keys(p.interests[type]).length, 0);
    const strongAffinities = INTEREST_TYPES.reduce((sum, type) => sum + Object.values(p.interests[type]).filter(entry => Math.abs(entry.value) > 1.0).length, 0);
    if (totalAffinities < 8) return clamp(EXPLORATION_MAX, EXPLORATION_MIN, EXPLORATION_MAX);
    if (strongAffinities > 25) return clamp(EXPLORATION_MIN, EXPLORATION_MIN, EXPLORATION_MAX);
    const ratio = clamp(strongAffinities / Math.max(1, totalAffinities), 0, 1);
    return clamp(EXPLORATION_MAX - (EXPLORATION_MAX - EXPLORATION_MIN) * ratio, EXPLORATION_MIN, EXPLORATION_MAX);
  }

  function rankCandidates(candidates, inputProfile, options) {
    const profile = normaliseProfile(inputProfile);
    const config = options || {};
    const now = number(config.now, Date.now());
    const limit = clamp(config.limit, 1, 24) || 12;
    const explorationRate = clamp(
      config.explorationRate || adaptiveExplorationRate(profile, now),
      EXPLORATION_MIN,
      EXPLORATION_MAX
    );
    const random = seededRandom(config.seed || now);
    const hidden = new Set(profile.hiddenVideoIds);
    const seen = new Set(profile.seenVideoIds);
    const ids = new Set();

    const scored = (candidates || [])
      .filter(video => video && video.id && isTeenEligible(video) && !hidden.has(String(video.id)) && !seen.has(String(video.id)))
      .filter(video => {
        if (ids.has(String(video.id))) return false;
        ids.add(String(video.id));
        return true;
      })
      .map(video => {
        const engagement = engagementScore(video);
        const freshness = freshnessScore(video, now);
        const affinity = preferenceScore(video, profile, now);
        const regionBoost = regionBias(video, profile.region);
        const views = Math.max(0, metric(video, ['impressions', 'views', 'viewCount']));
        const evidence = clamp(Math.log10(views + 1) * 2.2, 1, 22);
        const sample = betaSample(
          1 + engagement.score * evidence,
          1 + (1 - engagement.score) * evidence,
          random
        );
        const timeAdjustedEngagement = engagement.score * (0.42 + 0.58 * freshness);
        const explorationEligible =
          videoAgeHours(video, now) <= FRESH_VIDEO_HOURS ||
          views < 5000 ||
          sample > 0.62;
        return {
          video,
          engagement,
          freshness,
          affinity,
          regionBoost,
          banditSample: sample,
          isFresh: videoAgeHours(video, now) <= FRESH_VIDEO_HOURS,
          explorationEligible,
          exploitationScore: clamp(
            0.46 * timeAdjustedEngagement +
            0.32 * affinity.score +
            0.12 * freshness +
            0.04 * regionBoost +
            0.06 * sample +
            (affinity.confidence > 0.5 ? 0.02 : 0),
            0, 1
          ),
          explorationScore: clamp(
            0.52 * freshness +
            0.32 * sample +
            0.10 * (1 - affinity.confidence) +
            0.06 * engagement.score,
            0, 1
          )
        };
      });

    const explorationCount = Math.min(
      Math.max(1, Math.round(limit * explorationRate)),
      scored.length
    );
    const explorationPool = scored
      .filter(item => item.explorationEligible)
      .sort((a, b) => b.explorationScore - a.explorationScore);
    const exploration = explorationPool.slice(0, explorationCount);
    const explorationIds = new Set(exploration.map(item => String(item.video.id)));
    const exploitation = scored
      .filter(item => !explorationIds.has(String(item.video.id)))
      .sort((a, b) => b.exploitationScore - a.exploitationScore)
      .slice(0, Math.max(0, limit - exploration.length));

    const merged = exploitation.slice();
    exploration.forEach((item, index) => {
      const spacing = limit / (exploration.length + 1);
      const position = Math.min(merged.length, Math.floor(spacing * (index + 1 + random() * 0.2 - 0.1)));
      merged.splice(Math.max(0, position), 0, item);
    });

    return {
      videos: merged.slice(0, limit).map(item => ({
        ...item.video,
        ranking: {
          lane: explorationIds.has(String(item.video.id)) ? 'explore' : 'exploit',
          score: Number(item.exploitationScore.toFixed(4)),
          engagement: Number(item.engagement.score.toFixed(4)),
          affinity: Number(item.affinity.score.toFixed(4)),
          freshness: Number(item.freshness.toFixed(4))
        }
      })),
      explorationCount: exploration.length,
      exploitationCount: Math.max(0, merged.length - exploration.length),
      explorationRateUsed: explorationRate
    };
  }

  function encodeProfile(profile) {
    const json = JSON.stringify(compactProfile(profile));
    if (typeof Buffer !== 'undefined') return Buffer.from(json, 'utf8').toString('base64url');
    return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function decodeProfile(encoded) {
    if (!encoded || typeof encoded !== 'string') return emptyProfile();
    try {
      let json;
      if (typeof Buffer !== 'undefined') json = Buffer.from(encoded, 'base64url').toString('utf8');
      else {
        const padded = encoded.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((encoded.length + 3) % 4);
        json = decodeURIComponent(escape(atob(padded)));
      }
      return normaliseProfile(JSON.parse(json));
    } catch (error) {
      return emptyProfile();
    }
  }

  function compactProfile(inputProfile) {
    const profile = normaliseProfile(inputProfile);
    for (const type of INTEREST_TYPES) {
      profile.interests[type] = Object.fromEntries(Object.entries(profile.interests[type])
        .sort((a, b) => Math.abs(b[1].value) - Math.abs(a[1].value))
        .slice(0, 25));
    }
    profile.hiddenVideoIds = profile.hiddenVideoIds.slice(-150);
    profile.seenVideoIds = profile.seenVideoIds.slice(-150);
    profile.watchHistory = Object.fromEntries(Object.entries(profile.watchHistory)
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, 80));
    return profile;
  }

  return {
    ENGAGEMENT_WEIGHTS,
    SESSION_WEIGHTS,
    EXPLORATION_RATE,
    EXPLORATION_MIN,
    EXPLORATION_MAX,
    VALID_REGIONS,
    engagementScore,
    freshnessScore,
    extractFeatures,
    isTeenEligible,
    validRegionCode,
    normaliseProfile,
    updateInterestProfile,
    markVideosSeen,
    preferenceScore,
    regionBias,
    adaptiveExplorationRate,
    rankCandidates,
    compactProfile,
    encodeProfile,
    decodeProfile
  };
});
