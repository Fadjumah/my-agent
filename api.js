// ═══════════════════════════════════════════════════════
// api.js — All external API calls
// SYNAPSE Agent
// No DOM manipulation in this file. Pure data in/out.
// ═══════════════════════════════════════════════════════

// ── Token estimation ───────────────────────────────────
function estimateTokens(str) {
  return Math.ceil(((str) || '').length / 4);
}

var totalTokensUsed = 0;

// ── Brain complexity scorer ────────────────────────────
// Returns 'simple' or 'complex' — drives auto brain selection
function scoreComplexity(msg, history) {
  if (!msg) return 'simple';
  var m   = msg.toLowerCase();
  var len = msg.length;

  var deepPatterns = [
    /(code|deploy|debug|fix the|error|build|create|write|generate|analyse|analysis|strategy|plan|compare|explain why|how does|what should|optimis|improve|review|audit|diagnosis|predict|research)/i,
    /(github|vercel|supabase|api|function|database|sql|html|css|javascript|python)/i,
    /(why|how|should i|what do you think|recommend|advise|best way|complex|difficult|thorough)/i,
  ];
  for (var i = 0; i < deepPatterns.length; i++) {
    if (deepPatterns[i].test(m)) return 'complex';
  }

  if (len > 200) return 'complex';

  if (history.length >= 4) {
    var recentText = history.slice(-4).map(function(h) { return h.content; }).join(' ');
    if (/code|deploy|debug|build|error|function|strategy|analyse/i.test(recentText)) return 'complex';
  }

  var simplePatterns = [
    /^(hi|hello|hey|thanks|thank you|ok|got it|sounds good|nice|great|perfect|yes|no|sure)/i,
    /^(what is|what's|who is|when|where|show me|list|get|fetch|find)/i,
    /^(what time|what day|what date|remind|schedule)/i,
  ];
  for (var j = 0; j < simplePatterns.length; j++) {
    if (simplePatterns[j].test(m)) return 'simple';
  }

  return len < 100 ? 'simple' : 'complex';
}

// ── Streaming AI call ──────────────────────────────────
// Returns the full accumulated text when the stream ends.
// Calls onChunk(text) with each incremental piece for live rendering.
async function callAI(userMsg, onChunk) {
  var manualBrain = window.get('brain', 'auto');
  var provider;

  if (manualBrain === 'auto' || manualBrain === 'claude') {
    var complexity = scoreComplexity(userMsg, window.getCompactHistory());
    if (complexity === 'simple' && !window.isGeminiLimited()) {
      provider = 'gemini';
      console.log('[brain] auto→gemini (simple)');
    } else {
      provider = 'claude';
      console.log('[brain] auto→claude (complex)');
    }
  } else {
    provider = manualBrain;
  }

  var history = window.getCompactHistory();
  if (provider === 'gemini' && window.isGeminiLimited()) {
    var e = new Error('quota');
    e.isQuota = true;
    throw e;
  }

  var sys = window.sysPrompt();
  var est = estimateTokens(sys) + estimateTokens(userMsg)
    + history.reduce(function(t, m) { return t + estimateTokens(m.content); }, 0);
  totalTokensUsed += est;
  console.log('[tokens] est input:', est, '| session total:', totalTokensUsed);

  window._lastBrainUsed = provider;

  var r = await fetch('/api/ai', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Token': window.getSessionToken() },
    body:    JSON.stringify({ provider: provider, systemPrompt: sys, history: history, userMessage: userMsg }),
  });

  if (!r.ok) {
    var errText = await r.text();
    var errData;
    try { errData = errText ? JSON.parse(errText) : {}; } catch(ex) { errData = {}; }
    var msg = errData.error || 'HTTP ' + r.status;
    var err = new Error(msg);
    if (r.status === 401) {
      window.handleSessionExpiry();
      err.friendlyHTML = '<strong>Session expired.</strong> Please log in again.';
      throw err;
    }
    err.friendlyHTML = '<strong>Error:</strong> ' + window.esc(msg);
    throw err;
  }

  // Read SSE stream
  var reader  = r.body.getReader();
  var decoder = new TextDecoder();
  var buffer  = '';
  var full    = '';

  while (true) {
    var result = await reader.read();
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });

    var lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.startsWith('data: ')) continue;
      var raw = line.slice(6).trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        var chunk = JSON.parse(raw);
        if (chunk.error) {
          var cerr = new Error(chunk.error);
          if (chunk.error.startsWith('QUOTA:') || chunk.error.toLowerCase().includes('quota')) {
            cerr.isQuota = true;
          }
          if (chunk.error.toLowerCase().includes('session') || chunk.error.toLowerCase().includes('unauthorized')) {
            window.handleSessionExpiry();
          }
          throw cerr;
        }
        if (chunk.t) {
          full += chunk.t;
          if (onChunk) onChunk(chunk.t);
        }
      } catch(parseErr) {
        if (parseErr.isQuota !== undefined || parseErr.friendlyHTML) throw parseErr;
        // skip malformed chunk
      }
    }
  }

  if (!full) throw new Error('Empty response from server.');
  return full;
}

