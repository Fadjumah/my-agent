export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN not configured.' });

  const GH = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // Vercel auto-parses JSON bodies for serverless functions — use req.body directly
  const body = req.body || {};
  const { action } = body;
  if (!action) return res.status(400).json({ error: 'action is required' });

  async function gh(url, opts) {
    const r = await fetch(url, { headers: GH, ...opts });
    const text = await r.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; }
    catch(e) { return [r.status, null, 'GitHub returned non-JSON: ' + text.slice(0,200)]; }
    return [r.status, json, json.message || null];
  }

  try {

    if (action === 'listRepos') {
      const [status, data, errMsg] = await gh('https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner');
      if (status !== 200) return res.status(status).json({ error: errMsg || 'GitHub HTTP ' + status });
      if (!Array.isArray(data)) return res.status(502).json({ error: 'Unexpected response from GitHub' });
      return res.status(200).json({
        repos: data.map(r => ({
          name: r.full_name, description: r.description || '',
          private: r.private, language: r.language || '',
          updatedAt: r.updated_at, url: r.html_url,
          defaultBranch: r.default_branch,
        })),
        total: data.length,
      });
    }

    if (action === 'getRepo') {
      const { repo } = body;
      if (!repo) return res.status(400).json({ error: 'repo is required' });
      const [status, data, errMsg] = await gh(`https://api.github.com/repos/${repo}`);
      if (status !== 200) return res.status(status).json({ error: errMsg || 'GitHub HTTP ' + status });
      return res.status(200).json({
        name: data.full_name, description: data.description, private: data.private,
        language: data.language, stars: data.stargazers_count,
        defaultBranch: data.default_branch, url: data.html_url,
        createdAt: data.created_at, updatedAt: data.updated_at,
      });
    }

    if (action === 'listFiles') {
      const { repo, path = '', branch = 'main' } = body;
      if (!repo) return res.status(400).json({ error: 'repo is required' });
      const [status, data, errMsg] = await gh(`https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`);
      if (status !== 200) return res.status(status).json({ error: errMsg || 'GitHub HTTP ' + status });
      return res.status(200).json({
        files: Array.isArray(data) ? data.map(f => ({ name: f.name, path: f.path, type: f.type, size: f.size })) : []
      });
    }

    if (action === 'getFile') {
      const { repo, path, branch = 'main' } = body;
      if (!repo || !path) return res.status(400).json({ error: 'repo and path are required' });
      const [status, data, errMsg] = await gh(`https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`);
      if (status === 404) return res.status(404).json({ error: 'File not found: ' + path });
      if (status !== 200) return res.status(status).json({ error: errMsg || 'GitHub HTTP ' + status });
      const content = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
      return res.status(200).json({ path: data.path, content, sha: data.sha, size: data.size });
    }

    if (action === 'listCommits') {
      const { repo, branch = 'main', limit = 10 } = body;
      if (!repo) return res.status(400).json({ error: 'repo is required' });
      const [status, data, errMsg] = await gh(`https://api.github.com/repos/${repo}/commits?sha=${branch}&per_page=${limit}`);
      if (status !== 200) return res.status(status).json({ error: errMsg || 'GitHub HTTP ' + status });
      if (!Array.isArray(data)) return res.status(502).json({ error: 'Unexpected commits response' });
      return res.status(200).json({
        commits: data.map(c => ({
          sha: c.sha.slice(0, 7), message: c.commit.message,
          author: c.commit.author.name, date: c.commit.author.date,
        }))
      });
    }

    if (action === 'pushFile') {
      const { repo, branch = 'main', path, content, commitMessage } = body;
      if (!repo || !path || content === undefined || !commitMessage)
        return res.status(400).json({ error: 'repo, path, content, commitMessage are required' });

      // Get existing SHA
      let sha = null;
      const [shaStatus, shaData] = await gh(`https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`);
      if (shaStatus === 200 && shaData) sha = shaData.sha || null;

      const putBody = { message: commitMessage, content: Buffer.from(content, 'utf8').toString('base64'), branch };
      if (sha) putBody.sha = sha;

      const [status, data, errMsg] = await gh(`https://api.github.com/repos/${repo}/contents/${path}`, {
        method: 'PUT', body: JSON.stringify(putBody),
      });
      if (status !== 200 && status !== 201) return res.status(status).json({ error: errMsg || 'Push failed: HTTP ' + status });
      return res.status(200).json({ success: true, sha: data.content?.sha || null, url: data.content?.html_url || null });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (err) {
    console.error('GitHub handler error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
