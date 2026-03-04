// ═══════════════════════════════════════════════════════
// api.js — All external API calls
// SYNAPSE Agent v2 — exponential backoff, large-file retry,
//   extended thinking, attachments, secrets scan, conflict
// ═══════════════════════════════════════════════════════

function estimateTokens(str) { return Math.ceil(((str) || '').length / 4); }
var totalTokensUsed = 0;

// ── Brain complexity scorer ────────────────────────────
function scoreComplexity(msg, history) {
  if (!msg) return 'simple';
  var m = msg.toLowerCase(), len = msg.length;
  var deepPat = [/(code|deploy|debug|fix|build|create|write|generate|analyse|strategy|plan|compare|explain|how does|what should|optimis|improve|review|audit|predict|research)/i, /(github|vercel|supabase|api|function|database|sql|html|css|javascript|python)/i, /(why|how|should i|recommend|advise|best way|complex|thorough)/i];
  for (var i = 0; i < deepPat.length; i++) { if (deepPat[i].test(m)) return 'complex'; }
  if (len > 200) return 'complex';
  if (history.length >= 4) { var rt = history.slice(-4).map(function(h) { return h.content; }).join(' '); if (/code|deploy|debug|build|error|function|strategy|analyse/i.test(rt)) return 'complex'; }
  var simplePat = [/^(hi|hello|hey|thanks|ok|got it|sounds good|yes|no|sure)/i, /^(what is|what's|who is|when|where|show me|list|get|fetch|find)/i];
  for (var j = 0; j < simplePat.length; j++) { if (simplePat[j].test(m)) return 'simple'; }
  return len < 100 ? 'simple' : 'complex';
}

// ── Exponential backoff ────────────────────────────────
async function withBackoff(fn, maxAttempts, label) {
  maxAttempts = maxAttempts || 3;
  var lastErr;
  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return await fn(attempt); }
    catch(err) {
      lastErr = err;
      var isRetryable = err.isQuota || /rate.?limit|429|network|ECONNRESET/i.test(err.message || '');
      if (!isRetryable || attempt === maxAttempts) break;
      var delay = Math.min(1000 * Math.pow(2, attempt - 1) + Math.random() * 300, 12000);
      console.warn('[api] ' + (label || 'call') + ' attempt ' + attempt + ' failed — retrying in ' + Math.round(delay) + 'ms');
      await new Promise(function(r) { setTimeout(r, delay); });
    }
  }
  throw lastErr;
}

// ── Streaming AI call ──────────────────────────────────
async function callAI(userMsg, onChunk, attachments, extendedThinking) {
  var manualBrain = window.get('brain', 'auto');
  var provider;
  if (manualBrain === 'auto' || manualBrain === 'claude') {
    var complexity = scoreComplexity(userMsg, window.getCompactHistory());
    provider = (complexity === 'simple' && !window.isGeminiLimited()) ? 'gemini' : 'claude';
  } else {
    provider = manualBrain;
  }
  if (provider === 'gemini' && window.isGeminiLimited()) { var qe = new Error('quota'); qe.isQuota = true; throw qe; }

  var history = window.getCompactHistory();
  var sys     = window.sysPrompt();
  var est     = estimateTokens(sys) + estimateTokens(userMsg) + history.reduce(function(t, m) { return t + estimateTokens(m.content); }, 0);
  totalTokensUsed += est;
  window._lastTokenEstimate = est;
  window._lastBrainUsed     = provider;
  window._updateTokenBudget && window._updateTokenBudget(est);

  var r = await withBackoff(async function() {
    return fetch('/api/ai', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Token': window.getSessionToken() },
      body:    JSON.stringify({
        provider:         provider,
        systemPrompt:     sys,
        history:          history,
        userMessage:      userMsg,
        attachments:      attachments || [],
        extendedThinking: !!(extendedThinking && provider === 'claude'),
      }),
    });
  }, 3, 'callAI');

  if (!r.ok) {
    var errText = await r.text();
    var errData; try { errData = errText ? JSON.parse(errText) : {}; } catch(ex) { errData = {}; }
    var msg = errData.error || 'HTTP ' + r.status;
    var err = new Error(msg);
    if (r.status === 401) { window.handleSessionExpiry(); err.friendlyHTML = '<strong>Session expired.</strong> Please log in again.'; throw err; }
    err.friendlyHTML = '<strong>Error:</strong> ' + window.esc(msg);
    throw err;
  }

  var reader  = r.body.getReader();
  var decoder = new TextDecoder();
  var buffer  = '', full = '';
  while (true) {
    var result = await reader.read();
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });
    var lines = buffer.split('\n');
    buffer = lines.pop();
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.startsWith('data: ')) continue;
      var raw = line.slice(6).trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        var chunk = JSON.parse(raw);
        if (chunk.error) {
          var cerr = new Error(chunk.error);
          if (/QUOTA|quota/i.test(chunk.error)) cerr.isQuota = true;
          if (/session|unauthorized/i.test(chunk.error)) window.handleSessionExpiry();
          throw cerr;
        }
        if (chunk.t) { full += chunk.t; if (onChunk) onChunk(chunk.t); }
      } catch(parseErr) { if (parseErr.isQuota !== undefined || parseErr.friendlyHTML) throw parseErr; }
    }
  }
  if (!full) throw new Error('Empty response from server.');
  return full;
}

