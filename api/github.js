import { verifyToken } from './auth.js';

function authenticate(req, res) {
  const apiKey = process.env.AGENT_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'AGENT_API_KEY not set in Vercel.' }); return false; }
  const token = req.headers['x-agent-token'] || '';
  if (!verifyToken(token, apiKey)) {
    res.status(401).json({ error: 'Unauthorized. Session invalid or expired — please log in again.' });
    return false;
  }
  return true;
}

// ── Secrets scanner ────────────────────────────────────────────────────────────
const SECRET_PATTERNS = [
  { name: 'Generic API Key',     re: /(?:api[_-]?key|apikey)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{20,}/gi },
  { name: 'Private Key',         re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'AWS Access Key',      re: /AKIA[0-9A-Z]{16}/g },
  { name: 'GitHub Token',        re: /gh[pousr]_[A-Za-z0-9_]{36,}/g },
  { name: 'Hardcoded Password',  re: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{6,}['"]/gi },
  { name: 'Bearer Token',        re: /bearer\s+[A-Za-z0-9_\-\.]{20,}/gi },
  { name: 'Supabase JWT',        re: /eyJ[A-Za-z0-9_\-]{50,}\.[A-Za-z0-9_\-]{50,}/g },
  { name: 'Anthropic Key',       re: /sk-ant-[A-Za-z0-9_\-]{40,}/g },
  { name: 'OpenAI Key',          re: /sk-[A-Za-z0-9]{40,}/g },
  { name: 'Google API Key',      re: /AIza[0-9A-Za-z_\-]{35}/g },
];

// Allowlist patterns — things that look like secrets but are safe
const SECRET_ALLOWLIST = [
  /process\.env\./,      // env var reference
  /\$\{.*?\}/,           // template literal env ref
  /placeholder/i,
  /your[_-]?key/i,
  /example/i,
  /xxx+/i,
  /\*{4,}/,              // masked value
];

function scanSecrets(content, filename) {
  const found = [];
  const lines = content.split('\n');

  for (const pat of SECRET_PATTERNS) {
    const matches = content.match(new RegExp(pat.re.source, 'gi'));
    if (!matches) continue;
    for (const match of matches) {
      // Check allowlist — skip safe patterns
      const isSafe = SECRET_ALLOWLIST.some(al => al.test(match));
      if (isSafe) continue;
      // Find line number
      let lineNo = 1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(match.slice(0, 20))) { lineNo = i + 1; break; }
      }
      found.push({ type: pat.name, line: lineNo, preview: match.slice(0, 30) + '...' });
    }
  }
  return found;
}

