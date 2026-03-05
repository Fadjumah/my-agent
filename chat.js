// ═══════════════════════════════════════════════════════
// chat.js — Sessions, system prompt, response handler
// SYNAPSE Agent v2 — instructions fetch, autonomous mode,
//   extended thinking, attachments, audit trail
// ═══════════════════════════════════════════════════════

var HISTORY_TOKEN_BUDGET = 3000;
var SUMMARY_KEEP_RECENT  = 6;

function pushConvo(role, content) {
  var h = window.get('conversation', []);
  h.push({ role: role, content: content.length > 4000 ? content.slice(0, 4000) + '...[truncated]' : content, time: Date.now() });
  if (h.length > 40) h.splice(0, h.length - 40);
  window.set('conversation', h);
}

function getCompactHistory() {
  var full   = window.get('conversation', []);
  if (!full.length) return [];
  var recent = full.slice(-SUMMARY_KEEP_RECENT);
  var older  = full.slice(0, -SUMMARY_KEEP_RECENT);
  var recentTokens = recent.reduce(function(t, m) { return t + window.estimateTokens(m.content); }, 0);
  if (recentTokens >= HISTORY_TOKEN_BUDGET || !older.length) return recent;
  var remaining = HISTORY_TOKEN_BUDGET - recentTokens;
  var parts = [], used = 0;
  for (var i = older.length - 1; i >= 0; i--) {
    var line = (older[i].role === 'user' ? 'U' : 'A') + ': ' + older[i].content.slice(0, 100).split('\n').join(' ');
    var t = window.estimateTokens(line);
    if (used + t > remaining) break;
    parts.unshift(line);
    used += t;
  }
  if (!parts.length) return recent;
  return [{ role: 'user', content: '[PRIOR CONTEXT] ' + parts.join(' | ') }].concat(recent);
}

// ── Instructions.md — 1-hour cached from GitHub ────────
var INSTR_KEY    = 'agent_instructions';
var INSTR_TS_KEY = 'agent_instructions_timestamp';
var INSTR_TTL    = 60 * 60 * 1000;