// ── GitHub API ─────────────────────────────────────────
async function githubAPI(payload) {
  var r = await fetch('/api/github', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Token': window.getSessionToken() },
    body:    JSON.stringify(payload),
  });
  var text = await r.text();
  var data;
  try { data = text ? JSON.parse(text) : {}; }
  catch(e) { throw new Error('GitHub API invalid response: ' + text.slice(0, 120)); }
  if (r.status === 401) { window.handleSessionExpiry(); throw new Error('Session expired — please log in again.'); }
  if (!r.ok) throw new Error(data.error || 'GitHub HTTP ' + r.status);
  return data;
}

// ── GBP API ────────────────────────────────────────────
async function gbpAPI(payload) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, 15000);
  var r;
  try {
    r = await fetch('/api/gbp', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Token': window.getSessionToken() },
      body:    JSON.stringify(payload),
      signal:  controller.signal,
    });
  } catch(e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('GBP request timed out after 15s. Check your connection and try again.');
    throw e;
  }
  clearTimeout(timer);
  var text = await r.text();
  var data;
  try { data = text ? JSON.parse(text) : {}; }
  catch(e) { throw new Error('GBP API invalid response: ' + text.slice(0, 120)); }
  if (r.status === 401) {
    if (data.needsAuth) {
      var authUrl = window.location.origin + '/api/gbp-auth?user=' + (window.get('userName', 'admin') || 'admin').toLowerCase();
      window.addAI('Your Google Business Profile is not connected yet. <a href="' + authUrl + '" target="_blank" style="color:var(--accent)">Click here to connect it</a> — it takes 30 seconds.');
      return null;
    }
    window.handleSessionExpiry();
    throw new Error('Session expired.');
  }
  if (!r.ok) throw new Error(data.error || 'GBP HTTP ' + r.status);
  return data;
}

// ── Sync API ───────────────────────────────────────────
var CLOUD_KEYS = ['userName','about','prefs','learnedFacts','brain','mode',
                  'sessions','currentSession','lastWeeklyDigest','weeklyDigest','weeklyDigestDate'];

function syncKeyToCloud(k, v) {
  if (CLOUD_KEYS.indexOf(k) === -1) return;
  if (!window.getSessionToken()) return;
  fetch('/api/sync', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Token': window.getSessionToken() },
    body:    JSON.stringify({ action: 'set', key: k, value: v }),
  }).catch(function(e) { console.warn('[sync] set failed:', e.message); });
}

async function syncFromCloud() {
  if (!window.getSessionToken()) return;
  try {
    var r = await fetch('/api/sync?keys=' + CLOUD_KEYS.join(','), {
      headers: { 'X-Agent-Token': window.getSessionToken() },
    });
    if (!r.ok) return;
    var data = (await r.json()).data || {};
    var m = window.mem();
    var updated = false;
    CLOUD_KEYS.forEach(function(k) {
      if (data[k] !== undefined && data[k] !== null) {
        if (k === 'sessions') {
          var local  = m.sessions || [];
          var cloud  = data[k] || [];
          var merged = {};
          local.concat(cloud).forEach(function(s) {
            if (!merged[s.id] || s.updatedAt > merged[s.id].updatedAt) merged[s.id] = s;
          });
          m.sessions = Object.values(merged)
            .sort(function(a, b) { return b.updatedAt - a.updatedAt; })
            .slice(0, 40);
        } else if (k === 'learnedFacts') {
          var lf = m.learnedFacts || [];
          var cf = data[k] || [];
          m.learnedFacts = [...new Set([...lf, ...cf])].slice(-100);
        } else {
          m[k] = data[k];
        }
        updated = true;
      }
    });
    if (updated) { window.saveMem(m); console.log('[sync] cloud state loaded'); }
  } catch(e) { console.warn('[sync] pull failed:', e.message); }
}

