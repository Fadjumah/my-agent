// Helper: parse raw JSON body from Vercel's Node.js runtime
async function parseBody(req) {
  return new Promise((resolve, reject) => {
    // Already parsed (e.g. by Vercel's built-in parser in some configs)
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let raw = '';
    req.on('data', chunk => raw += chunk);
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (e) { reject(new Error('Invalid JSON body: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN not configured on server.' });

  const GH = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  let body;
  try { body = await parseBody(req); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const { action } = body;

  try {

    // ── LIST ALL REPOS ────────────────────────────────────────────────────────
    if (action === 'listRepos') {
      const r = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', { headers: GH });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.message || `GitHub HTTP ${r.status}` });
      const repos = data.map(r => ({
        name:          r.full_name,
        description:   r.description || '',
        private:       r.private,
        language:      r.language || '',
        updatedAt:     r.updated_at,
        url:           r.html_url,
        defaultBranch: r.default_branch,
      }));
      return res.status(200).json({ repos, total: repos.length });
    }

    // ── GET REPO INFO ─────────────────────────────────────────────────────────
    if (action === 'getRepo') {
      const { repo } = body;
      if (!repo) return res.status(400).json({ error: 'repo is required' });
      const r = await fetch(`https://api.github.com/repos/${repo}`, { headers: GH });
      const d = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: d.message || `GitHub HTTP ${r.status}` });
      return res.status(200).json({
        name: d.full_name, description: d.description, private: d.private,
        language: d.language, stars: d.stargazers_count, forks: d.forks_count,
        defaultBranch: d.default_branch, url: d.html_url,
        createdAt: d.created_at, updatedAt: d.updated_at,
      });
    }

    // ── LIST FILES IN FOLDER ──────────────────────────────────────────────────
    if (action === 'listFiles') {
      const { repo, path = '', branch = 'main' } = body;
      if (!repo) return res.status(400).json({ error: 'repo is required' });
      const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`, { headers: GH });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.message || `GitHub HTTP ${r.status}` });
      const files = Array.isArray(data)
        ? data.map(f => ({ name: f.name, path: f.path, type: f.type, size: f.size }))
        : [];
      return res.status(200).json({ files });
    }

    // ── READ FILE CONTENT ─────────────────────────────────────────────────────
    if (action === 'getFile') {
      const { repo, path, branch = 'main' } = body;
      if (!repo || !path) return res.status(400).json({ error: 'repo and path are required' });
      const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`, { headers: GH });
      const d = await r.json();
      if (r.status === 404) return res.status(404).json({ error: `File not found: ${path}` });
      if (!r.ok) return res.status(r.status).json({ error: d.message || `GitHub HTTP ${r.status}` });
      const content = Buffer.from(d.content.replace(/\n/g, ''), 'base64').toString('utf8');
      return res.status(200).json({ path: d.path, content, sha: d.sha, size: d.size, url: d.html_url });
    }

    // ── LIST RECENT COMMITS ───────────────────────────────────────────────────
    if (action === 'listCommits') {
      const { repo, branch = 'main', limit = 10 } = body;
      if (!repo) return res.status(400).json({ error: 'repo is required' });
      const r = await fetch(`https://api.github.com/repos/${repo}/commits?sha=${branch}&per_page=${limit}`, { headers: GH });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.message || `GitHub HTTP ${r.status}` });
      const commits = data.map(c => ({
        sha:     c.sha.slice(0, 7),
        message: c.commit.message,
        author:  c.commit.author.name,
        date:    c.commit.author.date,
        url:     c.html_url,
      }));
      return res.status(200).json({ commits });
    }

    // ── GET FILE SHA (internal use for pushFile) ──────────────────────────────
    if (action === 'getSHA') {
      const { repo, path, branch = 'main' } = body;
      if (!repo || !path) return res.status(400).json({ error: 'repo and path are required' });
      const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`, { headers: GH });
      if (r.status === 404) return res.status(200).json({ sha: null });
      const d = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: d.message || `GitHub HTTP ${r.status}` });
      return res.status(200).json({ sha: d.sha || null });
    }

    // ── PUSH / CREATE FILE ────────────────────────────────────────────────────
    if (action === 'pushFile') {
      const { repo, branch = 'main', path, content, commitMessage } = body;
      if (!repo || !path || content === undefined || !commitMessage)
        return res.status(400).json({ error: 'repo, path, content, and commitMessage are required' });

      // Fetch existing SHA (required by GitHub API to update a file)
      let sha = null;
      const shaR = await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`, { headers: GH });
      if (shaR.ok) {
        const shaData = await shaR.json();
        sha = shaData.sha || null;
      } else if (shaR.status !== 404) {
        const e = await shaR.json().catch(() => ({}));
        return res.status(shaR.status).json({ error: e.message || `GitHub HTTP ${shaR.status}` });
      }

      const putBody = {
        message: commitMessage,
        content: Buffer.from(content, 'utf8').toString('base64'),
        branch,
      };
      if (sha) putBody.sha = sha;

      const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
        method: 'PUT', headers: GH, body: JSON.stringify(putBody),
      });
      const d = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: d.message || `GitHub push HTTP ${r.status}` });
      return res.status(200).json({ success: true, sha: d.content?.sha || null, url: d.content?.html_url || null });
    }

    return res.status(400).json({ error: `Unknown action: "${action}"` });

  } catch (err) {
    console.error('GitHub handler error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