// ── GitHub API with exponential backoff ────────────────
async function githubAPI(payload) {
  return withBackoff(async function(attempt) {
    var r = await fetch('/api/github', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Token': window.getSessionToken() },
      body:    JSON.stringify(payload),
    });
    var text = await r.text();
    var data; try { data = text ? JSON.parse(text) : {}; } catch(e) { throw new Error('GitHub API invalid response: ' + text.slice(0, 120)); }
    if (r.status === 401) { window.handleSessionExpiry(); throw new Error('Session expired.'); }
    if (r.status === 429) { var re = new Error('rate limit'); re.isQuota = true; throw re; }
    if (!r.ok) throw new Error(data.error || 'GitHub HTTP ' + r.status);
    return data;
  }, 3, 'githubAPI:' + (payload.action || ''));
}

// ── Large file push with multi-strategy retry ──────────
// Strategy 1: standard PUT, Strategy 2: blob API
async function pushFileWithRetry(opts) {
  var repo = opts.repo, path = opts.path, content = opts.content, commitMessage = opts.commitMessage, branch = opts.branch || 'main';
  if (!repo || !path || !commitMessage) throw new Error('pushFileWithRetry: repo, path, commitMessage required');

  // Secrets check first
  var scanResult = await githubAPI({ action: 'scanSecrets', content: content });
  if (!scanResult.clean) {
    throw new Error('SECRETS DETECTED: ' + scanResult.secrets.map(function(s) { return s.type; }).join(', ') + '. Push blocked — use env vars.');
  }

  var strategies = [
    {
      name: 'Standard PUT',
      fn: async function() {
        return githubAPI({ action: 'pushFile', repo: repo, branch: branch, path: path, content: content, commitMessage: commitMessage });
      }
    },
    {
      name: 'Git Blob API',
      fn: async function() {
        return githubAPI({ action: 'pushBlob', repo: repo, branch: branch, path: path, content: content, commitMessage: commitMessage });
      }
    },
  ];

  var lastErr;
  for (var s = 0; s < strategies.length; s++) {
    var strategy = strategies[s];
    try {
      window.showStatusExact('Pushing ' + path + ' — ' + strategy.name + ' (attempt ' + (s + 1) + '/' + strategies.length + ')...');
      var result = await strategy.fn();
      if (result.success) {
        window.logAuditEntry({ action: 'push', repo: repo, path: path, sha: result.sha, branch: branch, message: commitMessage });
        return result;
      }
      throw new Error('Push returned success=false');
    } catch(e) {
      lastErr = e;
      console.warn('[pushFileWithRetry] ' + strategy.name + ' failed:', e.message);
      if (s < strategies.length - 1) {
        window.addAI('Attempt ' + (s + 1) + ' failed (' + window.esc(e.message) + ') — trying ' + strategies[s + 1].name + '...');
        await new Promise(function(r) { setTimeout(r, 800); });
      }
    }
  }
  throw new Error('All ' + strategies.length + ' push strategies failed. Last error: ' + (lastErr && lastErr.message));
}

// ── GBP API ────────────────────────────────────────────
async function gbpAPI(payload) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, 15000);
  var r;
  try {
    r = await fetch('/api/gbp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Token': window.getSessionToken() },
      body: JSON.stringify(payload), signal: controller.signal,
    });
  } catch(e) { clearTimeout(timer); if (e.name === 'AbortError') throw new Error('GBP request timed out.'); throw e; }
  clearTimeout(timer);
  var text = await r.text();
  var data; try { data = text ? JSON.parse(text) : {}; } catch(e) { throw new Error('GBP invalid response: ' + text.slice(0, 120)); }
  if (r.status === 401) {
    if (data.needsAuth) {
      var authUrl = window.location.origin + '/api/gbp-auth?user=' + (window.get('userName', 'admin') || 'admin').toLowerCase();
      window.addAI('GBP not connected. <a href="' + authUrl + '" target="_blank" style="color:var(--accent)">Click to connect</a>.');
      return null;
    }
    window.handleSessionExpiry(); throw new Error('Session expired.');
  }
  if (!r.ok) throw new Error(data.error || 'GBP HTTP ' + r.status);
  return data;
}

