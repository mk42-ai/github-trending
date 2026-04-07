const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

const GH_TOKEN = process.env.GH_TOKEN || null;

// 5-min cache
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function cacheGet(key) {
  const e = cache.get(key);
  if (!e || Date.now() - e.ts > CACHE_TTL) return null;
  return e.data;
}
function cacheSet(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

// GitHub API helper
async function gh(path, query = {}) {
  const url = new URL(path, 'https://api.github.com');
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const cacheKey = url.toString();
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'AI-Pulse-GitHub-Tool',
  };
  if (GH_TOKEN) headers['Authorization'] = `Bearer ${GH_TOKEN}`;

  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  cacheSet(cacheKey, data);
  return data;
}

// Normalize a repo
function normalizeRepo(r) {
  return {
    name: r.name,
    full_name: r.full_name,
    owner: r.owner?.login,
    owner_avatar: r.owner?.avatar_url,
    description: r.description || '',
    url: r.html_url,
    homepage: r.homepage || null,
    stars: r.stargazers_count,
    forks: r.forks_count,
    watchers: r.watchers_count,
    issues: r.open_issues_count,
    language: r.language,
    topics: r.topics || [],
    license: r.license?.spdx_id || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    pushed_at: r.pushed_at,
    archived: r.archived,
    fork: r.fork,
  };
}

// Format ISO date for GitHub search
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

// ============================================================
// ENDPOINTS
// ============================================================

// GET /github/trending — AI/ML trending repos (search created recently + sort by stars)
app.get('/github/trending', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const limit = Math.min(parseInt(req.query.limit) || 10, 30);
    const topic = req.query.topic || 'ai';
    const since = daysAgo(days);

    // Use GitHub search API: created in last N days, sorted by stars
    const q = `topic:${topic} created:>${since}`;
    const data = await gh('/search/repositories', {
      q,
      sort: 'stars',
      order: 'desc',
      per_page: limit,
    });

    res.json({
      ok: true,
      query: { days, limit, topic },
      total_count: data.total_count,
      count: data.items.length,
      data: data.items.map(normalizeRepo),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /github/trending-ai — curated AI/ML/LLM trending (last 30 days, multiple topics)
app.get('/github/trending-ai', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 30);
    const days = parseInt(req.query.days) || 30;
    const since = daysAgo(days);

    // Search for AI-related repos pushed recently with high stars
    const q = `(topic:llm OR topic:ai-agents OR topic:artificial-intelligence OR topic:machine-learning OR topic:generative-ai) pushed:>${since} stars:>100`;
    const data = await gh('/search/repositories', {
      q,
      sort: 'stars',
      order: 'desc',
      per_page: limit,
    });

    res.json({
      ok: true,
      query: { days, limit },
      total_count: data.total_count,
      count: data.items.length,
      data: data.items.map(normalizeRepo),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /github/most-starred — most starred AI repos all-time
app.get('/github/most-starred', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 30);
    const topic = req.query.topic || 'artificial-intelligence';

    const data = await gh('/search/repositories', {
      q: `topic:${topic}`,
      sort: 'stars',
      order: 'desc',
      per_page: limit,
    });

    res.json({
      ok: true,
      query: { limit, topic },
      total_count: data.total_count,
      count: data.items.length,
      data: data.items.map(normalizeRepo),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /github/repo/:owner/:repo — get details for a specific repo
app.get('/github/repo/:owner/:repo', async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const data = await gh(`/repos/${owner}/${repo}`);
    res.json({
      ok: true,
      data: normalizeRepo(data),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /github/repo/:owner/:repo/stats — extended stats (contributors, releases, recent commits)
app.get('/github/repo/:owner/:repo/stats', async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const [info, contributors, releases, commits] = await Promise.all([
      gh(`/repos/${owner}/${repo}`),
      gh(`/repos/${owner}/${repo}/contributors`, { per_page: 5 }).catch(() => []),
      gh(`/repos/${owner}/${repo}/releases`, { per_page: 3 }).catch(() => []),
      gh(`/repos/${owner}/${repo}/commits`, { per_page: 5 }).catch(() => []),
    ]);

    res.json({
      ok: true,
      data: {
        ...normalizeRepo(info),
        top_contributors: (contributors || []).slice(0, 5).map(c => ({
          login: c.login,
          avatar: c.avatar_url,
          contributions: c.contributions,
        })),
        recent_releases: (releases || []).slice(0, 3).map(r => ({
          name: r.name || r.tag_name,
          tag: r.tag_name,
          published_at: r.published_at,
          url: r.html_url,
        })),
        recent_commits: (commits || []).slice(0, 5).map(c => ({
          sha: c.sha?.substring(0, 7),
          message: c.commit?.message?.split('\n')[0],
          author: c.commit?.author?.name,
          date: c.commit?.author?.date,
        })),
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /github/search — generic repo search
app.get('/github/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    const limit = Math.min(parseInt(req.query.limit) || 10, 30);
    const sort = req.query.sort || 'stars';
    const order = req.query.order || 'desc';
    if (!q) return res.status(400).json({ ok: false, error: 'Missing required query param: q' });

    const data = await gh('/search/repositories', { q, sort, order, per_page: limit });
    res.json({
      ok: true,
      query: { q, limit, sort, order },
      total_count: data.total_count,
      count: data.items.length,
      data: data.items.map(normalizeRepo),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /github/user/:username — public user info + top repos
app.get('/github/user/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const [user, repos] = await Promise.all([
      gh(`/users/${username}`),
      gh(`/users/${username}/repos`, { sort: 'updated', per_page: 10 }).catch(() => []),
    ]);

    res.json({
      ok: true,
      data: {
        login: user.login,
        name: user.name,
        avatar: user.avatar_url,
        bio: user.bio,
        company: user.company,
        location: user.location,
        public_repos: user.public_repos,
        followers: user.followers,
        following: user.following,
        url: user.html_url,
        top_repos: (repos || []).slice(0, 10).map(normalizeRepo),
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /github/health
app.get('/github/health', (req, res) => {
  res.json({
    ok: true,
    service: 'github-trending',
    uptime: process.uptime(),
    cache_size: cache.size,
    has_token: GH_TOKEN !== null,
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`GitHub Trending API running on port ${PORT}`);
  });
}

module.exports = app;
