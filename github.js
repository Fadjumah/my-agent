export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return res.status(500).json({ error: "GITHUB_TOKEN not configured on server." });
  }

  const GH_HEADERS = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  try {
    const { action } = req.body;

    // ── GET FILE SHA ──────────────────────────────────────────────────────────
    if (action === "getSHA") {
      const { repo, path, branch = "main" } = req.body;
      if (!repo || !path) return res.status(400).json({ error: "repo and path are required" });

      const r = await fetch(
        `https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`,
        { headers: GH_HEADERS }
      );

      if (r.status === 404) return res.status(200).json({ sha: null });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        return res.status(r.status).json({ error: e.message || `GitHub error: HTTP ${r.status}` });
      }

      const data = await r.json();
      return res.status(200).json({ sha: data.sha || null });
    }

    // ── PUSH FILE ─────────────────────────────────────────────────────────────
    if (action === "pushFile") {
      const { repo, branch = "main", path, content, commitMessage } = req.body;
      if (!repo || !path || content === undefined || !commitMessage) {
        return res.status(400).json({ error: "repo, path, content, and commitMessage are required" });
      }

      // Get current SHA first (needed to update existing files)
      let sha = null;
      const shaR = await fetch(
        `https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`,
        { headers: GH_HEADERS }
      );
      if (shaR.ok) {
        const shaData = await shaR.json();
        sha = shaData.sha || null;
      } else if (shaR.status !== 404) {
        const e = await shaR.json().catch(() => ({}));
        return res.status(shaR.status).json({ error: e.message || `GitHub error: HTTP ${shaR.status}` });
      }

      // Build push body
      const body = {
        message: commitMessage,
        content: Buffer.from(content, "utf8").toString("base64"),
        branch,
      };
      if (sha) body.sha = sha;

      const r = await fetch(
        `https://api.github.com/repos/${repo}/contents/${path}`,
        { method: "PUT", headers: GH_HEADERS, body: JSON.stringify(body) }
      );

      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        return res.status(r.status).json({ error: e.message || `GitHub push error: HTTP ${r.status}` });
      }

      const data = await r.json();
      return res.status(200).json({
        success: true,
        sha: data.content?.sha || null,
        url: data.content?.html_url || null,
      });
    }

    // ── LIST REPO FILES ───────────────────────────────────────────────────────
    if (action === "listFiles") {
      const { repo, path = "", branch = "main" } = req.body;
      if (!repo) return res.status(400).json({ error: "repo is required" });

      const r = await fetch(
        `https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`,
        { headers: GH_HEADERS }
      );

      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        return res.status(r.status).json({ error: e.message || `GitHub error: HTTP ${r.status}` });
      }

      const data = await r.json();
      const files = Array.isArray(data)
        ? data.map((f) => ({ name: f.name, path: f.path, type: f.type, size: f.size }))
        : [];
      return res.status(200).json({ files });
    }

    // ── LIST ALL USER REPOS ───────────────────────────────────────────────────
    if (action === "listRepos") {
      const r = await fetch(
        "https://api.github.com/user/repos?per_page=100&sort=updated",
        { headers: GH_HEADERS }
      );
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        return res.status(r.status).json({ error: e.message || `GitHub error: HTTP ${r.status}` });
      }
      const data = await r.json();
      const repos = data.map((r) => ({
        name: r.full_name,
        description: r.description || "",
        private: r.private,
        language: r.language || "",
        updatedAt: r.updated_at,
        url: r.html_url,
        defaultBranch: r.default_branch,
      }));
      return res.status(200).json({ repos, total: repos.length });
    }

    // ── GET REPO INFO ─────────────────────────────────────────────────────────
    if (action === "getRepo") {
      const { repo } = req.body;
      if (!repo) return res.status(400).json({ error: "repo is required" });
      const r = await fetch(
        `https://api.github.com/repos/${repo}`,
        { headers: GH_HEADERS }
      );
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        return res.status(r.status).json({ error: e.message || `GitHub error: HTTP ${r.status}` });
      }
      const d = await r.json();
      return res.status(200).json({
        name: d.full_name, description: d.description, private: d.private,
        language: d.language, stars: d.stargazers_count, forks: d.forks_count,
        defaultBranch: d.default_branch, url: d.html_url,
        createdAt: d.created_at, updatedAt: d.updated_at,
      });
    }

    // ── READ FILE CONTENT ─────────────────────────────────────────────────────
    if (action === "getFile") {
      const { repo, path, branch = "main" } = req.body;
      if (!repo || !path) return res.status(400).json({ error: "repo and path are required" });
      const r = await fetch(
        `https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`,
        { headers: GH_HEADERS }
      );
      if (r.status === 404) return res.status(404).json({ error: `File not found: ${path}` });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        return res.status(r.status).json({ error: e.message || `GitHub error: HTTP ${r.status}` });
      }
      const d = await r.json();
      const content = Buffer.from(d.content, "base64").toString("utf8");
      return res.status(200).json({ path: d.path, content, sha: d.sha, size: d.size, url: d.html_url });
    }

    // ── LIST RECENT COMMITS ───────────────────────────────────────────────────
    if (action === "listCommits") {
      const { repo, branch = "main", limit = 10 } = req.body;
      if (!repo) return res.status(400).json({ error: "repo is required" });
      const r = await fetch(
        `https://api.github.com/repos/${repo}/commits?sha=${branch}&per_page=${limit}`,
        { headers: GH_HEADERS }
      );
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        return res.status(r.status).json({ error: e.message || `GitHub error: HTTP ${r.status}` });
      }
      const data = await r.json();
      const commits = data.map((c) => ({
        sha: c.sha.slice(0, 7),
        message: c.commit.message,
        author: c.commit.author.name,
        date: c.commit.author.date,
        url: c.html_url,
      }));
      return res.status(200).json({ commits });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("GitHub handler error:", err);
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
}
