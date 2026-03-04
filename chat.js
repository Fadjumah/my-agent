// ═══════════════════════════════════════════════════════
// chat.js — Message rendering, sessions, system prompt,
//           response handler, reasoning gate, send loop
// SYNAPSE Agent
// ═══════════════════════════════════════════════════════

// ── Conversation history ───────────────────────────────
var HISTORY_TOKEN_BUDGET = 3000;
var SUMMARY_KEEP_RECENT  = 6;

function pushConvo(role, content) {
  var h      = window.get('conversation', []);
  var stored = content.length > 4000 ? content.slice(0, 4000) + '...[truncated]' : content;
  h.push({ role: role, content: stored, time: Date.now() });
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
    var t    = window.estimateTokens(line);
    if (used + t > remaining) break;
    parts.unshift(line);
    used += t;
  }
  if (!parts.length) return recent;
  return [{ role: 'user', content: '[PRIOR CONTEXT] ' + parts.join(' | ') }].concat(recent);
}

// ── Chat sessions (sidebar history) ───────────────────
function getSessions()         { return window.get('sessions', []); }
function getCurrentSessionId() { return window.get('currentSession', null); }

function saveSession(id, title, messages) {
  var sessions = getSessions();
  var idx      = sessions.findIndex(function(s) { return s.id === id; });
  var obj      = { id: id, title: title, messages: messages, updatedAt: Date.now() };
  if (idx >= 0) sessions[idx] = obj; else sessions.unshift(obj);
  if (sessions.length > 40) sessions.splice(40);
  window.set('sessions', sessions);
}

function loadSession(id) {
  return getSessions().find(function(s) { return s.id === id; }) || null;
}

function deleteSession(id) {
  var sessions = getSessions().filter(function(s) { return s.id !== id; });
  window.set('sessions', sessions);
  if (getCurrentSessionId() === id) {
    window.set('currentSession', null);
    window.set('conversation', []);
    renderMessages([]);
    window.showWelcome();
  }
  renderChatList();
}

function newChat() {
  var id = 'chat_' + Date.now();
  window.set('currentSession', id);
  window.set('conversation', []);
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
  var list      = document.getElementById('chatList');
  if (!list) return;
  var sessions  = getSessions();
  var currentId = getCurrentSessionId();
  if (!sessions.length) {
    list.innerHTML = '<div style="padding:12px 10px;font-size:11px;color:var(--text3)">No chats yet</div>';
    return;
  }
  list.innerHTML = sessions.map(function(s) {
    var active = s.id === currentId ? ' active' : '';
    var title  = window.esc(s.title || 'New chat');
    return '<div class="chat-item' + active + '" onclick="switchToSession(\'' + s.id + '\')">'
      + '<span class="chat-item-icon">&#x1F4AC;</span>'
      + '<span class="chat-item-title">' + title + '</span>'
      + '<button class="chat-item-del" onclick="event.stopPropagation();deleteSession(\'' + s.id + '\')" title="Delete">&#x2715;</button>'
      + '</div>';
  }).join('');
}

function saveCurrentMessages() {
  var id   = getCurrentSessionId();
  if (!id) return;
  var conv = window.get('conversation', []);
  if (!conv.length) return;
  var firstUser = conv.find(function(m) { return m.role === 'user'; });
  var title     = firstUser
    ? firstUser.content.slice(0, 45) + (firstUser.content.length > 45 ? '...' : '')
    : 'New chat';
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
    else if (m.role === 'assistant') window._addAI(m.content, false);
  });
  window.scrollBot();
}

// ── Adaptive learning context builder ─────────────────
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
    var topics = profile.recurringTopics.slice(0, 3)
      .map(function(t) { return t.topic.replace(/_/g, ' '); }).join(', ');
    parts.push('Most discussed topics lately: ' + topics + '.');
  }
  if (typeof profile.recentSentiment === 'number') {
    if (profile.recentSentiment > 0.4)  parts.push('Strong positive feedback recently — keep this style.');
    if (profile.recentSentiment < -0.2) parts.push('Some friction detected — be more direct and concise.');
  }
  if (profile.observations && profile.observations.length) {
    profile.observations.forEach(function(o) { parts.push(o); });
  }
  if (!parts.length) return '';
  return 'ADAPTIVE PROFILE: ' + parts.join(' ');
}

