export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const token = process.env.GITHUB_TOKEN;

  const result = {
    timestamp: new Date().toISOString(),
    checks: {}
  };

  // 1. Check token exists
  result.checks.tokenConfigured = !!token;
  result.checks.tokenPrefix     = token ? token.slice(0, 7) + '...' : 'MISSING';

  if (!token) {
    result.verdict = 'FAIL — GITHUB_TOKEN environment variable is not set in Vercel.';
    return res.status(200).json(result);
  }

  // 2. Call GitHub /user to verify token works
  try {
    const r = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      }
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch(e) { data = { raw: text.slice(0, 300) }; }

    result.checks.githubUserStatus = r.status;
    result.checks.githubLogin      = data.login || null;
    result.checks.githubRateLimit  = r.headers.get('x-ratelimit-remaining') + ' / ' + r.headers.get('x-ratelimit-limit') + ' remaining';
    result.checks.tokenError       = data.message || null;

    if (r.status === 200) {
      // 3. Try listing repos
      const r2 = await fetch('https://api.github.com/user/repos?per_page=5&sort=updated', {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        }
      });
      const text2 = await r2.text();
      let repos;
      try { repos = JSON.parse(text2); } catch(e) { repos = { raw: text2.slice(0,300) }; }

      result.checks.listReposStatus = r2.status;
      result.checks.repoCount       = Array.isArray(repos) ? repos.length : 'error';
      result.checks.firstFewRepos   = Array.isArray(repos) ? repos.map(r => r.full_name) : repos;
      result.verdict = r2.status === 200 ? 'ALL GOOD — GitHub connection is working.' : 'Token authenticates but listing repos failed: ' + (repos.message || r2.status);
    } else {
      result.verdict = 'FAIL — Token rejected by GitHub: ' + (data.message || r.status);
    }
  } catch(e) {
    result.checks.fetchError = e.message;
    result.verdict = 'FAIL — Network error reaching GitHub: ' + e.message;
  }

  return res.status(200).json(result);
}
