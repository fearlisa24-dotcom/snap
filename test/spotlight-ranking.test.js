const test = require('node:test');
const assert = require('node:assert/strict');
const Ranking = require('../assets/spotlight-ranking');
const spotlightHandler = require('../api/spotlight');

const NOW = Date.parse('2026-09-12T12:00:00.000Z');

function video(id, overrides = {}) {
  return {
    id,
    title: '#cooking Easy pasta',
    description: '#food',
    channel: 'Chef Mina',
    category: 'food',
    audioTrack: 'summer beat',
    duration: 30,
    publishedAt: new Date(NOW - 3600000).toISOString(),
    signals: {
      impressions: 1000,
      watchedPast80Count: 700,
      rewatches: 50,
      likes: 80,
      shares: 20,
      saves: 30,
      comments: 25
    },
    ...overrides
  };
}

test('engagement weights reward completion and high-value actions', () => {
  const strong = Ranking.engagementScore(video('strong'));
  const weak = Ranking.engagementScore(video('weak', {
    signals: { impressions: 1000, watchedPast80Count: 120, likes: 5, shares: 0, saves: 0, comments: 1 }
  }));
  assert.ok(strong.score > weak.score);
  assert.equal(strong.completion, 0.75);
});

test('exponential age decay favors fresh content without zeroing evergreen quality', () => {
  const fresh = video('fresh', { publishedAt: new Date(NOW - 3600000).toISOString() });
  const evergreen = video('evergreen', { publishedAt: new Date(NOW - (60 * 24 * 3600000)).toISOString() });
  const freshScore = Ranking.freshnessScore(fresh, NOW);
  const evergreenScore = Ranking.freshnessScore(evergreen, NOW);
  assert.ok(freshScore > evergreenScore);
  assert.ok(evergreenScore > 0);
});

test('quick swipes immediately filter the exact video and lower its affinities', () => {
  const skipped = video('Skip-CaseSensitive');
  const profile = Ranking.updateInterestProfile(null, skipped, { type: 'skip', watchSeconds: 1.4, wasSwipe: true, at: NOW });
  assert.ok(profile.hiddenVideoIds.includes('Skip-CaseSensitive'));
  assert.ok(profile.interests.categories.food.value < 0);
  const ranked = Ranking.rankCandidates([skipped, video('keep-me')], profile, { now: NOW, limit: 2, seed: 1 });
  assert.deepEqual(ranked.videos.map(item => item.id), ['keep-me']);
});

test('teen feed excludes made-for-kids and clearly child-directed videos', () => {
  const candidates = [
    video('made-for-kids', { madeForKids: true }),
    video('nursery-rhymes', { title: 'Best nursery rhymes for toddlers' }),
    video('teen-safe', { title: '#cooking Fast dinner idea' })
  ];
  const ranked = Ranking.rankCandidates(candidates, null, { now: NOW, limit: 3, seed: 12 });
  assert.deepEqual(ranked.videos.map(item => item.id), ['teen-safe']);
  assert.equal(Ranking.isTeenEligible(candidates[0]), false);
  assert.equal(Ranking.isTeenEligible(candidates[1]), false);
});

test('five-second watches create a preference that improves exploitation rank', () => {
  let profile = Ranking.updateInterestProfile(null, video('food'), { type: 'watch', watchSeconds: 12, duration: 30, at: NOW });
  profile = Ranking.markVideosSeen(profile, [video('food')]);
  const candidates = [
    video('food-next', { category: 'food', title: '#cooking More pasta' }),
    video('sports-next', { category: 'sports', title: '#football Highlights' })
  ];
  const ranked = Ranking.rankCandidates(candidates, profile, { now: NOW, limit: 2, explorationRate: 0.18, seed: 99 });
  const food = ranked.videos.find(item => item.id === 'food-next');
  const sports = ranked.videos.find(item => item.id === 'sports-next');
  assert.ok(food.ranking.score > sports.ranking.score);
});

test('the bandit reserves an approximately 18% exploration lane for fresh videos', () => {
  const candidates = Array.from({ length: 20 }, (_, index) => video(`video-${index}`, {
    publishedAt: new Date(NOW - (index < 6 ? 2 : 240) * 3600000).toISOString()
  }));
  const ranked = Ranking.rankCandidates(candidates, null, { now: NOW, limit: 12, explorationRate: 0.18, seed: 7 });
  assert.equal(ranked.explorationCount, 2);
  assert.equal(ranked.videos.filter(item => item.ranking.lane === 'explore').length, 2);
});

test('profiles round-trip through the compact feed query encoding', () => {
  const profile = Ranking.updateInterestProfile(null, video('round-trip'), { type: 'like', at: NOW });
  const decoded = Ranking.decodeProfile(Ranking.encodeProfile(profile));
  assert.ok(decoded.interests.categories.food.value > 0);
});

test('ranked endpoint returns an opaque cursor and an exploration allocation', async () => {
  const originalFetch = global.fetch;
  const requestedUrls = [];
  global.fetch = async (url) => {
    const requestUrl = String(url);
    requestedUrls.push(requestUrl);
    if (requestUrl.includes('/search')) {
      const isFresh = requestUrl.includes('order=date');
      return {
        ok: true,
        json: async () => ({
          items: [{ id: { videoId: isFresh ? 'freshVideo' : 'popularVideo' } }],
          nextPageToken: isFresh ? 'fresh-next' : 'popular-next'
        })
      };
    }
    const id = new URL(requestUrl).searchParams.get('id');
    return {
      ok: true,
      json: async () => ({
        items: [{
          id,
          snippet: {
            title: '#food Test short',
            channelTitle: 'Test Creator',
            channelId: 'creator-1',
            description: '#cooking',
            publishedAt: new Date(NOW - (id === 'freshVideo' ? 3600000 : 720000000)).toISOString()
          },
          statistics: { viewCount: '1000', likeCount: '100', commentCount: '20' },
          contentDetails: { duration: 'PT30S' }
        }]
      })
    };
  };

  const response = {
    statusCode: 200,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return body; }
  };

  try {
    await spotlightHandler({ method: 'GET', query: { limit: '2' } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.videos.length, 2);
    assert.equal(response.body.exploration.delivered, 1);
    assert.ok(response.body.nextCursor);
    const searchUrls = requestedUrls.filter(url => url.includes('/search'));
    assert.equal(searchUrls.length, 2);
    searchUrls.forEach(url => {
      const params = new URL(url).searchParams;
      assert.equal(params.get('regionCode'), 'GB');
      assert.equal(params.get('relevanceLanguage'), 'en');
    });
  } finally {
    global.fetch = originalFetch;
  }
});