// ── Simple line diff (added/removed) ────────────────────────────────────────────
function computeLineDiff(oldContent, newContent) {
  if (!oldContent) {
    const lines = newContent.split('\n').slice(0, 40);
    return lines.map(l => ({ type: 'add', text: l }));
  }
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  // Simple LCS-based diff (trimmed to first 60 changed lines for performance)
  const diff = [];
  const maxOld = Math.min(oldLines.length, 200);
  const maxNew = Math.min(newLines.length, 200);

  let oi = 0, ni = 0;
  while (oi < maxOld || ni < maxNew) {
    if (diff.length > 80) { diff.push({ type: 'info', text: '... diff truncated ...' }); break; }
    if (oi >= maxOld) { diff.push({ type: 'add', text: newLines[ni++] }); continue; }
    if (ni >= maxNew) { diff.push({ type: 'del', text: oldLines[oi++] }); continue; }
    if (oldLines[oi] === newLines[ni]) {
      diff.push({ type: 'ctx', text: newLines[ni] });
      oi++; ni++;
    } else {
      // Look ahead up to 3 lines for a match
      let matched = false;
      for (let skip = 1; skip <= 3; skip++) {
        if (oi + skip < maxOld && oldLines[oi + skip] === newLines[ni]) {
          for (let s = 0; s < skip; s++) diff.push({ type: 'del', text: oldLines[oi++] });
          matched = true; break;
        }
        if (ni + skip < maxNew && newLines[ni + skip] === oldLines[oi]) {
          for (let s = 0; s < skip; s++) diff.push({ type: 'add', text: newLines[ni++] });
          matched = true; break;
        }
      }
      if (!matched) {
        diff.push({ type: 'del', text: oldLines[oi++] });
        diff.push({ type: 'add', text: newLines[ni++] });
      }
    }
  }
  // Compact — remove long ctx runs (keep 2 ctx lines around changes)
  return diff.filter((d, i, arr) => {
    if (d.type !== 'ctx') return true;
    const prevChange = arr.slice(Math.max(0, i-3), i).some(x => x.type !== 'ctx');
    const nextChange = arr.slice(i+1, Math.min(arr.length, i+4)).some(x => x.type !== 'ctx');
    return prevChange || nextChange;
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Agent-Token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });
  if (!authenticate(req, res)) return;

  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) return res.status(500).json({ error: 'GITHUB_TOKEN not configured.' });

  const GH = {
    Authorization: `Bearer ${ghToken}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  const body = req.body || {};
  const { action } = body;
  if (!action) return res.status(400).json({ error: 'action is required' });

  // ── GitHub fetch with exponential backoff retry ──────────────────────────
  async function gh(url, opts = {}, maxRetries = 3) {
    let lastStatus, lastData, lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(Math.pow(2, attempt - 1) * 1000, 8000);
        await new Promise(r => setTimeout(r, delay));
      }
      const r = await fetch(url, { headers: GH, ...opts });
      const text = await r.text();
      let json;
      try { json = text ? JSON.parse(text) : {}; }
      catch(e) { return [r.status, null, 'Non-JSON from GitHub: ' + text.slice(0, 200)]; }

      lastStatus = r.status;
      lastData   = json;
      lastErr    = json.message || null;

      // Retry on rate limit or server error
      if (r.status === 429 || r.status === 503) continue;
      if (r.status >= 500 && attempt < maxRetries) continue;

      // Rate limit via header
      if (r.status === 403 && json.message?.includes('rate limit')) {
        const reset = r.headers.get('X-RateLimit-Reset');
        const wait  = reset ? Math.min((parseInt(reset) * 1000) - Date.now(), 30000) : 5000;
        if (attempt < maxRetries) { await new Promise(r2 => setTimeout(r2, wait)); continue; }
      }

      return [r.status, json, lastErr];
    }
    return [lastStatus, lastData, lastErr || 'GitHub request failed after retries'];
  }

  // ── Large file push via blob/tree/commit API ────────────────────────────
  async function pushLargeFile(repo, branch, path, content, commitMessage) {
    // Step 1: Get current branch ref
    const [rs, rd] = await gh(`https://api.github.com/repos/${repo}/git/refs/heads/${branch}`);
    if (rs !== 200) throw new Error('Could not get branch ref: ' + (rd?.message || rs));
    const latestCommitSha = rd.object.sha;

    // Step 2: Get commit tree SHA
    const [cs, cd] = await gh(`https://api.github.com/repos/${repo}/git/commits/${latestCommitSha}`);
    if (cs !== 200) throw new Error('Could not get commit: ' + (cd?.message || cs));
    const baseTreeSha = cd.tree.sha;

    // Step 3: Create blob
    const [bs, bd] = await gh(`https://api.github.com/repos/${repo}/git/blobs`, {
      method: 'POST',
      body:   JSON.stringify({ content, encoding: 'utf-8' }),
    });
    if (bs !== 201) throw new Error('Blob creation failed: ' + (bd?.message || bs));
    const blobSha = bd.sha;

    // Step 4: Create new tree
    const [ts, td] = await gh(`https://api.github.com/repos/${repo}/git/trees`, {
      method: 'POST',
      body:   JSON.stringify({
        base_tree: baseTreeSha,
        tree: [{ path, mode: '100644', type: 'blob', sha: blobSha }],
      }),
    });
    if (ts !== 201) throw new Error('Tree creation failed: ' + (td?.message || ts));
    const newTreeSha = td.sha;

    // Step 5: Create commit
    const [cms, cmd] = await gh(`https://api.github.com/repos/${repo}/git/commits`, {
      method: 'POST',
      body:   JSON.stringify({ message: commitMessage, tree: newTreeSha, parents: [latestCommitSha] }),
    });
    if (cms !== 201) throw new Error('Commit creation failed: ' + (cmd?.message || cms));
    const newCommitSha = cmd.sha;

    // Step 6: Update ref
    const [us, ud] = await gh(`https://api.github.com/repos/${repo}/git/refs/heads/${branch}`, {
      method: 'PATCH',
      body:   JSON.stringify({ sha: newCommitSha, force: false }),
    });
    if (us !== 200) throw new Error('Ref update failed: ' + (ud?.message || us));

    return { sha: newCommitSha, url: `https://github.com/${repo}/commit/${newCommitSha}` };
  }

  try {

    // ── listRepos ────────────────────────────────────────────────────────────
    if (action === 'listRepos') {
      const [status, data, errMsg] = await gh('https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner');
      if (status !== 200) return res.status(status).json({ error: errMsg || 'GitHub HTTP ' + status });
      if (!Array.isArray(data)) return res.status(502).json({ error: 'Unexpected GitHub response' });
      return res.status(200).json({
        repos: data.map(r => ({
          name: r.full_name, description: r.description || '',
          private: r.private, language: r.language || '',
          updatedAt: r.updated_at, url: r.html_url, defaultBranch: r.default_branch,
        })),
        total: data.length,
      });
    }

    // ── getRepo ─────────────────────────────────────────────────────────────
    if (action === 'getRepo') {
      const { repo } = body;
      if (!repo) return res.status(400).json({ error: 'repo is required' });
      const [status, data, errMsg] = await gh(`https://api.github.com/repos/${repo}`);
      if (status !== 200) return res.status(status).json({ error: errMsg || 'GitHub HTTP ' + status });
      return res.status(200).json({
        name: data.full_name, description: data.description, private: data.private,
        language: data.language, stars: data.stargazers_count, defaultBranch: data.default_branch,
        url: data.html_url, createdAt: data.created_at, updatedAt: data.updated_at,
      });
    }

    // ── listFiles ────────────────────────────────────────────────────────────
    if (action === 'listFiles') {
      const { repo, path = '', branch = 'main' } = body;
      if (!repo) return res.status(400).json({ error: 'repo is required' });
      const [status, data, errMsg] = await gh(`https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`);
      if (status !== 200) return res.status(status).json({ error: errMsg || 'GitHub HTTP ' + status });
      return res.status(200).json({
        files: Array.isArray(data) ? data.map(f => ({ name: f.name, path: f.path, type: f.type, size: f.size })) : [],
      });
    }

    // ── getFile ──────────────────────────────────────────────────────────────
    if (action === 'getFile') {
      const { repo, path, branch = 'main' } = body;
      if (!repo || !path) return res.status(400).json({ error: 'repo and path are required' });
      const [status, data, errMsg] = await gh(`https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`);
      if (status === 404) return res.status(404).json({ error: 'File not found: ' + path });
      if (status !== 200) return res.status(status).json({ error: errMsg || 'GitHub HTTP ' + status });
      const content = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
      return res.status(200).json({ path: data.path, content, sha: data.sha, size: data.size });
    }

    // ── listCommits ──────────────────────────────────────────────────────────
    if (action === 'listCommits') {
      const { repo, branch = 'main', limit = 10 } = body;
      if (!repo) return res.status(400).json({ error: 'repo is required' });
      const [status, data, errMsg] = await gh(`https://api.github.com/repos/${repo}/commits?sha=${branch}&per_page=${limit}`);
      if (status !== 200) return res.status(status).json({ error: errMsg || 'GitHub HTTP ' + status });
      if (!Array.isArray(data)) return res.status(502).json({ error: 'Unexpected commits response' });
      return res.status(200).json({
        commits: data.map(c => ({
          sha: c.sha.slice(0, 7), fullSha: c.sha,
          message: c.commit.message, author: c.commit.author.name, date: c.commit.author.date,
          url: c.html_url,
        })),
      });
    }

    // ── pushFile — with secrets scan, conflict detection, diff, audit ──────
    if (action === 'pushFile') {
      const { repo, branch = 'main', path, content, commitMessage, skipSecretsCheck = false } = body;
      if (!repo || !path || content === undefined || !commitMessage)
        return res.status(400).json({ error: 'repo, path, content, commitMessage are required' });

      // 1. Secrets scan
      if (!skipSecretsCheck) {
        const secrets = scanSecrets(content, path);
        if (secrets.length > 0) {
          return res.status(400).json({
            error: 'SECRETS_DETECTED',
            secrets,
            message: 'Push aborted: ' + secrets.length + ' potential secret(s) found in ' + path + '. Review before committing.',
          });
        }
      }

      // 2. Get current file SHA + content for diff + conflict detection
      let previousSha  = null;
      let previousContent = null;
      const [shaStatus, shaData] = await gh(`https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`);
      if (shaStatus === 200 && shaData) {
        previousSha     = shaData.sha || null;
        try { previousContent = Buffer.from(shaData.content.replace(/\n/g, ''), 'base64').toString('utf8'); }
        catch(e) { previousContent = null; }
      }

      // 3. Compute diff (trimmed for large files)
      const diff = computeLineDiff(previousContent, content);

      // 4. Try direct push first
      let pushResult = null;
      let usedBlobApi = false;

      const putBody = { message: commitMessage, content: Buffer.from(content, 'utf8').toString('base64'), branch };
      if (previousSha) putBody.sha = previousSha;

      const [status, data, errMsg] = await gh(
        `https://api.github.com/repos/${repo}/contents/${path}`,
        { method: 'PUT', body: JSON.stringify(putBody) }
      );

      if (status === 200 || status === 201) {
        pushResult = { sha: data.content?.sha || null, commitSha: data.commit?.sha, url: data.content?.html_url };
      } else if (status === 409 || (errMsg && errMsg.includes('sha'))) {
        // Conflict — remote changed; report back
        return res.status(409).json({
          error: 'CONFLICT',
          message: 'The remote file has changed since you last read it. Fetch the latest version before pushing.',
          remoteModified: true,
        });
      } else if (content.length > 400000 || status === 422) {
        // File too large for contents API — use blob/tree approach
        try {
          usedBlobApi = true;
          const r = await pushLargeFile(repo, branch, path, content, commitMessage);
          pushResult = { sha: null, commitSha: r.sha, url: r.url };
        } catch(blobErr) {
          return res.status(500).json({ error: 'Push failed (blob API): ' + blobErr.message });
        }
      } else {
        return res.status(status).json({ error: errMsg || 'Push failed HTTP ' + status });
      }

      // 5. Build audit entry
      const auditEntry = {
        id:          Date.now(),
        timestamp:   new Date().toISOString(),
        repo,
        branch,
        path,
        commitMessage,
        commitSha:   pushResult.commitSha || null,
        previousSha,
        url:         pushResult.url || `https://github.com/${repo}/blob/${branch}/${path}`,
        usedBlobApi,
        linesAdded:  diff.filter(d => d.type === 'add').length,
        linesRemoved: diff.filter(d => d.type === 'del').length,
      };

      return res.status(200).json({
        success: true,
        sha:      pushResult.sha,
        commitSha: pushResult.commitSha,
        url:       pushResult.url,
        previousSha,
        diff,
        auditEntry,
        usedBlobApi,
      });
    }

    // ── revertFile — restore file to a previous commit ───────────────────────
    if (action === 'revertFile') {
      const { repo, path, commitSha, branch = 'main' } = body;
      if (!repo || !path || !commitSha) return res.status(400).json({ error: 'repo, path, commitSha required' });

      // Get file at target commit
      const [fs, fd, fe] = await gh(`https://api.github.com/repos/${repo}/contents/${path}?ref=${commitSha}`);
      if (fs !== 200) return res.status(fs).json({ error: fe || 'File not found at that commit' });
      const content = Buffer.from(fd.content.replace(/\n/g, ''), 'base64').toString('utf8');

      // Push it back
      const [csha] = await gh(`https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`);
      let currentSha = null;
      if (csha === 200) currentSha = fd.sha;

      const putBody = {
        message: `revert: restore ${path} to ${commitSha.slice(0, 7)}`,
        content: Buffer.from(content, 'utf8').toString('base64'),
        branch,
      };
      if (currentSha) putBody.sha = currentSha;

      const [ps, pd, pe] = await gh(
        `https://api.github.com/repos/${repo}/contents/${path}`,
        { method: 'PUT', body: JSON.stringify(putBody) }
      );
      if (ps !== 200 && ps !== 201) return res.status(ps).json({ error: pe || 'Revert push failed' });

      return res.status(200).json({
        success: true, revertedTo: commitSha.slice(0, 7),
        newCommitSha: pd.commit?.sha, url: pd.content?.html_url,
      });
    }

    // ── scanSecrets — scan a file or content for secrets ────────────────────
    if (action === 'scanSecrets') {
      const { repo, path, content, branch = 'main' } = body;
      let contentToScan = content;
      let filename      = path || 'unknown';

      if (!contentToScan && repo && path) {
        const [fs, fd, fe] = await gh(`https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`);
        if (fs !== 200) return res.status(fs).json({ error: fe });
        contentToScan = Buffer.from(fd.content.replace(/\n/g, ''), 'base64').toString('utf8');
      }
      if (!contentToScan) return res.status(400).json({ error: 'content or repo+path required' });

      const found = scanSecrets(contentToScan, filename);
      return res.status(200).json({ clean: found.length === 0, secrets: found, file: filename });
    }

    // ── getDiff — compare two refs for a file ────────────────────────────────
    if (action === 'getDiff') {
      const { repo, path, base, head = 'main' } = body;
      if (!repo || !path || !base) return res.status(400).json({ error: 'repo, path, base required' });

      const [os, od] = await gh(`https://api.github.com/repos/${repo}/contents/${path}?ref=${base}`);
      const [ns, nd] = await gh(`https://api.github.com/repos/${repo}/contents/${path}?ref=${head}`);

      const oldContent = os === 200 ? Buffer.from(od.content.replace(/\n/g, ''), 'base64').toString('utf8') : null;
      const newContent = ns === 200 ? Buffer.from(nd.content.replace(/\n/g, ''), 'base64').toString('utf8') : null;

      if (!oldContent && !newContent) return res.status(404).json({ error: 'File not found at either ref' });
      const diff = computeLineDiff(oldContent, newContent);
      return res.status(200).json({ diff, base, head, path });
    }

    // ── getAuditLog — last N commits with metadata ───────────────────────────
    if (action === 'getAuditLog') {
      const { repo, limit = 20, branch = 'main' } = body;
      if (!repo) return res.status(400).json({ error: 'repo required' });
      const [s, d, e] = await gh(`https://api.github.com/repos/${repo}/commits?sha=${branch}&per_page=${limit}`);
      if (s !== 200) return res.status(s).json({ error: e });
      return res.status(200).json({
        log: d.map(c => ({
          sha:     c.sha.slice(0, 7),
          fullSha: c.sha,
          message: c.commit.message,
          author:  c.commit.author.name,
          date:    c.commit.author.date,
          url:     c.html_url,
          files:   c.files?.map(f => f.filename) || [],
        })),
      });
    }

    // ── analyzeImpact — list files changed in last N commits ─────────────────
    if (action === 'analyzeImpact') {
      const { repo, path, branch = 'main' } = body;
      if (!repo) return res.status(400).json({ error: 'repo required' });

      const filter = path ? `?path=${encodeURIComponent(path)}&sha=${branch}&per_page=10` : `?sha=${branch}&per_page=5`;
      const [s, d] = await gh(`https://api.github.com/repos/${repo}/commits${filter}`);
      if (s !== 200) return res.status(s).json({ error: 'Could not fetch commits' });

      const details = await Promise.all(d.slice(0, 5).map(async c => {
        const [ds, dd] = await gh(`https://api.github.com/repos/${repo}/commits/${c.sha}`);
        return {
          sha:     c.sha.slice(0, 7),
          message: c.commit.message.slice(0, 100),
          date:    c.commit.author.date,
          files:   ds === 200 ? (dd.files || []).map(f => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })) : [],
        };
      }));

      return res.status(200).json({ impact: details });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