// ── Adaptive Learning API ──────────────────────────────
var _adaptiveProfile = null;
var _lastLearnCheck  = 0;

async function fetchAdaptiveProfile() {
  if (_adaptiveProfile) return _adaptiveProfile;
  try {
    var r = await fetch('/api/learn', {
      method: 'GET',
      headers: { 'X-Agent-Token': window.getSessionToken() },
    });
    if (!r.ok) return null;
    var data = await r.json();
    _adaptiveProfile = data.profile || null;
    _lastLearnCheck  = data.lastLearn || 0;
    return _adaptiveProfile;
  } catch(e) {
    console.warn('[learn] fetch profile failed:', e.message);
    return null;
  }
}

function logInteraction(userMsg, aiReply, feedback) {
  fetch('/api/learn', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Token': window.getSessionToken() },
    body:    JSON.stringify({ action: 'log', userMsg: userMsg, aiReply: aiReply, feedback: feedback || 0 }),
  }).catch(function(e) { console.warn('[learn] log failed:', e.message); });
}

function maybeRunDailyAnalysis() {
  var now     = Date.now();
  var dayMs   = 24 * 60 * 60 * 1000;
  var lastRun = window.get('lastLearnRun', 0);
  if (now - lastRun < dayMs) return;
  window.set('lastLearnRun', now);

  fetch('/api/learn', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Token': window.getSessionToken() },
    body:    JSON.stringify({ action: 'analyse' }),
  }).then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.profile) {
        _adaptiveProfile = data.profile;
        console.log('[learn] daily analysis done. Interactions:', data.interactionCount);
      }
    })
    .catch(function(e) { console.warn('[learn] analysis failed:', e.message); });

  var today      = new Date().getDay();
  var lastDigest = window.get('lastWeeklyDigest', 0);
  var isMonday   = today === 1;
  var neverDone  = lastDigest === 0;
  var overdue    = (now - lastDigest) > 7 * dayMs;

  if (isMonday || neverDone || overdue) {
    window.set('lastWeeklyDigest', now);
    fetch('/api/learn', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Token': window.getSessionToken() },
      body:    JSON.stringify({ action: 'digest' }),
    }).then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.digest && data.digest.length > 50) {
          window.set('weeklyDigest', data.digest);
          window.set('weeklyDigestDate', new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' }));
          console.log('[learn] weekly digest generated');
          if (isMonday) window.showWeeklyDigestInChat(data.digest);
        }
      })
      .catch(function(e) { console.warn('[learn] digest failed:', e.message); });
  }
}

// Profile summary / digest — pure data fetchers.
// Rendering is handled by ui.js (fetchAndShowProfileSummary / fetchAndShowDigest wrappers there).
async function fetchProfileSummary() {
  var r = await fetch('/api/learn?action=summary', { headers: { 'X-Agent-Token': window.getSessionToken() } });
  if (!r.ok) throw new Error('learn summary HTTP ' + r.status);
  return r.json();
}

async function fetchDigest() {
  var r = await fetch('/api/learn?action=digest', { headers: { 'X-Agent-Token': window.getSessionToken() } });
  if (!r.ok) throw new Error('learn digest HTTP ' + r.status);
  return r.json();
}

// These thin wrappers call back into ui.js which owns all DOM updates.
async function fetchAndShowProfileSummary() {
  if (typeof window._renderProfileSummary === 'function') {
    window._renderProfileSummary(fetchProfileSummary);
  }
}

async function fetchAndShowDigest() {
  if (typeof window._renderDigest === 'function') {
    window._renderDigest(fetchDigest);
  }
}

// ── GitHub prefetch helpers ────────────────────────────
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
  var name  = repoFullName.split('/')[1] || repoFullName;
  var lname = name.toLowerCase();
  var ltext = text.toLowerCase();
  var score = 0;
  if (ltext.includes(lname)) return 100;
  var parts = lname.split(/[-_]/);
  parts.forEach(function(part) {
    if (part.length > 2 && ltext.includes(part)) score += 30;
  });
  var hints = {
    'agent':   ['agent', 'ai', 'bot', 'assistant', 'claude'],
    'website': ['website', 'site', 'web', 'eritage', 'ent', 'clinic', 'eritageentcare'],
    'api':     ['api', 'backend', 'server', 'endpoint'],
    'app':     ['app', 'application', 'mobile', 'flutter'],
  };
  Object.keys(hints).forEach(function(repoHint) {
    if (lname.includes(repoHint)) {
      hints[repoHint].forEach(function(word) {
        if (ltext.includes(word)) score += 25;
      });
    }
  });
  return Math.min(score, 99);
}