async function loadInstructions() {
  var cached = localStorage.getItem(INSTR_KEY);
  var ts     = parseInt(localStorage.getItem(INSTR_TS_KEY) || '0', 10);
  if (cached && (Date.now() - ts) < INSTR_TTL) return cached;
  try {
    var r = await fetch('/api/github', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Token': window.getSessionToken() },
      body:    JSON.stringify({ action: 'getFile', repo: 'Fadjumah/my-agent', path: 'instructions.md' }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var data = await r.json();
    if (data.content) {
      localStorage.setItem(INSTR_KEY, data.content);
      localStorage.setItem(INSTR_TS_KEY, String(Date.now()));
      console.log('[instructions] fetched from GitHub (' + (data.size || 0) + ' bytes)');
      return data.content;
    }
  } catch(e) {
    console.warn('[instructions] fetch failed — continuing without:', e.message);
  }
  return null;
}
function getInstructions() { return localStorage.getItem(INSTR_KEY) || null; }

// ── Sessions ───────────────────────────────────────────
function getSessions()         { return window.get('sessions', []); }
function getCurrentSessionId() { return window.get('currentSession', null); }

function saveSession(id, title, messages) {
  var sessions = getSessions();
  var idx = sessions.findIndex(function(s) { return s.id === id; });
  var obj = { id: id, title: title, messages: messages, updatedAt: Date.now() };
  if (idx >= 0) sessions[idx] = obj; else sessions.unshift(obj);
  if (sessions.length > 40) sessions.splice(40);
  window.set('sessions', sessions);
}
function loadSession(id) { return getSessions().find(function(s) { return s.id === id; }) || null; }

function deleteSession(id) {
  window.set('sessions', getSessions().filter(function(s) { return s.id !== id; }));
  if (getCurrentSessionId() === id) {
    window.set('currentSession', null);
    window.set('conversation', []);
    renderMessages([]);
    window.showWelcome();
  }
  renderChatList();
}

function newChat() {
  window.set('currentSession', 'chat_' + Date.now());
  window.set('conversation', []);
  window._pendingAttachments = [];
  renderMessages([]);
  window.showWelcome();
  renderChatList();
  window.closeSidebar();
  var inp = document.getElementById('userInput');
  if (inp) inp.focus();
}

function switchToSession(id) {
  var session = loadSession(id);
  if (!session) return;
  window.set('currentSession', id);
  window.set('conversation', session.messages || []);
  renderMessages(session.messages || []);
  renderChatList();
  window.closeSidebar();
}

function renderChatList() {
  var list = document.getElementById('chatList');
  if (!list) return;
  var sessions  = getSessions();
  var currentId = getCurrentSessionId();
  if (!sessions.length) {
    list.innerHTML = '<div style="padding:12px 10px;font-size:11px;color:var(--text3)">No chats yet</div>';
    return;
  }
  list.innerHTML = sessions.map(function(s) {
    var active = s.id === currentId ? ' active' : '';
    return '<div class="chat-item' + active + '" onclick="switchToSession(\'' + s.id + '\')">'
      + '<span class="chat-item-icon">&#x1F4AC;</span>'
      + '<span class="chat-item-title">' + window.esc(s.title || 'New chat') + '</span>'
      + '<button class="chat-item-del" onclick="event.stopPropagation();deleteSession(\'' + s.id + '\')" title="Delete">&#x2715;</button>'
      + '</div>';
  }).join('');
}

function saveCurrentMessages() {
  var id = getCurrentSessionId();
  if (!id) return;
  var conv = window.get('conversation', []);
  if (!conv.length) return;
  var firstUser = conv.find(function(m) { return m.role === 'user'; });
  var title = firstUser ? firstUser.content.slice(0, 45) + (firstUser.content.length > 45 ? '...' : '') : 'New chat';
  saveSession(id, title, conv);
  renderChatList();
}

function renderMessages(messages) {
  var container = document.getElementById('messages');
  if (!container) return;
  container.innerHTML = '';
  if (!messages || !messages.length) { window.showWelcome(); return; }
  messages.forEach(function(m) {
    if (m.role === 'user')           window._addUser(m.content, false);
    else if (m.role === 'assistant') window._addAI(window.fmt(m.content), false, true);
  });
  window.scrollBot();
}

// ── Adaptive learning ──────────────────────────────────
function buildAdaptiveContext(profile) {
  if (!profile) return '';
  var parts = [];
  if (profile.style) {
    if (profile.style.prefersBrief === true)    parts.push('Prefers concise replies (under 120 words).');
    if (profile.style.prefersBrief === false)   parts.push('Engages well with detailed responses.');
    if (profile.style.prefersBullets === false) parts.push('Dislikes bullet points — use prose.');
    if (profile.style.prefersBullets === true)  parts.push('Responds well to bullet-point structure.');
  }
  if (profile.recurringTopics && profile.recurringTopics.length) {
    parts.push('Most discussed topics: ' + profile.recurringTopics.slice(0, 3).map(function(t) { return t.topic.replace(/_/g, ' '); }).join(', ') + '.');
  }
  if (typeof profile.recentSentiment === 'number') {
    if (profile.recentSentiment > 0.4)  parts.push('Strong positive feedback recently.');
    if (profile.recentSentiment < -0.2) parts.push('Some friction detected — be more direct.');
  }
  (profile.observations || []).forEach(function(o) { parts.push(o); });
  return parts.length ? 'ADAPTIVE PROFILE: ' + parts.join(' ') : '';
}

// ── System prompt ──────────────────────────────────────
function sysPrompt() {
  var name  = window.get('userName', 'Fahad');
  var repo1 = window.get('repo1', '');
  var about = window.get('about', '');
  var prefs = window.get('prefs', '');
  var facts = window.get('learnedFacts', []);
  var mode  = window.currentMode;

  var now     = new Date();
  var dateStr = now.toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  var timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  var dateCtx = 'Current date and time: ' + dateStr + ' at ' + timeStr + ' (East Africa Time — UTC+3).';

  var aboutLine = (about && about.length > 5) ? 'About: ' + about : 'ENT surgeon, Uganda. Non-developer. Plain language.';
  var prefsLine = (prefs && prefs.length > 5) ? 'Prefs: ' + prefs : 'Direct, brief, no jargon.';
  var factLine  = facts.length ? ' Known: ' + facts.slice(-10).map(function(f) { return f.slice(0, 80); }).join('; ') : '';

  var recallCtx = '';
  try {
    var allSessions = window.get('sessions', []);
    if (allSessions.length > 1) {
      var prevMsgs = [];
      allSessions.slice(1, 4).forEach(function(s) {
        if (s.messages && s.messages.length) {
          var fu = s.messages.find(function(m) { return m.role === 'user'; });
          if (fu) prevMsgs.push('"' + fu.content.slice(0, 80) + '"');
        }
      });
      if (prevMsgs.length) recallCtx = ' Past sessions: ' + prevMsgs.join('; ') + '.';
    }
  } catch(e) {}

  var adaptiveCtx = '';
  var ap = window._adaptiveProfile;
  if (ap) {
    adaptiveCtx = buildAdaptiveContext(ap);
    if (ap.microPatterns && ap.microPatterns.length)
      adaptiveCtx += ' Micro-patterns: ' + ap.microPatterns.slice(0, 5).join('; ') + '.';
    if (ap.predictedNeeds && ap.predictedNeeds.length)
      adaptiveCtx += ' Predicted focus: ' + ap.predictedNeeds.join(', ') + '.';
  }

  var instructionsBlock = '';
  var instr = getInstructions();
  if (instr) {
    instructionsBlock = '=== PERSISTENT BEHAVIORAL RULES ===\n' + instr.slice(0, 3000) + '\n=== END RULES ===\n\n';
  }

  var actionTagRules = '\n\nCRITICAL: NEVER display [ACTION:*], [MEMORY], or any raw tag syntax to the user. Execute tags silently, show only results.';

  var base = dateCtx + '\nAgent for ' + name + '. Active repo: '
    + (repo1 || 'none') + '. '
    + aboutLine + ' ' + prefsLine + factLine
    + (adaptiveCtx ? ' ' + adaptiveCtx : '');

  var strategicInstr = 'STRATEGIC MODE: Senior strategist+technologist. Think deeply, concrete actionable advice. Warm, witty.'
    + ' GBP (Eritage ENT Care – Entebbe): [ACTION:GBP]{"action":"getAccounts"}[/ACTION:GBP]'
    + ' {"action":"getLocations","accountId":"accounts/XXX"} {"action":"getProfile"} {"action":"getReviews"}'
    + ' {"action":"createPost","content":"text"} {"action":"replyReview","reviewId":"...","reply":"text"}'
    + ' {"action":"updateHours","hours":{"MONDAY":{"open":"09:00","close":"17:00"}}}'
    + ' {"action":"updateDescription","description":"text"}'
    + ' Always show drafts for approval before publishing.';

  var codeInstr = 'CODE MODE: Show precise status for every operation (exact filename + action). Full files only. No action without yes.'
    + ' GITHUB: [ACTION:GITHUB]{"action":"getFile","repo":"owner/repo","path":"f"}[/ACTION:GITHUB]'
    + ' [ACTION:GITHUB]{"action":"listRepos"}[/ACTION:GITHUB]'
    + ' [ACTION:GITHUB]{"action":"scanSecrets","repo":"r","path":"p"}[/ACTION:GITHUB]'
    + ' [ACTION:GITHUB]{"action":"checkConflict","repo":"r","path":"p","knownSha":"sha"}[/ACTION:GITHUB]'
    + ' [ACTION:GITHUB]{"action":"getDiff","repo":"r","base":"sha1","head":"sha2"}[/ACTION:GITHUB]'
    + ' [ACTION:GITHUB]{"action":"analyzeRepo","repo":"r"}[/ACTION:GITHUB]'
    + ' DEPLOY: [ACTION:DEPLOY]{"repo":"...","branch":"main","commit_message":"...","files":[{"path":"...","content":"..."}]}[/ACTION:DEPLOY]'
    + ' PLAN: [ACTION:PLAN]{"goal":"...","tasks":[{"action":"readFile","file":"..."},{"action":"pushFile","file":"...","content":"..."}]}[/ACTION:PLAN]'
    + ' After every push: confirm exact commit SHA + file path. Never push without yes.';

  return instructionsBlock
    + base + recallCtx + '\n'
    + (mode === 'code' ? codeInstr : strategicInstr)
    + actionTagRules
    + ' Store facts: [MEMORY]fact[/MEMORY]';
}

// ── Reasoning gate ─────────────────────────────────────
function reasoningGate(text) {
  var t = text.trim().toLowerCase();
  if (/^(hi|hello|hey|halo|hiya|yo)[!.\s]*$/.test(t))
    return 'Hey ' + (window.get('userName', '') || 'there') + '! What are we working on today?';
  if (/^(thanks|thank you|thx|cheers)[!.\s]*$/.test(t)) return 'Anytime! What is next?';
  if (/^(ok|okay|got it|noted|sure|alright|sounds good)[!.\s]*$/.test(t)) return 'Got it. What would you like to do next?';
  if (/^(what is |what.s )?(today.?s )?(date|time|day)\??$/.test(t)) {
    var n = new Date();
    return n.toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
      + ' at ' + n.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + ' (EAT)';
  }
  if (/^what (mode|modes?)/.test(t))
    return window.currentMode === 'code' ? 'Code Mode — strict execution.' : 'Strategic Mode — planning and thinking.';
  // Standalone GBP shorthand — no agentRaw since user triggered directly
  if (/get.*gbp.*accounts?|get.*my.*accounts?.*gbp/i.test(t))  { pushConvo('user', text); window.handleGBPAction({ action: 'getAccounts'  }); return '__ASYNC__'; }
  if (/get.*gbp.*locations?/i.test(t))                         { pushConvo('user', text); window.handleGBPAction({ action: 'getLocations' }); return '__ASYNC__'; }
  if (/get.*my.*reviews?|list.*reviews?/i.test(t))             { pushConvo('user', text); window.handleGBPAction({ action: 'getReviews'   }); return '__ASYNC__'; }
  if (/gbp.*profile/i.test(t))                                 { pushConvo('user', text); window.handleGBPAction({ action: 'getProfile'   }); return '__ASYNC__'; }
  if (/what.*(know|learned|remember|noticed).*(me|my)/i.test(t) || /show.*my.*profile/i.test(t)) { pushConvo('user', text); window.fetchAndShowProfileSummary(); return '__ASYNC__'; }
  if (/weekly digest/i.test(t)) { pushConvo('user', text); window.fetchAndShowDigest(); return '__ASYNC__'; }
  return null;
}

// ── Audit trail ────────────────────────────────────────
function logAuditEntry(entry) {
  var log = window.get('auditLog', []);
  log.unshift({ ts: Date.now(), date: new Date().toLocaleString('en-GB'), action: entry.action, repo: entry.repo, path: entry.path, sha: entry.sha, branch: entry.branch || 'main', message: entry.message });
  if (log.length > 100) log.splice(100);
  window.set('auditLog', log);
}
function getAuditLog() { return window.get('auditLog', []); }

// ── Implicit feedback ──────────────────────────────────
var _pendingFeedback = null;

function scoreImplicitFeedback(userMsg) {
  if (!_pendingFeedback) return;
  var pos = /\b(perfect|exactly|great|brilliant|yes|correct|love it|spot on|awesome|do it|go ahead|confirmed|proceed|thanks|thank you)\b/i.test(userMsg);
  var neg = /\b(no|wrong|not what i|incorrect|stop|redo|again|rephrase|too long|not helpful|useless|fix it)\b/i.test(userMsg);
  window.logInteraction(_pendingFeedback.userMsg, _pendingFeedback.aiReply, (pos && !neg) ? 1 : (neg && !pos) ? -1 : 0);
  _pendingFeedback = null;
}

// ── Response handler ───────────────────────────────────
async function handleResponse(raw, msgEl) {
  var memMatches = Array.from(raw.matchAll(/\[MEMORY\]([\s\S]*?)\[\/MEMORY\]/g));
  var ghMatch   = raw.match(/\[ACTION:GITHUB\]([\s\S]*?)\[\/ACTION:GITHUB\]/);
  var depMatch  = raw.match(/\[ACTION:DEPLOY\]([\s\S]*?)\[\/ACTION:DEPLOY\]/);
  var gbpMatch  = raw.match(/\[ACTION:GBP\]([\s\S]*?)\[\/ACTION:GBP\]/);
  var planMatch = raw.match(/\[ACTION:PLAN\]([\s\S]*?)\[\/ACTION:PLAN\]/);

  memMatches.forEach(function(m) {
    var fact  = m[1].trim();
    var facts = window.get('learnedFacts', []);
    if (!facts.includes(fact)) {
      facts.push(fact);
      window.set('learnedFacts', facts);
      if (typeof window.syncKeyToCloud === 'function') window.syncKeyToCloud('learnedFacts', facts);
    }
  });

  if (/switching to.*code mode|entering code mode/i.test(raw))     window.setMode('code');
  if (/switching to.*strategic mode|back to strategic/i.test(raw)) window.setMode('strategic');

  // Strip ALL action tags before displaying — user never sees raw syntax
  var display = raw
    .replace(/\[MEMORY\][\s\S]*?\[\/MEMORY\]/g, '')
    .replace(/\[ACTION:GITHUB\][\s\S]*?\[\/ACTION:GITHUB\]/g, '')
    .replace(/\[ACTION:DEPLOY\][\s\S]*?\[\/ACTION:DEPLOY\]/g, '')
    .replace(/\[ACTION:GBP\][\s\S]*?\[\/ACTION:GBP\]/g, '')
    .replace(/\[ACTION:PLAN\][\s\S]*?\[\/ACTION:PLAN\]/g, '')
    .trim();

  var bubble = msgEl.querySelector('.bubble');
  if (display && bubble) bubble.innerHTML = window.fmt(display);
  window.scrollBot();

  // ── GitHub action ─────────────────────────────────────────────────────────
  if (ghMatch) {
    var ghPayload;
    try { ghPayload = window.safeParseJSON(ghMatch[1]); } catch(e) { window.addAI('GitHub JSON malformed. Rephrase.'); return; }

    var ghAction   = ghPayload.action || 'unknown';
    var ghStatusMsg = ghAction === 'getFile'      ? 'Reading ' + (ghPayload.path||'') + ' from ' + (ghPayload.repo||'GitHub') + '...'
                    : ghAction === 'listRepos'    ? 'Fetching repository list from GitHub...'
                    : ghAction === 'listFiles'    ? 'Listing files in ' + (ghPayload.path||'/') + '...'
                    : ghAction === 'listCommits'  ? 'Fetching commit history for ' + (ghPayload.repo||'') + '...'
                    : ghAction === 'pushFile'     ? 'Pushing ' + (ghPayload.path||'file') + ' to ' + (ghPayload.branch||'main') + ' branch...'
                    : ghAction === 'scanSecrets'  ? 'Scanning ' + (ghPayload.path||'file') + ' for exposed secrets...'
                    : ghAction === 'revertFile'   ? 'Reverting ' + (ghPayload.path||'file') + ' to ' + (ghPayload.commitSha||'prior commit') + '...'
                    : ghAction === 'getDiff'      ? 'Comparing ' + (ghPayload.path||'file') + ' between refs...'
                    : ghAction === 'analyzeImpact'? 'Analysing change impact for ' + (ghPayload.repo||'') + '...'
                    : 'Calling GitHub API: ' + ghAction + '...';

    window.showWhisper(ghStatusMsg);
    var fetchEl   = window.addAI('<em style="color:var(--text3);font-size:13px">&#x1F504; ' + window.esc(ghStatusMsg) + '</em>');
    var fBubble   = fetchEl.querySelector('.bubble');

    var ghResult;
    try {
      ghResult = await window.githubAPI(ghPayload);
      window.hideWhisper();
    } catch(e) {
      window.hideWhisper();
      fBubble.innerHTML = (e.friendlyHTML || ('&#x274C; GitHub error: ' + window.esc(e.message)));
      return;
    }

    // ── Handle special error responses ──────────────────────────────────────
    if (ghResult && ghResult.error === 'SECRETS_DETECTED') {
      var secMsg = '&#x26A0;&#xFE0F; <strong>Push aborted — secrets detected in ' + window.esc(ghPayload.path||'file') + ':</strong><br/><br/>';
      (ghResult.secrets||[]).forEach(function(s) {
        secMsg += '&#x2022; <code>' + window.esc(s.type) + '</code> at line ' + s.line + '<br/>';
      });
      secMsg += '<br/>Remove secrets and use environment variables before pushing.';
      fBubble.innerHTML = secMsg;
      // Inject the block into conversation so the agent knows what happened
      pushConvo('assistant', raw);
      pushConvo('user', '[TOOL_RESULT github:' + ghAction + '] ABORTED — secrets detected: ' + JSON.stringify(ghResult.secrets));
      pushConvo('assistant', secMsg.replace(/<[^>]+>/g, ''));
      return;
    }

    if (ghResult && ghResult.error === 'CONFLICT') {
      var conflictMsg = '&#x1F6A8; <strong>Push conflict:</strong> ' + window.esc(ghResult.message||'Remote changed since last read.');
      fBubble.innerHTML = conflictMsg;
      pushConvo('assistant', raw);
      pushConvo('user', '[TOOL_RESULT github:' + ghAction + '] CONFLICT — ' + (ghResult.message||'Remote changed.'));
      pushConvo('assistant', conflictMsg.replace(/<[^>]+>/g, ''));
      return;
    }

    // ── Show audit entry + diff for pushFile ────────────────────────────────
    if (ghAction === 'pushFile' && ghResult && ghResult.auditEntry) {
      if (typeof window.showAuditEntry === 'function') window.showAuditEntry(ghResult.auditEntry, ghResult.diff);
      var auditLog = window.get('auditLog', []);
      auditLog.unshift(ghResult.auditEntry);
      if (auditLog.length > 50) auditLog.splice(50);
      window.set('auditLog', auditLog);
    }

    // ── Build tool result message and inject into conversation ───────────────
    // Compact the result for large payloads (file content > 6KB → truncate)
    var resultForContext = ghResult;
    if (ghResult && ghResult.content && ghResult.content.length > 6000) {
      resultForContext = Object.assign({}, ghResult, {
        content: ghResult.content.slice(0, 6000) + '\n... [truncated — ' + (ghResult.content.length - 6000) + ' more chars]',
        _truncated: true,
      });
    }

    var toolResultText = '[TOOL_RESULT github:' + ghAction + ']\n'
      + JSON.stringify(resultForContext, null, 2)
      + '\n[/TOOL_RESULT]\n\nBased on this result, respond to the user. Be specific and concise. Never print raw JSON.';

    // Step 1: commit agent's action message to history
    pushConvo('assistant', raw);

    // Step 2: stream agent's continuation — passing tool result as the new user turn
    // (NOT pre-committed so it's not doubled in the backend history)
    window.showWhisper('Processing result...');
    var fBuf    = '';
    var fCursor = document.createElement('span'); fCursor.className = 'cursor';
    fBubble.innerHTML = ''; fBubble.appendChild(fCursor);

    var continuation;
    try {
      continuation = await window.callAI(toolResultText, function(chunk) {
        fBuf += chunk;
        window.hideWhisper();
        fBubble.innerHTML = window.fmt(stripActionTags(fBuf));
        fBubble.appendChild(fCursor);
        window.scrollBot();
      });
    } catch(e) {
      window.hideWhisper();
      fBubble.innerHTML = e.friendlyHTML || ('&#x274C; ' + window.esc(e.message));
      return;
    }

    window.hideWhisper();

    // Step 3: commit tool result (as user) + agent continuation (as assistant)
    pushConvo('user', toolResultText);
    pushConvo('assistant', continuation);

    // Step 4: render final display (strip any action tags from continuation)
    var cleanContinuation = stripActionTags(continuation);
    fBubble.innerHTML = window.fmt(cleanContinuation);
    window.scrollBot();

    // Step 5: if the continuation itself has action tags, run it through handleResponse too
    if (/\[ACTION:/.test(continuation)) {
      await handleResponse(continuation, fetchEl);
    }

    return;
  }

  // Deploy — show diff preview before buttons
  if (depMatch) {
    var depAction;
    try { depAction = window.safeParseJSON(depMatch[1]); } catch(e) { window.addAI('Deploy JSON malformed.'); return; }
    if (depAction.files && depAction.files.length) window.showDeployPreview(depAction);
    else window.addAI('Deploy action had no files.');
  }

  // ── GBP action ─────────────────────────────────────────────────────────────
  if (gbpMatch) {
    var gbpAction;
    try { gbpAction = window.safeParseJSON(gbpMatch[1]); } catch(e) { window.addAI('GBP JSON malformed.'); return; }
    // Commit agent message first so GBP result has context
    pushConvo('assistant', raw);
    window.handleGBPAction(gbpAction, raw);
  }

  // Autonomous plan
  if (planMatch) {
    var plan;
    try { plan = window.safeParseJSON(planMatch[1]); } catch(e) { window.addAI('Plan JSON malformed.'); return; }
    var planEl = window.addAI('');
    await executePlan(plan, planEl);
  }
}

// ── Autonomous plan executor ───────────────────────────
async function executePlan(plan, msgEl) {
  var tasks  = plan.tasks || [];
  var goal   = plan.goal  || 'Complete task';
  var bubble = msgEl.querySelector('.bubble');
  if (!bubble) return;

  var repo = window.get('repo1', '');
  var log  = '<strong>&#x1F916; Autonomous — ' + window.esc(goal) + '</strong><br/><br/>';
  bubble.innerHTML = log;

  for (var i = 0; i < tasks.length; i++) {
    var task = tasks[i];
    log += '<div style="padding:4px 0 4px 10px;border-left:2px solid var(--accent);margin:4px 0;">';
    log += '&#x23F3; Step ' + (i+1) + '/' + tasks.length + ': ' + window.esc(task.action || 'task');
    bubble.innerHTML = log + '</div>';
    window.scrollBot();

    try {
      if (task.action === 'readFile' || task.action === 'getFile') {
        window.showStatusExact('Reading ' + task.file + ' from ' + repo + '...');
        var r = await window.githubAPI({ action: 'getFile', repo: repo, path: task.file });
        task._result = r;
        log += ' &#x2705; Read ' + task.file;
      } else if (task.action === 'pushFile') {
        window.showStatusExact('Pushing ' + task.file + ' to ' + (task.branch || 'main') + '...');
        var pr = await window.pushFileWithRetry({ repo: repo, path: task.file, content: task.content || (task._result && task._result.content) || '', commitMessage: task.commitMessage || ('auto: ' + goal.slice(0, 50)), branch: task.branch || 'main' });
        log += ' &#x2705; Pushed ' + task.file + ' — <code>' + (pr.sha || '?') + '</code>';
        window.logAuditEntry({ action: 'push', repo: repo, path: task.file, sha: pr.sha, message: task.commitMessage });
      } else if (task.action === 'scanSecrets') {
        window.showStatusExact('Scanning ' + task.file + ' for secrets...');
        var sr = await window.githubAPI({ action: 'scanSecrets', repo: repo, path: task.file });
        log += sr.clean ? ' &#x2705; Clean: ' + task.file : ' &#x26D4; Secrets in ' + task.file + ': ' + sr.secrets.map(function(s) { return s.type; }).join(', ');
      } else {
        log += ' &#x23ED;&#xFE0F; Unknown: ' + task.action;
      }
    } catch(e) {
      log += ' &#x274C; ' + window.esc(e.message);
    }

    log += '</div>';
    bubble.innerHTML = log;
    window.hideWhisper();
    window.scrollBot();
    await new Promise(function(r) { setTimeout(r, 150); });
  }

  log += '<br/><strong>Done.</strong> Review above — type <strong>confirm deploy</strong> to push or <strong>cancel</strong>.';
  bubble.innerHTML = log;
  window.scrollBot();
}

// ── Main send ──────────────────────────────────────────
async function sendMessageText(text, attachments) {
  scoreImplicitFeedback(text);
  window.detectMode(text);
  window.addUserWithAttachments(text, attachments || []);

  var dot = document.getElementById('statusDot');
  var txt = document.getElementById('statusText');
  if (dot) dot.className = 'status-dot thinking';

  try {
    if (!attachments || !attachments.length) {
      var det = reasoningGate(text);
      if (det) {
        if (det !== '__ASYNC__') {
          window.addAI(det);
          pushConvo('user', text);
          pushConvo('assistant', det);
          if (!getCurrentSessionId()) window.set('currentSession', 'chat_' + Date.now());
          saveCurrentMessages();
        }
        return;
      }
    }

    var ghContext = await window.prefetchGitHub(text);
    var msgToSend = ghContext ? text + ' [GitHub: ' + ghContext + ']' : text;
    pushConvo('user', text);

    var el     = window.addAI('');
    var bubble = el.querySelector('.bubble');
    var rawBuf = '';
    var cursor = document.createElement('span');
    cursor.className = 'cursor';
    bubble.appendChild(cursor);

    var useThinking = window.get('extendedThinking', false) && window._lastBrainUsed !== 'gemini';

    var response = await window.callAI(msgToSend, function(chunk) {
      rawBuf += chunk;
      window.hideWhisper();
      bubble.innerHTML = window.fmt(rawBuf);
      bubble.appendChild(cursor);
      window.scrollBot();
    }, attachments || [], useThinking);

    bubble.innerHTML = '';
    window.hideWhisper();
    await handleResponse(response, el);

    pushConvo('assistant', response);
    _pendingFeedback = { userMsg: text, aiReply: response };
    if (!getCurrentSessionId()) window.set('currentSession', 'chat_' + Date.now());
    saveCurrentMessages();
    window.logInteraction(text, response, 0);

  } catch(e) {
    window.hideWhisper();
    window.hideTyping();
    window.updateStatus();
    if (e.isQuota) { window.markGeminiLimited(); window.queueMessage(text); }
    else { window.addAI(e.friendlyHTML || ('<strong>Error:</strong> ' + window.esc(e.message))); }
  }
}

async function sendMessage() {
  var inp  = document.getElementById('userInput');
  var text = inp ? inp.value.trim() : '';
  var atts = window._pendingAttachments || [];
  if (!text && !atts.length) return;
  var btn = document.getElementById('sendBtn');
  if (btn) btn.disabled = true;
  if (inp) { inp.value = ''; inp.style.height = 'auto'; }
  window.clearAttachments();
  try { await sendMessageText(text, atts); }
  finally { if (btn) btn.disabled = false; window.updateStatus(); var i = document.getElementById('userInput'); if (i) i.focus(); }
}

Object.assign(window, {
  pushConvo, getCompactHistory,
  getSessions, getCurrentSessionId, saveSession, loadSession, deleteSession,
  newChat, switchToSession, renderChatList, saveCurrentMessages, renderMessages,
  buildAdaptiveContext, sysPrompt, reasoningGate,
  _pendingFeedback, scoreImplicitFeedback, handleResponse,
  sendMessageText, sendMessage,
  loadInstructions, getInstructions,
  executePlan, logAuditEntry, getAuditLog,
});
