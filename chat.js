// ═══════════════════════════════════════════════════════
// chat.js — Sessions, system prompt, response handler
// SYNAPSE Agent v2 — instructions fetch, autonomous mode,
//   extended thinking, attachments, audit trail
// ═══════════════════════════════════════════════════════

// ── Strip action tags — defined first, called everywhere ──────────────────
// Must be a plain function (not arrow, not const) so it hoists above all callers.
function stripActionTags(raw) {
  if (!raw) return '';
  return raw
    .replace(/\[ACTION:GITHUB\][\s\S]*?\[\/ACTION:GITHUB\]/g, '')
    .replace(/\[ACTION:DEPLOY\][\s\S]*?\[\/ACTION:DEPLOY\]/g, '')
    .replace(/\[ACTION:GBP\][\s\S]*?\[\/ACTION:GBP\]/g, '')
    .replace(/\[ACTION:PLAN\][\s\S]*?\[\/ACTION:PLAN\]/g, '')
    .replace(/\[MEMORY\][\s\S]*?\[\/MEMORY\]/g, '')
    .replace(/\[ACTION:[A-Z_:]*$/, '')          // strip partial tag at stream end
    .replace(/\[MEMORY[^\]]*$/, '')
    .trim();
}
window.stripActionTags = stripActionTags;  // expose immediately, before any module callbacks


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
  if (typeof window.showWelcome === 'function') window.showWelcome();
  renderChatList();
  if (typeof window.closeSidebar === 'function') window.closeSidebar();
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
  if (typeof window.closeSidebar === 'function') window.closeSidebar();
}