async function autoDetectRepo(text) {
  var codeSignals = /\b(repo|github|commit|deploy|push|file|code|fix|build|branch|project)\b/i;
  if (!codeSignals.test(text)) return null;

  window.showWhisper('Identifying repo...');
  var repos = await ensureRepoList();
  if (!repos.length) return null;

  var scored = repos.map(function(r) {
    return { repo: r, score: scoreRepoMatch(r.name, text) };
  }).filter(function(s) { return s.score > 0; })
    .sort(function(a, b) { return b.score - a.score; });

  if (!scored.length) return null;
  var best = scored[0];
  if (best.score < 25) return null;

  var currentRepo  = window.get('repo1', '');
  var detectedRepo = best.repo.name;
  if (detectedRepo === currentRepo) return null;

  var shortName = detectedRepo.split('/')[1] || detectedRepo;
  window.set('repo1',     detectedRepo);
  window.set('repo1name', shortName);
  window.updateStatus();

  Object.keys(_ghCache).forEach(function(k) {
    if (k.includes(currentRepo)) delete _ghCache[k];
  });

  // Notify UI layer of repo switch (ui.js owns all DOM)
  if (typeof window._showRepoSwitchNotice === 'function') {
    window._showRepoSwitchNotice(detectedRepo);
  }

  return 'ACTIVE REPO: ' + detectedRepo + ' (auto-detected).';
}

async function prefetchGitHub(text) {
  try {
    if (REPO_RE.test(text)) {
      window.showWhisper('Checking your repos...');
      var repos = await ensureRepoList();
      if (!repos.length) return 'REPOS: none found.';
      var summary = repos.map(function(r) {
        var active = r.name === window.get('repo1', '') ? ' [ACTIVE]' : '';
        return r.name + (r.language ? ' [' + r.language + ']' : '') + active;
      }).join(', ');
      return 'REPOS (' + repos.length + '): ' + summary;
    }

    var switchNotice = await autoDetectRepo(text);

    if (COMMIT_RE.test(text)) {
      var repo = window.get('repo1', '');
      if (!repo) return switchNotice || 'No active repo set. Ask me to list your repos first.';
      window.showWhisper('Reading commit history...');
      var data2 = await cachedGithubAPI({ action: 'listCommits', repo: repo, limit: 5 });
      if (!data2.commits || !data2.commits.length) return switchNotice || null;
      var commitSummary = 'COMMITS ' + repo + ': ' + data2.commits.map(function(c) {
        return '[' + c.sha + '] ' + (c.date ? c.date.slice(0, 10) : '') + ': ' + c.message.slice(0, 60);
      }).join(' | ');
      return switchNotice ? switchNotice + ' ' + commitSummary : commitSummary;
    }

    if (FILE_RE.test(text)) {
      window.showWhisper('Fetching file...');
      var fileMatch = text.match(/[\w\-./]+\.(html|css|js|md|json|txt|py)/i);
      var repo2 = window.get('repo1', '');
      if (fileMatch && repo2) {
        var data3 = await cachedGithubAPI({ action: 'getFile', repo: repo2, path: fileMatch[0] });
        if (data3.content) {
          var capped = data3.content.length > 3000
            ? data3.content.slice(0, 3000) + '...[truncated]'
            : data3.content;
          var fileResult = 'FILE ' + fileMatch[0] + ':\n' + capped;
          return switchNotice ? switchNotice + '\n' + fileResult : fileResult;
        }
      }
      return switchNotice || null;
    }

    return switchNotice || null;
  } catch(e) {
    return 'GitHub prefetch failed: ' + e.message;
  }
}

// ── Expose to window ───────────────────────────────────
Object.assign(window, {
  estimateTokens,
  scoreComplexity,
  callAI,
  githubAPI,
  gbpAPI,
  syncKeyToCloud,
  syncFromCloud,
  CLOUD_KEYS,
  _adaptiveProfile,
  fetchAdaptiveProfile,
  logInteraction,
  maybeRunDailyAnalysis,
  fetchProfileSummary,
  fetchDigest,
  fetchAndShowProfileSummary,
  fetchAndShowDigest,
  prefetchGitHub,
  cachedGithubAPI,
  ensureRepoList,
  _ghCache,
  _repoList,
});