// ── Sync ───────────────────────────────────────────────
var CLOUD_KEYS = ['userName','about','prefs','learnedFacts','brain','mode','sessions','currentSession','lastWeeklyDigest','weeklyDigest','weeklyDigestDate'];

function syncKeyToCloud(k, v) {
  if (CLOUD_KEYS.indexOf(k) === -1) return;
  if (!window.getSessionToken()) return;
  fetch('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Token': window.getSessionToken() }, body: JSON.stringify({ action: 'set', key: k, value: v }) }).catch(function(e) { console.warn('[sync]', e.message); });
}

async function syncFromCloud() {
  if (!window.getSessionToken()) return;
  try {
    var r = await fetch('/api/sync?keys=' + CLOUD_KEYS.join(','), { headers: { 'X-Agent-Token': window.getSessionToken() } });
    if (!r.ok) return;
    var data = (await r.json()).data || {};
    var m = window.mem(); var updated = false;
    CLOUD_KEYS.forEach(function(k) {
      if (data[k] !== undefined && data[k] !== null) {
        if (k === 'sessions') { var local = m.sessions || [], cloud = data[k] || [], merged = {}; local.concat(cloud).forEach(function(s) { if (!merged[s.id] || s.updatedAt > merged[s.id].updatedAt) merged[s.id] = s; }); m.sessions = Object.values(merged).sort(function(a, b) { return b.updatedAt - a.updatedAt; }).slice(0, 40); }
        else if (k === 'learnedFacts') { m.learnedFacts = [...new Set([...(m.learnedFacts || []), ...(data[k] || [])])].slice(-100); }
        else { m[k] = data[k]; }
        updated = true;
      }
    });
    if (updated) { window.saveMem(m); console.log('[sync] cloud state loaded'); }
  } catch(e) { console.warn('[sync] pull failed:', e.message); }
}

// ── Adaptive learning ──────────────────────────────────
var _adaptiveProfile = null;

async function fetchAdaptiveProfile() {
  if (_adaptiveProfile) return _adaptiveProfile;
  try {
    var r = await fetch('/api/learn', { method: 'GET', headers: { 'X-Agent-Token': window.getSessionToken() } });
    if (!r.ok) return null;
    var data = await r.json();
    _adaptiveProfile = data.profile || null;
    window._adaptiveProfile = _adaptiveProfile;
    return _adaptiveProfile;
  } catch(e) { console.warn('[learn]', e.message); return null; }
}