// ── System prompt builder ──────────────────────────────
function sysPrompt() {
  var name    = window.get('userName', 'Fahad');
  var repo1   = window.get('repo1', '');
  var about   = window.get('about', '');
  var prefs   = window.get('prefs', '');
  var facts   = window.get('learnedFacts', []);
  var mode    = window.currentMode;
  var now     = new Date();
  var dateStr = now.toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' });

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
          var firstUser = s.messages.find(function(m) { return m.role === 'user'; });
          if (firstUser) prevMsgs.push('"' + firstUser.content.slice(0, 80) + '"');
        }
      });
      if (prevMsgs.length) recallCtx = ' Past sessions included: ' + prevMsgs.join('; ') + '.';
    }
  } catch(e) {}

  var adaptiveCtx = '';
  var ap = window._adaptiveProfile;
  if (ap) {
    adaptiveCtx = buildAdaptiveContext(ap);
    if (ap.microPatterns && ap.microPatterns.length)
      adaptiveCtx += ' Micro-patterns: ' + ap.microPatterns.slice(0, 5).join('; ') + '.';
    if (ap.predictedNeeds && ap.predictedNeeds.length)
      adaptiveCtx += ' Predicted next focus: ' + ap.predictedNeeds.join(', ') + '.';
    if (ap.extractedPrefs && ap.extractedPrefs.length)
      adaptiveCtx += ' Inferred goals: ' + ap.extractedPrefs.slice(0, 3).join('; ') + '.';
  }

  var base = 'Agent for ' + name + ' (' + dateStr + '). Active repo: '
    + (repo1 || 'none — will auto-detect from conversation') + '. '
    + aboutLine + ' ' + prefsLine + factLine
    + (adaptiveCtx ? ' ' + adaptiveCtx : '');

  var strategicInstr = 'STRATEGIC MODE: Senior strategist+technologist. Think deeply, surface insights unprompted, concrete actionable advice. Warm, witty. Say "Switching to Code Mode" when appropriate.'
    + ' GOOGLE BUSINESS PROFILE (Eritage ENT Care – Entebbe, managed via SYNAPSE). Use [ACTION:GBP]{JSON}[/ACTION:GBP] tags.'
    + ' IMPORTANT: when user says get my GBP accounts or get accounts use {"action":"getAccounts"}.'
    + ' When user says get locations use {"action":"getLocations","accountId":"accounts/XXX"}.'
    + ' Other actions: {"action":"getProfile"} {"action":"getReviews"} {"action":"createPost","content":"text"}'
    + ' {"action":"replyReview","reviewId":"...","reply":"text"}'
    + ' {"action":"updateHours","hours":{"MONDAY":{"open":"09:00","close":"17:00"}}}'
    + ' {"action":"updateSpecialHours","specialHours":[{"date":"YYYY-MM-DD","closed":true}]}'
    + ' {"action":"updateDescription","description":"text max 750 chars"}'
    + ' Always show post and reply drafts for approval. Never publish without explicit confirmation.';

  var codeInstr = 'CODE MODE: 1) Start "Code Mode — [what]" 2) Explain before code 3) Full file only 4) No action without yes/confirmed 5) Never assume structure 6) Never hallucinate paths.'
    + ' [ACTION:GITHUB]{"action":"listRepos"}[/ACTION:GITHUB]'
    + ' [ACTION:GITHUB]{"action":"getFile","repo":"owner/repo","path":"file"}[/ACTION:GITHUB]'
    + ' [ACTION:DEPLOY]{"repo":"...","branch":"main","commit_message":"...","files":[{"path":"...","content":"..."}]}[/ACTION:DEPLOY]'
    + ' Never push without explicit yes.';

  var memRule = ' Store facts: [MEMORY]fact[/MEMORY]';
  return base + recallCtx + '\n' + (mode === 'code' ? codeInstr : strategicInstr) + memRule;
}