function renderChatList() {
  var list = document.getElementById('chatList');
  if (!list) return;
  var sessions  = getSessions();
  var currentId = getCurrentSessionId();
  if (!sessions.length) {
    list.innerHTML = '<div style="padding:12px 10px;font-size:11px;color:var(--text3)">No chats yet</div>'
      + '<div style="padding:4px 10px 8px">'
      + '<button onclick="window.clearAllChats && window.clearAllChats()" '
      + 'style="width:100%;padding:6px 10px;background:transparent;border:1px solid rgba(220,60,60,0.3);'
      + 'color:#e06060;border-radius:6px;font-size:11px;cursor:pointer;text-align:left">'
      + '&#x1F5D1; Clear all chats</button></div>';
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
  // Clear all chats button — always shown at bottom of sidebar
  list.innerHTML += '<div style="padding:4px 10px 8px">'
    + '<button onclick="window.clearAllChats && window.clearAllChats()" '
    + 'style="width:100%;padding:6px 10px;background:transparent;border:1px solid rgba(220,60,60,0.3);'
    + 'color:#e06060;border-radius:6px;font-size:11px;cursor:pointer;text-align:left">'
    + '&#x1F5D1; Clear all chats</button></div>';
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
  // Immediately push sessions to cloud so other devices see this conversation
  if (typeof window.syncKeyToCloud === 'function') {
    window.syncKeyToCloud('sessions', window.get('sessions', []));
  }
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
    if (profile.style.prefersBrief === true)    parts.push('Values concise replies — no filler, no padding — but always complete the thought fully.');
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

  var aboutLine = (about && about.length > 5) ? 'About: ' + about : 'ENT surgeon, Uganda. Highly technical and analytically sharp — appreciates well-placed jargon and precision language.';
  var prefsLine = (prefs && prefs.length > 5) ? 'Prefs: ' + prefs : 'Direct and complete. No padding, no filler — but never truncate. Length is set by the answer, not a cap. Jargon used with precision is welcome.';
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

  var synapseId = 'You are Synapse — a precision execution agent, not a generic assistant.\n'
    + '\n'
    + 'EXECUTION PHILOSOPHY — The Scofield Method:\n'
    + 'Before touching anything, you map the full terrain. You never execute blindly.\n'
    + 'Every task follows four phases — you always announce the phase:\n'
    + '\n'
    + '  1. SURVEY   — Read the landscape first. getRepo, listFiles root, listFiles key dirs.\n'
    + '               Goal: understand scope before committing to a plan.\n'
    + '  2. MAP      — State exactly what you found and what needs doing. No ambiguity.\n'
    + '               Goal: Fahad sees the full picture and can correct before any writes.\n'
    + '  3. PLAN     — Emit [ACTION:PLAN] with all tasks in sequence. One plan, fully specified.\n'
    + '               Goal: complete execution blueprint before first write.\n'
    + '  4. EXECUTE  — Run each step, report precisely, never stop mid-task without a real blocker.\n'
    + '               Goal: finish what was started in one session.\n'
    + '\n'
    + 'RULES:\n'
    + '  - Never ask Fahad to paste results — fetch them yourself with action tags.\n'
    + '  - Never say "waiting for results" or "let me know when ready" — just run the next action tag.\n'
    + '  - Never fire multiple action tags in one response — one tag, wait for result, then next.\n'
    + '  - If a step fails, diagnose it and continue the remaining steps. Do not abandon the session.\n'
    + '  - Never truncate mid-answer. If context is tight, summarise older steps but finish the current one.\n'
    + '  - Token efficiency: do reads in one sweep, batch writes in one DEPLOY, never re-read what you already have.\n'
    + '\n';

  // Cross-chat persistent memory — loaded from cloud, available on every device
  var crossMem = typeof window.getCrossMemorySummary === 'function' ? window.getCrossMemorySummary() : '';
  var memoryBlock = crossMem
    ? '=== LONG-TERM MEMORY (from previous sessions) ===\n' + crossMem + '\n=== END MEMORY ===\n\n'
    : '';

  var base = synapseId + memoryBlock + dateCtx + '\nAgent for ' + name + '. Active repo: '
    + (repo1 || 'none') + '. '
    + aboutLine + ' ' + prefsLine + factLine
    + (adaptiveCtx ? ' ' + adaptiveCtx : '');

  var strategicInstr = 'STRATEGIC MODE: Senior strategist+technologist. Think deeply, concrete actionable advice. Warm, witty.\n'
    + 'YOU HAVE LIVE API ACCESS — these are not hypothetical tools, they execute immediately when you emit the tag.\n'
    + 'GBP (Eritage ENT Care – Entebbe) LIVE ACTIONS:\n'
    + '\n'
    + '── READ (execute immediately, no approval needed) ──\n'
    + '  [ACTION:GBP]{"action":"getProfile"}[/ACTION:GBP]\n'
    + '  [ACTION:GBP]{"action":"getReviews"}[/ACTION:GBP]\n'
    + '  [ACTION:GBP]{"action":"getPosts","limit":5}[/ACTION:GBP]\n'
    + '  [ACTION:GBP]{"action":"listPhotos"}[/ACTION:GBP]\n'
    + '  [ACTION:GBP]{"action":"getQuestions","limit":10}[/ACTION:GBP]\n'
    + '  [ACTION:GBP]{"action":"getInsights","startDate":"2026-02-01","endDate":"2026-03-01"}[/ACTION:GBP]\n'
    + '\n'
    + '── WRITE (draft + get Fahad approval first) ──\n'
    + '  [ACTION:GBP]{"action":"updatePhoneNumbers","primaryPhone":"+256...","additionalPhones":["+256..."]}[/ACTION:GBP]\n'
    + '  [ACTION:GBP]{"action":"updateWebsite","websiteUri":"https://..."}[/ACTION:GBP]\n'
    + '  [ACTION:GBP]{"action":"updateAddress","address":{"regionCode":"UG","locality":"Entebbe","addressLines":["Plot 34"]}}[/ACTION:GBP]\n'
    + '  [ACTION:GBP]{"action":"updateCategory","primaryCategory":{"name":"categories/gcid:otolaryngologist"}}[/ACTION:GBP]\n'
    + '  [ACTION:GBP]{"action":"updateDescription","description":"text"}[/ACTION:GBP]\n'
    + '  [ACTION:GBP]{"action":"updateHours","hours":{"MONDAY":{"open":"08:00","close":"20:00"}}}[/ACTION:GBP]\n'
    + '  [ACTION:GBP]{"action":"updateSpecialHours","specialHours":[{"date":"2026-12-25","closed":true}]}[/ACTION:GBP]\n'
    + '  [ACTION:GBP]{"action":"createPost","content":"text"}[/ACTION:GBP]\n'
    + '  [ACTION:GBP]{"action":"updatePost","postName":"accounts/.../localPosts/...","content":"new text"}[/ACTION:GBP]\n'
    + '  [ACTION:GBP]{"action":"deletePost","postName":"accounts/.../localPosts/..."}[/ACTION:GBP]\n'
    + '  [ACTION:GBP]{"action":"replyReview","reviewId":"...","reply":"text"}[/ACTION:GBP]\n'
    + '  [ACTION:GBP]{"action":"deleteReviewReply","reviewId":"..."}[/ACTION:GBP]\n'
    + '  [ACTION:GBP]{"action":"uploadPhoto","sourceUrl":"https://...","category":"EXTERIOR"}[/ACTION:GBP]\n'
    + '  [ACTION:GBP]{"action":"deletePhoto","mediaName":"accounts/.../media/..."}[/ACTION:GBP]\n'
    + '  [ACTION:GBP]{"action":"answerQuestion","questionId":"...","answer":"text"}[/ACTION:GBP]\n'
    + '  [ACTION:GBP]{"action":"deleteAnswer","questionId":"..."}[/ACTION:GBP]\n'
    + '\n'
    + 'GBP RULES:\n'
    + '  - NEVER say you cannot do a GBP action — you have full live access now.\n'
    + '  - For WRITE: always show exactly what you will change, get explicit approval, then emit the tag.\n'
    + '  - READ tags execute immediately and silently.\n'
    + '  - Never output raw tag text to the user.\n'
    + '\n'
    + 'GITHUB (available in strategic mode too — ONE tag per response):\n'
    + '  [ACTION:GITHUB]{"action":"listRepos"}[/ACTION:GITHUB]\n'
    + '  [ACTION:GITHUB]{"action":"getRepo","repo":"owner/repo"}[/ACTION:GITHUB]\n'
    + '  [ACTION:GITHUB]{"action":"listFiles","repo":"owner/repo","path":"src"}[/ACTION:GITHUB]\n'
    + '  [ACTION:GITHUB]{"action":"getFile","repo":"owner/repo","path":"src/App.tsx"}[/ACTION:GITHUB]\n'
    + '  [ACTION:GITHUB]{"action":"pushFile","repo":"owner/repo","path":"f","content":"...","commitMessage":"msg"}[/ACTION:GITHUB]\n'
    + '  For multi-step tasks use PLAN tag (see CODE MODE instructions).';

  var codeInstr = 'CODE MODE: Precise status for every operation. Full files only. No write without yes.\n'
    + '\n'
    + 'GITHUB ACTIONS — ONE tag per response, wait for result before next:\n'
    + '  [ACTION:GITHUB]{"action":"listRepos"}[/ACTION:GITHUB]\n'
    + '  [ACTION:GITHUB]{"action":"getRepo","repo":"owner/repo"}[/ACTION:GITHUB]\n'
    + '  [ACTION:GITHUB]{"action":"listFiles","repo":"owner/repo","path":"src"}[/ACTION:GITHUB]\n'
    + '  [ACTION:GITHUB]{"action":"getFile","repo":"owner/repo","path":"src/App.tsx"}[/ACTION:GITHUB]\n'
    + '  [ACTION:GITHUB]{"action":"listCommits","repo":"owner/repo","limit":10}[/ACTION:GITHUB]\n'
    + '  [ACTION:GITHUB]{"action":"getDiff","repo":"owner/repo","base":"sha1","head":"sha2"}[/ACTION:GITHUB]\n'
    + '  [ACTION:GITHUB]{"action":"analyzeImpact","repo":"owner/repo"}[/ACTION:GITHUB]\n'
    + '  [ACTION:GITHUB]{"action":"scanSecrets","repo":"owner/repo","path":"f"}[/ACTION:GITHUB]\n'
    + '  [ACTION:GITHUB]{"action":"pushFile","repo":"owner/repo","path":"f","content":"...","commitMessage":"msg"}[/ACTION:GITHUB]\n'
    + '  [ACTION:GITHUB]{"action":"revertFile","repo":"owner/repo","path":"f","commitSha":"sha"}[/ACTION:GITHUB]\n'
    + '\n'
    + 'PLAN TAG — use for any task with 3+ steps (reads before writes, always):\n'
    + '  [ACTION:PLAN]{"goal":"what you are doing","tasks":[\n'
    + '    {"action":"getRepo","repo":"owner/repo"},\n'
    + '    {"action":"listFiles","repo":"owner/repo","path":"src"},\n'
    + '    {"action":"getFile","repo":"owner/repo","path":"src/App.tsx"},\n'
    + '    {"action":"pushFile","repo":"owner/repo","path":"src/App.tsx","content":"...","commitMessage":"fix: ..."}\n'
    + '  ]}[/ACTION:PLAN]\n'
    + '\n'
    + 'RULES:\n'
    + '  - ONE [ACTION:GITHUB] tag per response. Closing tag always [/ACTION:GITHUB].\n'
    + '  - NEVER use readFile or analyzeRepo — use getFile and listFiles.\n'
    + '  - Survey order: getRepo → listFiles root → listFiles subdirs → getFile key files.\n'
    + '  - PLAN for complex tasks: reads first, writes after, synthesise at end.\n'
    + '  - Never push without explicit approval from Fahad.'


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
  if (/^(ok|okay|got it|noted|sure|alright|sounds good)[!.\s]*$/.test(t)) {
    // Don't short-circuit if recent conversation has GBP/GitHub context — let AI handle it
    var recentConv = window.get('conversation', []).slice(-4);
    var hasActiveContext = recentConv.some(function(m) {
      return /ACTION:|gbp|github|post|update|deploy|review/i.test(m.content || '');
    });
    if (hasActiveContext) return null; // fall through to full AI call
    return 'Got it. What would you like to do next?';
  }
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
  if (/last.*post|recent.*post|get.*post|gbp.*post/i.test(t))   { pushConvo('user', text); window.handleGBPAction({ action: 'getPosts', limit: 5 }); return '__ASYNC__'; }
  if (/gbp.*profile/i.test(t))                                 { pushConvo('user', text); window.handleGBPAction({ action: 'getProfile'   }); return '__ASYNC__'; }
  if (/check.*review|reply.*review|get.*review/i.test(t))      { pushConvo('user', text); window.handleGBPAction({ action: 'getReviews'   }); return '__ASYNC__'; }
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
  // Normalize wrong closing tags (AI sometimes emits [/ACTION:GBP] instead of [/ACTION:GITHUB])
  var rawFixed  = raw.replace(/\[ACTION:GITHUB\]([\s\S]*?)\[\/ACTION:GBP\]/g, '[ACTION:GITHUB]$1[/ACTION:GITHUB]');
  var ghMatches = Array.from(rawFixed.matchAll(/\[ACTION:GITHUB\]([\s\S]*?)\[\/ACTION:GITHUB\]/g));
  var ghMatch   = ghMatches.length ? ghMatches[0] : null;  // keep compat — first match for existing flow
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
    // Also push to cross-chat cloud memory for cross-device persistence
    if (fact && typeof window.pushCrossMemory === 'function') window.pushCrossMemory(fact);
  });

  if (/switching to.*code mode|entering code mode/i.test(raw))     window.setMode('code');
  if (/switching to.*strategic mode|back to strategic/i.test(raw)) window.setMode('strategic');

  // Auto-extract facts from agent reply and persist to cross-chat memory
  if (typeof window.pushCrossMemory === 'function') {
    var cleanForMem = raw.replace(/\[ACTION:[\s\S]*?\[\/ACTION:[A-Z]+\]/g, '').replace(/\[MEMORY[\s\S]*?\[\/MEMORY\]/g, '');
    var autoRe = /(?:noted[:,]\s*|remembered?[:,]\s*|(?:fahad|you)\s+(?:prefer|want|like|use|own|run|are)s?\s+)([^.!?\n]{10,120})/gi;
    var am;
    while ((am = autoRe.exec(cleanForMem)) !== null) {
      window.pushCrossMemory(am[1].trim());
    }
  }

  // Strip ALL action tags before displaying — user never sees raw syntax
  var display = rawFixed
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
  // If AI emitted multiple tags (it shouldn't but sometimes does), warn and only run first
  if (ghMatches.length > 1) {
    console.warn('[handleResponse] AI emitted', ghMatches.length, 'GitHub action tags — only executing the first. System prompt should enforce one-at-a-time.');
  }
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
                    : ghAction === 'getRepo'      ? 'Fetching repo info for ' + (ghPayload.repo||'') + '...'
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
      + '\n[/TOOL_RESULT]\n\nRespond based on this result. Be specific and complete — never truncate mid-answer. No raw JSON.';

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

  // Autonomous plan — commit agent message first, then execute
  if (planMatch) {
    var plan;
    try { plan = window.safeParseJSON(planMatch[1]); } catch(e) { window.addAI('Plan JSON malformed.'); return; }
    pushConvo('assistant', raw);
    var planEl = window.addAI('');
    await executePlan(plan, planEl);
  }
}

// ── Autonomous plan executor — Scofield method ─────────────
// Survey → Map → Plan → Execute. Uses showPlanningPanel for live visual tracker.
async function executePlan(plan, msgEl) {
  var tasks  = plan.tasks  || [];
  var goal   = plan.goal   || 'Complete task';
  var survey = plan.survey || [];   // optional pre-read steps (survey phase)

  if (!tasks.length) { if (msgEl) msgEl.querySelector('.bubble').innerHTML = 'No tasks in plan.'; return; }

  var repo = window.get('repo1', '');

  // Build step labels for the planning panel
  var stepLabels = tasks.map(function(t) {
    if (t.action === 'getFile' || t.action === 'readFile') return 'Read ' + (t.file || t.path || 'file');
    if (t.action === 'listFiles')    return 'List ' + (t.path || 'directory');
    if (t.action === 'pushFile')     return 'Push ' + (t.file || t.path || 'file');
    if (t.action === 'scanSecrets')  return 'Scan ' + (t.file || 'file') + ' for secrets';
    if (t.action === 'getRepo')      return 'Fetch repo metadata';
    if (t.action === 'listCommits')  return 'Read commit history';
    if (t.action === 'analyzeImpact') return 'Analyse change impact';
    return t.action || 'Task';
  });

  // Create planning panel — replaces the empty msgEl bubble
  var panel = window.showPlanningPanel(goal, stepLabels);
  // Remove original empty msgEl since panel creates its own
  if (msgEl && msgEl.parentNode) msgEl.parentNode.removeChild(msgEl);

  var results = {};
  var errors  = 0;

  for (var i = 0; i < tasks.length; i++) {
    var task   = tasks[i];
    var taskRepo = task.repo || repo;

    panel.setActive(i, stepLabels[i] + '...');
    await new Promise(function(r) { setTimeout(r, 80); }); // let UI paint

    try {
      if (task.action === 'readFile' || task.action === 'getFile') {
        var filePath = task.file || task.path;
        var r = await window.githubAPI({ action: 'getFile', repo: taskRepo, path: filePath });
        task._result = r;
        results[filePath] = r.content;
        panel.setDone(i, filePath + ' · ' + Math.round((r.content || '').length / 1024 * 10) / 10 + ' KB');

      } else if (task.action === 'listFiles') {
        var dirPath = task.path || '';
        var r2 = await window.githubAPI({ action: 'listFiles', repo: taskRepo, path: dirPath });
        task._result = r2;
        var fileCount = (r2.files || []).length;
        panel.setDone(i, fileCount + ' items in /' + (dirPath || 'root'));

      } else if (task.action === 'getRepo') {
        var r3 = await window.githubAPI({ action: 'getRepo', repo: taskRepo });
        task._result = r3;
        panel.setDone(i, (r3.language || 'unknown') + ' · ' + (r3.description || 'no description').slice(0, 60));

      } else if (task.action === 'listCommits') {
        var r4 = await window.githubAPI({ action: 'listCommits', repo: taskRepo, limit: task.limit || 10 });
        task._result = r4;
        panel.setDone(i, (r4.commits || []).length + ' commits');

      } else if (task.action === 'scanSecrets') {
        var r5 = await window.githubAPI({ action: 'scanSecrets', repo: taskRepo, path: task.file });
        task._result = r5;
        panel.setDone(i, r5.clean ? 'Clean — no secrets found' : r5.secrets.length + ' secret(s) detected');

      } else if (task.action === 'pushFile') {
        var pushContent = task.content || (task._sourceResult && task._sourceResult.content) || '';
        var r6 = await window.pushFileWithRetry({
          repo: taskRepo, path: task.file || task.path,
          content: pushContent,
          commitMessage: task.commitMessage || ('synapse: ' + goal.slice(0, 60)),
          branch: task.branch || 'main',
        });
        panel.setDone(i, 'SHA ' + (r6.sha || '?').slice(0, 8) + ' → ' + (task.branch || 'main'));
        window.logAuditEntry({ action: 'push', repo: taskRepo, path: task.file || task.path, sha: r6.sha, message: task.commitMessage });

      } else if (task.action === 'analyzeImpact') {
        var r7 = await window.githubAPI({ action: 'analyzeImpact', repo: taskRepo });
        task._result = r7;
        panel.setDone(i, 'Impact analysis complete');

      } else {
        panel.setError(i, 'Unknown action: ' + task.action);
        errors++;
        continue;
      }

    } catch(e) {
      panel.setError(i, e.message.slice(0, 80));
      errors++;
    }

    window.scrollBot();
  }

  // Summary
  var doneCount = tasks.length - errors;
  panel.finish(
    doneCount + '/' + tasks.length + ' steps completed' + (errors ? ' · ' + errors + ' error(s)' : '') + ' — review above.',
    errors === 0
  );

  // Build tool result from all gathered data and feed back to AI for synthesis
  var gathered = tasks.filter(function(t) { return t._result; }).map(function(t) {
    return { action: t.action, file: t.file || t.path, result: t._result };
  });

  if (gathered.length) {
    var toolResult = '[TOOL_RESULT plan:complete]\n'
      + JSON.stringify({ goal: goal, results: gathered }, null, 2).slice(0, 8000)
      + '\n[/TOOL_RESULT]\n\nYou have all the data. Now give Fahad a complete, specific analysis. No truncation.';

    pushConvo('user', toolResult);
    var synthEl     = window.addAI('');
    var synthBubble = synthEl.querySelector('.bubble');
    var buf = '';
    var cursor = document.createElement('span'); cursor.className = 'cursor';
    synthBubble.appendChild(cursor);
    window.showStatusExact('Synthesising findings...');

    try {
      var synthesis = await window.callAI(toolResult, function(chunk) {
        buf += chunk;
        window.hideWhisper();
        synthBubble.innerHTML = window.fmt(stripActionTags(buf));
        synthBubble.appendChild(cursor);
        window.scrollBot();
      });
      synthBubble.innerHTML = window.fmt(stripActionTags(synthesis));
      window.scrollBot();
      pushConvo('assistant', synthesis);
      saveCurrentMessages();
    } catch(e) {
      synthBubble.innerHTML = '&#x274C; Synthesis failed: ' + window.esc(e.message);
    }
  }
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
  stripActionTags,
  pushConvo, getCompactHistory,
  getSessions, getCurrentSessionId, saveSession, loadSession, deleteSession,
  newChat, switchToSession, renderChatList, saveCurrentMessages, renderMessages,
  buildAdaptiveContext, sysPrompt, reasoningGate,
  _pendingFeedback, scoreImplicitFeedback, handleResponse,
  sendMessageText, sendMessage,
  loadInstructions, getInstructions,
  executePlan, logAuditEntry, getAuditLog,
});