function logInteraction(userMsg, aiReply, feedback) {
  fetch('/api/learn', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Token': window.getSessionToken() }, body: JSON.stringify({ action: 'log', userMsg: userMsg, aiReply: aiReply, feedback: feedback || 0 }) }).catch(function(e) { console.warn('[learn] log:', e.message); });
}

function maybeRunDailyAnalysis() {
  var now = Date.now(), dayMs = 86400000;
  if (now - window.get('lastLearnRun', 0) < dayMs) return;
  window.set('lastLearnRun', now);
  fetch('/api/learn', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Token': window.getSessionToken() }, body: JSON.stringify({ action: 'analyse' }) }).then(function(r) { return r.json(); }).then(function(d) { if (d.profile) { _adaptiveProfile = d.profile; window._adaptiveProfile = d.profile; } }).catch(function() {});
  var today = new Date().getDay(), lastD = window.get('lastWeeklyDigest', 0);
  if (today === 1 || !lastD || (now - lastD) > 7 * dayMs) {
    window.set('lastWeeklyDigest', now);
    fetch('/api/learn', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Token': window.getSessionToken() }, body: JSON.stringify({ action: 'digest' }) }).then(function(r) { return r.json(); }).then(function(d) { if (d.digest && d.digest.length > 50) { window.set('weeklyDigest', d.digest); window.set('weeklyDigestDate', new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })); if (today === 1) window.showWeeklyDigestInChat && window.showWeeklyDigestInChat(d.digest); } }).catch(function() {});
  }
}

async function fetchAndShowProfileSummary() {
  if (typeof window._renderProfileSummary === 'function') {
    window._renderProfileSummary(async function() {
      var r = await fetch('/api/learn?action=summary', { headers: { 'X-Agent-Token': window.getSessionToken() } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
}

async function fetchAndShowDigest() {
  if (typeof window._renderDigest === 'function') {
    window._renderDigest(async function() {
      var r = await fetch('/api/learn?action=digest', { headers: { 'X-Agent-Token': window.getSessionToken() } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
}

// ── GitHub prefetch ────────────────────────────────────
var REPO_RE   = /repo|repositor|github|my projects?|my sites?|what.*(have|own)|how many/i;
var COMMIT_RE = /commit|commit history|recent changes|what changed|last (push|update)/i;
var FILE_RE   = /(?:read|show|open|view|get|fetch)\s.{1,60}\.(html|css|js|md|json|txt|py)/i;
var _ghCache  = {};
var _repoList = null;

async function cachedGithubAPI(payload) {
  var key = JSON.stringify(payload);
  if (_ghCache[key]) return _ghCache[key];
  var result = await githubAPI(payload);
  _ghCache[key] = result;
  return result;
}

async function ensureRepoList() {
  if (_repoList) return _repoList;
  var data = await cachedGithubAPI({ action: 'listRepos' });
  _repoList = data.repos || [];
  return _repoList;
}

function scoreRepoMatch(repoFullName, text) {
  var name = repoFullName.split('/')[1] || repoFullName, lname = name.toLowerCase(), ltext = text.toLowerCase(), score = 0;
  if (ltext.includes(lname)) return 100;
  name.split(/[-_]/).forEach(function(p) { if (p.length > 2 && ltext.includes(p)) score += 30; });
  return Math.min(score, 99);
}

async function autoDetectRepo(text) {
  if (!/\b(repo|github|commit|deploy|push|file|code|fix|build|branch|project)\b/i.test(text)) return null;
  window.showStatusExact('Checking repos for match...');
  var repos = await ensureRepoList();
  if (!repos.length) return null;
  var best = repos.map(function(r) { return { repo: r, score: scoreRepoMatch(r.name, text) }; }).filter(function(s) { return s.score > 0; }).sort(function(a, b) { return b.score - a.score; })[0];
  if (!best || best.score < 25) return null;
  var currentRepo = window.get('repo1', ''), detected = best.repo.name;
  if (detected === currentRepo) return null;
  window.set('repo1', detected);
  window.set('repo1name', detected.split('/')[1] || detected);
  window.updateStatus();
  Object.keys(_ghCache).forEach(function(k) { if (k.includes(currentRepo)) delete _ghCache[k]; });
  if (typeof window._showRepoSwitchNotice === 'function') window._showRepoSwitchNotice(detected);
  return 'ACTIVE REPO: ' + detected + ' (auto-detected).';
}

async function prefetchGitHub(text) {
  try {
    if (REPO_RE.test(text)) {
      window.showStatusExact('Listing repositories...');
      var repos = await ensureRepoList();
      if (!repos.length) return 'REPOS: none found.';
      return 'REPOS (' + repos.length + '): ' + repos.map(function(r) { return r.name + (r.language ? '[' + r.language + ']' : '') + (r.name === window.get('repo1','') ? '[ACTIVE]' : ''); }).join(', ');
    }
    var switchNotice = await autoDetectRepo(text);
    if (COMMIT_RE.test(text)) {
      var repo = window.get('repo1', '');
      if (!repo) return switchNotice || null;
      window.showStatusExact('Reading commit history from ' + repo + '...');
      var d = await cachedGithubAPI({ action: 'listCommits', repo: repo, limit: 5 });
      if (!d.commits || !d.commits.length) return switchNotice || null;
      return (switchNotice ? switchNotice + ' ' : '') + 'COMMITS: ' + d.commits.map(function(c) { return '[' + c.sha + '] ' + (c.date || '').slice(0, 10) + ': ' + c.message.slice(0, 60); }).join(' | ');
    }
    if (FILE_RE.test(text)) {
      var fm = text.match(/[\w\-./]+\.(html|css|js|md|json|txt|py)/i);
      var repo2 = window.get('repo1', '');
      if (fm && repo2) {
        window.showStatusExact('Reading ' + fm[0] + ' from ' + repo2 + '...');
        var d2 = await cachedGithubAPI({ action: 'getFile', repo: repo2, path: fm[0] });
        if (d2.content) { var cap = d2.content.length > 3000 ? d2.content.slice(0, 3000) + '...[truncated]' : d2.content; return (switchNotice ? switchNotice + '\n' : '') + 'FILE ' + fm[0] + ':\n' + cap; }
      }
      return switchNotice || null;
    }
    return switchNotice || null;
  } catch(e) { return 'GitHub prefetch failed: ' + e.message; }
}

Object.assign(window, {
  estimateTokens, scoreComplexity, callAI, githubAPI, gbpAPI, pushFileWithRetry,
  syncKeyToCloud, syncFromCloud, CLOUD_KEYS,
  _adaptiveProfile, fetchAdaptiveProfile, logInteraction, maybeRunDailyAnalysis,
  fetchAndShowProfileSummary, fetchAndShowDigest,
  prefetchGitHub, cachedGithubAPI, ensureRepoList, _ghCache, _repoList,
});