// ── Reasoning gate — skip LLM for trivial inputs ───────
function reasoningGate(text) {
  var t = text.trim().toLowerCase();
  if (/^(hi|hello|hey|halo|hiya|yo)[!.\s]*$/.test(t))
    return 'Hey ' + (window.get('userName', 'Fahad') || 'there') + '! What are we working on today?';
  if (/^(thanks|thank you|thx|cheers)[!.\s]*$/.test(t))
    return 'Anytime! What is next?';
  if (/^(ok|okay|got it|noted|sure|alright|sounds good)[!.\s]*$/.test(t))
    return 'Got it. What would you like to do next?';
  if (/^(what is |what.s )?(today.?s )?(date|time|day)\??$/.test(t)) {
    var n = new Date();
    return n.toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
      + ' at ' + n.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  if (/^what (mode|modes?)/.test(t))
    return window.currentMode === 'code' ? 'Code Mode — strict execution.' : 'Strategic Mode — planning and thinking.';

  // GBP quick commands
  if (/get.*gbp.*accounts?|get.*my.*accounts?.*gbp|list.*gbp.*accounts?/i.test(t)) {
    window.handleGBPAction({ action: 'getAccounts' }); return '__ASYNC__';
  }
  if (/get.*gbp.*locations?|list.*gbp.*locations?/i.test(t)) {
    window.handleGBPAction({ action: 'getLocations' }); return '__ASYNC__';
  }
  if (/get.*my.*reviews?|show.*my.*reviews?|list.*reviews?/i.test(t)) {
    window.handleGBPAction({ action: 'getReviews' }); return '__ASYNC__';
  }
  if (/get.*my.*gbp.*profile|show.*gbp.*profile|gbp.*profile/i.test(t)) {
    window.handleGBPAction({ action: 'getProfile' }); return '__ASYNC__';
  }

  // Profile summary
  if (/what.*(know|learned|learn|remember|know about|figured out|noticed|observed).*(me|my|about me|about you)/i.test(t)
      || /what.*my.*profile/i.test(t)
      || /tell me.*about (myself|me|my habits|my style)/i.test(t)
      || /show.*my.*profile/i.test(t)) {
    window.fetchAndShowProfileSummary(); return '__ASYNC__';
  }

  // Weekly digest
  if (/weekly digest|this week.*(summary|recap|review)|what.*we.*work.*this week|what.*i.*work.*this week/i.test(t)) {
    window.fetchAndShowDigest(); return '__ASYNC__';
  }

  return null;
}

// ── Implicit feedback scorer ───────────────────────────
var _pendingFeedback = null;

function scoreImplicitFeedback(userMsg) {
  if (!_pendingFeedback) return;
  var pos = /\b(perfect|exactly|great|brilliant|yes|correct|love it|spot on|awesome|do it|go ahead|confirmed|proceed|thanks|thank you)\b/i.test(userMsg);
  var neg = /\b(no|wrong|not what i|that.s not|incorrect|stop|don.t|redo|again|rephrase|too long|too short|not helpful|useless|fix it)\b/i.test(userMsg);
  var score = (pos && !neg) ? 1 : (neg && !pos) ? -1 : 0;
  window.logInteraction(_pendingFeedback.userMsg, _pendingFeedback.aiReply, score);
  _pendingFeedback = null;
}

// ── Response handler ───────────────────────────────────
async function handleResponse(raw, msgEl) {
  var memMatches = Array.from(raw.matchAll(/\[MEMORY\]([\s\S]*?)\[\/MEMORY\]/g));
  var ghMatch    = raw.match(/\[ACTION:GITHUB\]([\s\S]*?)\[\/ACTION:GITHUB\]/);
  var depMatch   = raw.match(/\[ACTION:DEPLOY\]([\s\S]*?)\[\/ACTION:DEPLOY\]/);
  var gbpMatch   = raw.match(/\[ACTION:GBP\]([\s\S]*?)\[\/ACTION:GBP\]/);

  // Save memory facts
  memMatches.forEach(function(m) {
    var fact  = m[1].trim();
    var facts = window.get('learnedFacts', []);
    if (!facts.includes(fact)) {
      facts.push(fact);
      window.set('learnedFacts', facts);
      // Sync new fact to cloud via api.js
      if (typeof window.syncKeyToCloud === 'function') {
        window.syncKeyToCloud('learnedFacts', facts);
      }
    }
  });

  // Detect mode switch announcements
  if (/switching to.*code mode|entering code mode/i.test(raw))     window.setMode('code');
  if (/switching to.*strategic mode|back to strategic/i.test(raw)) window.setMode('strategic');

  var display = raw
    .replace(/\[MEMORY\][\s\S]*?\[\/MEMORY\]/g, '')
    .replace(/\[ACTION:GITHUB\][\s\S]*?\[\/ACTION:GITHUB\]/g, '')
    .replace(/\[ACTION:DEPLOY\][\s\S]*?\[\/ACTION:DEPLOY\]/g, '')
    .replace(/\[ACTION:GBP\][\s\S]*?\[\/ACTION:GBP\]/g, '')
    .trim();

  var bubble = msgEl.querySelector('.bubble');
  if (display && bubble) bubble.innerHTML = window.fmt(display);
  window.scrollBot();

  // GitHub action
  if (ghMatch) {
    var ghPayload;
    try { ghPayload = window.safeParseJSON(ghMatch[1]); }
    catch(e) { window.addAI('GitHub action JSON malformed. Rephrase your request.'); return; }
    window.showWhisper('Calling GitHub API...');
    var fetchEl = window.addAI('');
    var ghResult;
    try {
      ghResult = await window.githubAPI(ghPayload);
      fetchEl.querySelector('.bubble').innerHTML = '<em>Got data — summarising...</em>';
    } catch(e) {
      fetchEl.querySelector('.bubble').innerHTML = 'GitHub error: ' + window.esc(e.message);
      return;
    }
    var followUp = 'Live GitHub data for ' + ghPayload.action + ':\n\n'
      + JSON.stringify(ghResult, null, 2) + '\n\nSummarise this clearly in plain language.';
    pushConvo('assistant', raw);
    pushConvo('user', followUp);
    window.showWhisper('Summarising data...');
    try {
      var fetchBubble  = fetchEl.querySelector('.bubble');
      var followBuf    = '';
      var followCursor = document.createElement('span');
      followCursor.className = 'cursor';
      fetchBubble.appendChild(followCursor);
      var summary = await window.callAI(followUp, function(chunk) {
        followBuf += chunk;
        window.hideWhisper();
        fetchBubble.innerHTML = window.fmt(followBuf);
        fetchBubble.appendChild(followCursor);
        window.scrollBot();
      });
      window.hideWhisper();
      var clean = summary
        .replace(/\[ACTION:GITHUB\][\s\S]*?\[\/ACTION:GITHUB\]/g, '')
        .replace(/\[MEMORY\][\s\S]*?\[\/MEMORY\]/g, '').trim();
      fetchBubble.innerHTML = window.fmt(clean);
      pushConvo('assistant', summary);
    } catch(e) {
      window.hideWhisper();
      fetchEl.querySelector('.bubble').innerHTML = e.friendlyHTML || ('Error: ' + window.esc(e.message));
    }
    window.scrollBot();
    return;
  }

  // Deploy action
  if (depMatch) {
    var depAction;
    try { depAction = window.safeParseJSON(depMatch[1]); }
    catch(e) { window.addAI('Deploy action had malformed JSON. Please try again.'); return; }
    var cnt  = (depAction.files && depAction.files.length) || 0;
    var safe = JSON.stringify(depAction).replace(/"/g, '&quot;');
    window.addAI('<strong>Ready to deploy ' + cnt + ' file(s) to <code>' + depAction.repo + '</code></strong><br/><br/>'
      + '<button class="action-btn green" onclick="confirmDeploy(this,\'' + safe + '\')">Yes, deploy</button>'
      + '<button class="action-btn red" onclick="this.closest(\'.msg-wrap\').remove()">Cancel</button>');
  }

  // GBP action
  if (gbpMatch) {
    var gbpAction;
    try { gbpAction = window.safeParseJSON(gbpMatch[1]); }
    catch(e) { window.addAI('GBP action had malformed JSON. Please try again.'); return; }
    window.handleGBPAction(gbpAction);
  }
}

// ── Main send ──────────────────────────────────────────
async function sendMessageText(text) {
  scoreImplicitFeedback(text);
  window.detectMode(text);
  window.addUser(text);

  var dot = document.getElementById('statusDot');
  var txt = document.getElementById('statusText');
  if (dot) dot.className = 'status-dot thinking';
  if (txt) txt.textContent = window.currentMode === 'code' ? 'Code Mode — thinking...' : 'Thinking...';

  try {
    var deterministicReply = reasoningGate(text);
    if (deterministicReply) {
      if (deterministicReply !== '__ASYNC__') {
        window.addAI(deterministicReply);
        pushConvo('user', text);
        pushConvo('assistant', deterministicReply);
        if (!getCurrentSessionId()) window.set('currentSession', 'chat_' + Date.now());
        saveCurrentMessages();
      }
      return;
    }

    window.showWhisper(window.currentMode === 'code' ? 'Reading context...' : 'Thinking...');

    var ghContext = await window.prefetchGitHub(text);
    var msgToSend = ghContext ? text + ' [GitHub: ' + ghContext + ']' : text;

    pushConvo('user', text);

    var el     = window.addAI('');
    var bubble = el.querySelector('.bubble');
    var rawBuf = '';
    var cursor = document.createElement('span');
    cursor.className = 'cursor';
    bubble.appendChild(cursor);

    window.showWhisper(window.currentMode === 'code' ? 'Writing code...' : 'Writing response...');

    var response = await window.callAI(msgToSend, function(chunk) {
      rawBuf += chunk;
      window.hideWhisper();
      bubble.innerHTML = window.fmt(rawBuf);
      bubble.appendChild(cursor);
      window.scrollBot();
    });

    bubble.innerHTML = '';
    window.hideWhisper();
    await handleResponse(response, el);

    pushConvo('assistant', response);
    _pendingFeedback = { userMsg: text, aiReply: response };

    if (!getCurrentSessionId()) window.set('currentSession', 'chat_' + Date.now());
    saveCurrentMessages();

  } catch(e) {
    window.hideWhisper();
    window.hideTyping();
    if (e.isQuota) { window.markGeminiLimited(); window.queueMessage(text); }
    else { window.addAI(e.friendlyHTML || ('<strong>Error:</strong> ' + window.esc(e.message))); }
  }
}

async function sendMessage() {
  var inp  = document.getElementById('userInput');
  var text = inp ? inp.value.trim() : '';
  if (!text) return;
  var btn = document.getElementById('sendBtn');
  if (btn) btn.disabled = true;
  if (inp) { inp.value = ''; inp.style.height = 'auto'; }
  try { await sendMessageText(text); }
  finally {
    if (btn) btn.disabled = false;
    window.updateStatus();
    if (inp) inp.focus();
  }
}

// ── Expose to window ───────────────────────────────────
Object.assign(window, {
  pushConvo,
  getCompactHistory,
  getSessions,
  getCurrentSessionId,
  saveSession,
  loadSession,
  deleteSession,
  newChat,
  switchToSession,
  renderChatList,
  saveCurrentMessages,
  renderMessages,
  buildAdaptiveContext,
  sysPrompt,
  reasoningGate,
  _pendingFeedback,
  scoreImplicitFeedback,
  handleResponse,
  sendMessageText,
  sendMessage,
});
