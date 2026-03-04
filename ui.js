// ═══════════════════════════════════════════════════════
// ui.js — All DOM manipulation and UI updates
// SYNAPSE Agent
// No API calls in this file. Pure DOM in/out.
// ═══════════════════════════════════════════════════════

// ── Utility: escape HTML ───────────────────────────────
function esc(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Utility: markdown → HTML ───────────────────────────
function fmt(text) {
  if (!text) return '';
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, function(_, lang, code) {
    return '<pre><code>' + code.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</code></pre>';
  });
  text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');
  text = text.replace(/^### (.+)$/gm, '<strong style="font-size:13px;color:var(--accent)">$1</strong>');
  text = text.replace(/^## (.+)$/gm,  '<strong style="font-size:14px">$1</strong>');
  text = text.replace(/^---$/gm, '<hr/>');
  text = text.replace(/\n/g, '<br/>');
  return text;
}

// ── Utility: safe JSON parse (strips markdown fences) ──
function safeParseJSON(str) {
  var c = String(str).trim()
    .replace(/^```json\s*/i, '').replace(/```\s*$/, '')
    .replace(/^`+|`+$/g, '').trim();
  return JSON.parse(c);
}

// ── Scroll messages to bottom ──────────────────────────
function scrollBot() {
  var m = document.getElementById('messages');
  if (m) setTimeout(function() { m.scrollTop = m.scrollHeight; }, 60);
}

// ── Whisper (center-screen status) ────────────────────
function showWhisper(text) {
  var w = document.getElementById('whisper');
  if (w) { w.textContent = text; w.classList.add('show'); }
}
function hideWhisper() {
  var w = document.getElementById('whisper');
  if (w) { w.classList.remove('show'); w.textContent = ''; }
}

// ── Status bar ─────────────────────────────────────────
function updateStatus() {
  var n          = window.get('userName', '');
  var rn         = window.get('repo1name', '');
  var activeRepo = rn || (window.get('repo1', '').split('/')[1] || '');
  var brainLabels = { auto: 'Auto', gemini: 'Gemini', claude: 'Claude', openai: 'GPT-4o' };
  var activeBrain = window._lastBrainUsed || window.get('brain', 'auto');
  var brainName   = brainLabels[activeBrain] || 'Auto';

  var dot = document.getElementById('statusDot');
  var txt = document.getElementById('statusText');
  if (dot) dot.className = 'status-dot ready';
  if (txt) txt.textContent = 'Ready · ' + brainName
    + (activeRepo ? ' · ' + activeRepo : '')
    + (n ? ' · ' + n : '');

  if (n) {
    var at = document.getElementById('agentTitle');
    var wt = document.getElementById('welcomeTitle');
    if (at) at.textContent = n + "'s Agent";
    if (wt) wt.textContent = 'Welcome back, ' + n + ' ✦';
  }
  if (rn) {
    var as = document.getElementById('agentSubtitle');
    if (as) as.textContent = 'SYNAPSE · ' + rn;
  }
}

// ── Countdown (Gemini quota) ───────────────────────────
var geminiResetAt     = 0;
var countdownInterval = null;
var messageQueue      = [];

function nextMidnightPacific() {
  var offset  = 8 * 60 * 60 * 1000;
  var pacific = new Date(Date.now() - offset);
  pacific.setHours(24, 0, 0, 0);
  return pacific.getTime() + offset;
}
function markGeminiLimited() { geminiResetAt = nextMidnightPacific(); window.set('gemini_reset_at', geminiResetAt); startCountdown(); }
function isGeminiLimited()   { if (!geminiResetAt) geminiResetAt = window.get('gemini_reset_at', 0); return geminiResetAt > Date.now(); }
function clearGeminiLimit()  { geminiResetAt = 0; window.set('gemini_reset_at', 0); }

function formatCountdown(ms) {
  if (ms <= 0) return '0s';
  var s = Math.floor(ms / 1000), h = Math.floor(s / 3600); s -= h * 3600;
  var m = Math.floor(s / 60); s -= m * 60;
  if (h > 0) return h + 'h ' + m + 'm';
  if (m > 0) return m + 'm ' + s + 's';
  return s + 's';
}

function startCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(function() {
    if (!isGeminiLimited()) {
      clearInterval(countdownInterval); countdownInterval = null;
      clearGeminiLimit(); updateStatus(); flushQueue(); return;
    }
    var dot = document.getElementById('statusDot');
    var txt = document.getElementById('statusText');
    if (dot) dot.className = 'status-dot';
    if (txt) txt.textContent = 'Quota resets in ' + formatCountdown(geminiResetAt - Date.now());
  }, 1000);
}

function queueMessage(text) {
  messageQueue.push(text);
  window.set('msg_queue', messageQueue);
  addAI('<strong>Gemini quota reached.</strong> Resets in <strong>'
    + formatCountdown(geminiResetAt - Date.now())
    + '</strong>. Tip: switch to Claude in Settings — it uses your Anthropic key with no daily limit.');
}

async function flushQueue() {
  var saved = window.get('msg_queue', []);
  if (saved.length && !messageQueue.length) messageQueue = saved;
  window.set('msg_queue', []);
  if (!messageQueue.length) return;
  var queued = messageQueue.splice(0);
  addAI('<strong>Quota restored!</strong> Sending ' + queued.length
    + ' queued message' + (queued.length > 1 ? 's' : '') + '...');
  for (var i = 0; i < queued.length; i++) {
    try {
      await window.sendMessageText(queued[i]);
    } catch(e) {
      console.error('[flushQueue] failed to send queued message:', e.message);
    }
    await new Promise(function(r) { setTimeout(r, 800); });
  }
}

// ── Message bubbles ────────────────────────────────────
function _addUser(text, animate) {
  var w = document.getElementById('welcomeScreen');
  if (w) w.remove();
  var msgs = document.getElementById('messages');
  if (!msgs) return;
  var d = document.createElement('div');
  d.className = 'msg-wrap user';
  if (!animate) d.style.animation = 'none';
  d.innerHTML = '<div class="bubble">' + esc(text) + '</div>';
  msgs.appendChild(d);
  scrollBot();
}
function addUser(text) { _addUser(text, true); }

function _addAI(html, animate) {
  var msgs = document.getElementById('messages');
  if (!msgs) return document.createElement('div'); // safe fallback
  var d = document.createElement('div');
  d.className = 'msg-wrap ai';
  if (!animate) d.style.animation = 'none';
  d.innerHTML = '<div class="bubble">' + html + '</div>';
  msgs.appendChild(d);
  scrollBot();
  return d;
}
function addAI(html) { return _addAI(html, true); }

function showTyping() {
  var msgs = document.getElementById('messages');
  if (!msgs) return;
  var d = document.createElement('div');
  d.className = 'typing-wrap'; d.id = 'typing';
  d.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
  msgs.appendChild(d);
  scrollBot();
}
function hideTyping() { var t = document.getElementById('typing'); if (t) t.remove(); }

// ── Welcome screen ─────────────────────────────────────
function showWelcome() {
  var msgs = document.getElementById('messages');
  if (!msgs || document.getElementById('welcomeScreen')) return;
  var n = window.get('userName', 'Fahad');
  var w = document.createElement('div');
  w.className = 'welcome'; w.id = 'welcomeScreen';
  w.innerHTML = '<div class="welcome-logo synapse-pulse">'
    + '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="56" height="56" style="animation:synapsePulse 3s ease-in-out infinite;">'
    + '<defs><linearGradient id="wlg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#a78bfa"/><stop offset="100%" style="stop-color:#60a5fa"/></linearGradient></defs>'
    + '<polygon points="20,2 35,10.5 35,29.5 20,38 5,29.5 5,10.5" fill="rgba(124,106,247,0.08)" stroke="url(#wlg)" stroke-width="2" stroke-linejoin="round"/>'
    + '<circle cx="20" cy="20" r="4" fill="url(#wlg)"/>'
    + '<circle cx="12" cy="15" r="2.5" fill="url(#wlg)" opacity="0.75"/>'
    + '<circle cx="28" cy="15" r="2.5" fill="url(#wlg)" opacity="0.75"/>'
    + '<circle cx="12" cy="25" r="2.5" fill="url(#wlg)" opacity="0.55"/>'
    + '<circle cx="28" cy="25" r="2.5" fill="url(#wlg)" opacity="0.55"/>'
    + '<line x1="20" y1="20" x2="12" y2="15" stroke="url(#wlg)" stroke-width="1.5" opacity="0.5"/>'
    + '<line x1="20" y1="20" x2="28" y2="15" stroke="url(#wlg)" stroke-width="1.5" opacity="0.5"/>'
    + '<line x1="20" y1="20" x2="12" y2="25" stroke="url(#wlg)" stroke-width="1.5" opacity="0.4"/>'
    + '<line x1="20" y1="20" x2="28" y2="25" stroke="url(#wlg)" stroke-width="1.5" opacity="0.4"/>'
    + '</svg></div>'
    + '<h1 id="welcomeTitle">Good to see you, ' + esc(n) + '</h1>'
    + '<p>Your personal cognitive extension. I think, plan, build, and deploy.</p>'
    + '<div class="suggestions">'
    + '<div class="suggestion" onclick="quickSend(\'List all my GitHub repositories\')">&#x1F4C1; List my repos</div>'
    + '<div class="suggestion" onclick="quickSend(\'What strategies can grow my clinic patient base?\')">&#x1F3E5; Grow my clinic</div>'
    + '<div class="suggestion" onclick="quickSend(\'Give me an SEO audit plan for eritageentcare.com\')">&#x1F50D; SEO audit plan</div>'
    + '<div class="suggestion" onclick="quickSend(\'What have you learned about how I like to work?\')">&#x1F9E0; What you\'ve learned</div>'
    + '</div>';
  msgs.appendChild(w);
}

// Weekly digest in chat (Monday mornings)
function showWeeklyDigestInChat(digest) {
  var msgs = document.getElementById('messages');
  if (!msgs) return;
  if (msgs.querySelectorAll('.msg-wrap').length > 0) return;
  var w = document.getElementById('welcomeScreen');
  if (w) w.remove();
  var d = document.createElement('div');
  d.className = 'msg-wrap ai';
  d.style.animation = 'none';
  d.innerHTML = '<div class="bubble">'
    + '<div style="font-size:11px;color:var(--text3);margin-bottom:10px;text-transform:uppercase;letter-spacing:0.08em;">&#x1F4C6; Weekly digest — '
    + (window.get('weeklyDigestDate', '') || 'this week') + '</div>'
    + fmt(digest)
    + '</div>';
  msgs.appendChild(d);
  scrollBot();
}

// ── Mode toggle ────────────────────────────────────────
var currentMode = 'strategic';

function setMode(mode) {
  currentMode = mode;
  window.set('mode', mode);
  var bs = document.getElementById('btnStrategic');
  var bc = document.getElementById('btnCode');
  var badge = document.getElementById('modeBadge');
  var label = document.getElementById('modeLabel');
  if (bs) bs.classList.toggle('active', mode === 'strategic');
  if (bc) bc.classList.toggle('active', mode === 'code');
  if (mode === 'code') {
    if (badge) badge.className = 'mode-badge code';
    if (label) label.textContent = 'Code Mode';
  } else {
    if (badge) badge.className = 'mode-badge strategic';
    if (label) label.textContent = 'Strategic Mode';
  }
}

function detectMode(text) {
  var codeSignals = /\b(code|github|repo|deploy|push|commit|file|function|bug|refactor|html|css|js|javascript|api|edit|update|fix|build|implement|create.*file|write.*code|show.*code)\b/i;
  if (codeSignals.test(text) && currentMode !== 'code')       { setMode('code');      return true; }
  if (!codeSignals.test(text) && currentMode !== 'strategic') { setMode('strategic'); }
  return false;
}

// ── Theme toggle ───────────────────────────────────────
function toggleTheme() {
  var isLight = document.documentElement.classList.toggle('light');
  var btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = isLight ? '🌑' : '🌙';
  window.set('theme', isLight ? 'light' : 'dark');
}

function applyTheme() {
  var t = window.get('theme', 'dark');
  if (t === 'light') {
    document.documentElement.classList.add('light');
    var btn = document.getElementById('themeToggle');
    if (btn) btn.textContent = '🌑';
  }
}

// ── Sidebar ────────────────────────────────────────────
function toggleSidebar() {
  var sb  = document.getElementById('sidebar');
  var bd  = document.getElementById('sidebarBackdrop');
  if (sb) sb.classList.toggle('open');
  if (bd) bd.classList.toggle('show');
}
function closeSidebar() {
  var sb = document.getElementById('sidebar');
  var bd = document.getElementById('sidebarBackdrop');
  if (sb) sb.classList.remove('open');
  if (bd) bd.classList.remove('show');
}

// ── Settings overlay ───────────────────────────────────
function openSettings() {
  var sn   = document.getElementById('s_name');
  var sb   = document.getElementById('s_brain');
  var sa   = document.getElementById('s_about');
  var sp   = document.getElementById('s_prefs');
  var mb   = document.getElementById('memoryBox');
  var ov   = document.getElementById('settingsOverlay');
  var arn  = document.getElementById('activeRepoName');
  var pb   = document.getElementById('profileBox');

  if (sn)  sn.value  = window.get('userName', '');
  if (sb)  sb.value  = window.get('brain', 'gemini');
  if (sa)  sa.value  = window.get('about', '');
  if (sp)  sp.value  = window.get('prefs', '');

  if (arn) {
    var r1 = window.get('repo1', '');
    arn.textContent = r1 || 'None detected yet';
    arn.style.color = r1 ? 'var(--text)' : 'var(--text3)';
  }

  var facts = window.get('learnedFacts', []);
  if (mb) mb.textContent = facts.length ? facts.join('\n') : 'Nothing saved yet.';

  if (pb) {
    var ap = window._adaptiveProfile;
    if (ap) {
      var lines = [];
      if (ap.totalInteractions)
        lines.push('Conversations tracked: ' + ap.totalInteractions);
      if (ap.style && ap.style.avgReplyWordCount)
        lines.push('Your preferred reply length: ~' + ap.style.avgReplyWordCount + ' words');
      if (ap.recurringTopics && ap.recurringTopics.length)
        lines.push('Top topics: ' + ap.recurringTopics.slice(0, 4)
          .map(function(t) { return t.topic.replace(/_/g, ' '); }).join(', '));
      if (ap.observations && ap.observations.length)
        ap.observations.forEach(function(o) { lines.push(o); });
      var digest = window.get('weeklyDigest', '');
      if (digest) lines.push('\n— Last weekly digest —\n' + digest.slice(0, 300) + (digest.length > 300 ? '...' : ''));
      pb.textContent = lines.length ? lines.join('\n') : 'Not enough interactions yet. Builds over time.';
    } else {
      pb.textContent = 'Not enough interactions yet. Builds over time.';
    }
  }

  if (ov) ov.classList.add('open');
}

function closeSettings() {
  var ov = document.getElementById('settingsOverlay');
  if (ov) ov.classList.remove('open');
}

function saveSettings() {
  var sn    = document.getElementById('s_name');
  var sb    = document.getElementById('s_brain');
  var sa    = document.getElementById('s_about');
  var sp    = document.getElementById('s_prefs');
  var newName  = sn  ? sn.value.trim()  : '';
  var newAbout = sa  ? sa.value.trim()  : '';
  var newPrefs = sp  ? sp.value.trim()  : '';
  var newBrain = sb  ? sb.value         : 'auto';

  // Sync all changed settings keys to cloud (syncKeyToCloud is in api.js)
  if (typeof window.syncKeyToCloud === 'function') {
    window.syncKeyToCloud('userName', newName);
    window.syncKeyToCloud('about',    newAbout);
    window.syncKeyToCloud('prefs',    newPrefs);
    window.syncKeyToCloud('brain',    newBrain);
  }

  window.set('userName', newName);
  window.set('brain',    newBrain);
  window.set('about',    newAbout);
  window.set('prefs',    newPrefs);
  window.set('setupDone', true);
  closeSettings();
  updateStatus();
  var n = window.get('userName', '');
  addAI('Settings saved' + (n ? ', ' + n : '') + '. What would you like to work on?');
}

function clearMemory() {
  if (!confirm('Clear all agent memory?')) return;
  window.set('learnedFacts', []);
  addAI('Memory cleared.');
  openSettings();
}

function clearAllChats() {
  if (!confirm('Delete all chat history?')) return;
  window.set('sessions', []);
  window.set('conversation', []);
  window.set('currentSession', null);
  window.renderChatList();
  window.renderMessages([]);
  showWelcome();
  closeSettings();
}

function toggleSection(id, rowEl) {
  var col = document.getElementById(id);
  var row = rowEl.closest ? rowEl.closest('.settings-row') : rowEl;
  if (!col) return;
  var isOpen = col.classList.contains('open');
  document.querySelectorAll('.settings-collapsible').forEach(function(el) { el.classList.remove('open'); });
  document.querySelectorAll('.settings-row').forEach(function(el) { el.classList.remove('open'); });
  if (!isOpen) { col.classList.add('open'); if (row) row.classList.add('open'); }
}

function clearActiveRepo() {
  window.set('repo1', '');
  window.set('repo1name', '');
  window._repoList = null;
  Object.keys(window._ghCache).forEach(function(k) { delete window._ghCache[k]; });
  var el = document.getElementById('activeRepoName');
  if (el) { el.textContent = 'None detected yet'; el.style.color = 'var(--text3)'; }
  updateStatus();
  addAI('Active repo cleared. Just mention a repo by name in conversation and I will switch to it automatically.');
  closeSettings();
}

// ── Input helpers ──────────────────────────────────────
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}
function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); window.sendMessage(); }
}
function quickSend(t) {
  var inp = document.getElementById('userInput');
  if (inp) inp.value = t;
  window.sendMessage();
}

// ── Deploy UI ──────────────────────────────────────────
async function executeDeploy(action, msgEl) {
  var repo           = action.repo;
  var branch         = action.branch;
  var commit_message = action.commit_message;
  var files          = action.files;
  var bubble         = msgEl.querySelector('.bubble');
  var log            = '';

  function appendLog(line, cls) {
    log += '<div class="' + (cls || '') + '">' + esc(line) + '</div>';
    var dl = bubble.querySelector('.deploy-log');
    if (dl) dl.innerHTML = log;
    scrollBot();
  }

  bubble.innerHTML = '<strong>Deploying...</strong>'
    + '<div class="deploy-bar-wrap"><div class="deploy-bar" id="dBar"></div></div>'
    + '<div class="deploy-label" id="dLabel">Starting...</div>'
    + '<div class="deploy-log"></div>';

  for (var i = 0; i < files.length; i++) {
    var f    = files[i];
    var dBar = bubble.querySelector('#dBar');
    var dLbl = bubble.querySelector('#dLabel');
    if (dBar) dBar.style.width = Math.round((i / files.length) * 100) + '%';
    if (dLbl) dLbl.textContent = i + '/' + files.length + ' — ' + f.path;
    appendLog('> ' + f.path, 'info');
    try {
      await window.githubAPI({
        action: 'pushFile', repo: repo, branch: branch || 'main',
        path: f.path, content: f.content,
        commitMessage: commit_message || 'update: ' + f.path,
      });
      appendLog('  pushed', 'ok');
    } catch(e) { appendLog('  ERROR: ' + e.message, 'err'); }
    await new Promise(function(r) { setTimeout(r, 280); });
  }

  var dBar2 = bubble.querySelector('#dBar');
  var dLbl2 = bubble.querySelector('#dLabel');
  if (dBar2) dBar2.style.width = '100%';
  if (dLbl2) dLbl2.textContent = files.length + '/' + files.length + ' complete';
  appendLog('Done! Vercel rebuilds in ~60s.', 'ok');
  scrollBot();
}

async function confirmDeploy(btn, actionStr) {
  btn.parentNode.innerHTML = '<em>Deploying...</em>';
  var action;
  try {
    action = JSON.parse(actionStr.replace(/&quot;/g, '"'));
  } catch(e) {
    addAI('<strong>Deploy error:</strong> Could not parse action. Try again.');
    return;
  }
  var el = addAI('<strong>Starting...</strong>');
  try { await executeDeploy(action, el); }
  catch(e) {
    var b = el.querySelector('.bubble');
    if (b) b.innerHTML = 'Deploy failed: ' + esc(e.message);
  }
}

// ── GBP action UI ──────────────────────────────────────
// Event delegation for GBP buttons (avoids quote-escaping issues)
document.addEventListener('click', function(e) {
  var btn = e.target.closest('[data-gbp-action]');
  if (!btn) return;
  var type   = btn.getAttribute('data-gbp-action');
  var raw    = btn.getAttribute('data-gbp-payload') || '{}';
  var action;
  try { action = JSON.parse(raw); } catch(err) { return; }
  if (type === 'post')    confirmGBPPost(btn, action);
  if (type === 'confirm') confirmGBPAction(btn, action);
  if (type === 'discard') btn.closest('.msg-wrap').remove();
});

function handleGBPAction(action) {
  var payload = JSON.stringify(action);

  if (action.action === 'createPost') {
    var el = addAI(
      '<div style="border-left:3px solid var(--accent);padding-left:14px;margin-bottom:12px;">'
      + '<div style="font-size:10.5px;color:var(--text3);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;">&#x1F4DD; Draft GBP post</div>'
      + '<div style="font-size:15px;line-height:1.85;color:var(--text)">' + esc(action.content) + '</div>'
      + (action.callToAction ? '<div style="margin-top:8px;font-size:12px;color:var(--text3)">CTA: ' + esc(action.callToAction) + '</div>' : '')
      + '</div>'
    );
    var btnRow = document.createElement('div');
    var pub = document.createElement('button');
    pub.className = 'action-btn green';
    pub.setAttribute('data-gbp-action', 'post');
    pub.setAttribute('data-gbp-payload', payload);
    pub.innerHTML = '&#x2713; Publish to Google';
    var dis = document.createElement('button');
    dis.className = 'action-btn red';
    dis.setAttribute('data-gbp-action', 'discard');
    dis.innerHTML = '&#x2715; Discard';
    btnRow.appendChild(pub); btnRow.appendChild(dis);
    el.querySelector('.bubble').appendChild(btnRow);
    return;
  }

  if (action.action === 'replyReview') {
    var el2 = addAI(
      '<div style="border-left:3px solid var(--amber);padding-left:14px;margin-bottom:12px;">'
      + '<div style="font-size:10.5px;color:var(--text3);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;">&#x1F4AC; Draft review reply</div>'
      + '<div style="font-size:15px;line-height:1.85;">' + esc(action.reply) + '</div>'
      + '</div>'
    );
    var br2 = document.createElement('div');
    var ok2 = document.createElement('button');
    ok2.className = 'action-btn green';
    ok2.setAttribute('data-gbp-action', 'confirm');
    ok2.setAttribute('data-gbp-payload', payload);
    ok2.innerHTML = '&#x2713; Post reply';
    var no2 = document.createElement('button');
    no2.className = 'action-btn red';
    no2.setAttribute('data-gbp-action', 'discard');
    no2.innerHTML = '&#x2715; Discard';
    br2.appendChild(ok2); br2.appendChild(no2);
    el2.querySelector('.bubble').appendChild(br2);
    return;
  }

  if (action.action === 'updateHours' || action.action === 'updateSpecialHours' || action.action === 'updateDescription') {
    var label   = action.action === 'updateHours'        ? 'Update regular hours'
                : action.action === 'updateSpecialHours' ? 'Set special/holiday hours'
                : 'Update business description';
    var preview = action.description || JSON.stringify(action.hours || action.specialHours, null, 2);
    var el3 = addAI(
      '<div style="border-left:3px solid var(--green);padding-left:14px;margin-bottom:12px;">'
      + '<div style="font-size:10.5px;color:var(--text3);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;">&#x1F4CB; ' + label + '</div>'
      + '<pre style="font-size:12px;background:var(--code-bg);padding:10px;border-radius:8px;overflow-x:auto;white-space:pre-wrap;">' + esc(preview) + '</pre>'
      + '</div>'
    );
    var br3 = document.createElement('div');
    var ok3 = document.createElement('button');
    ok3.className = 'action-btn green';
    ok3.setAttribute('data-gbp-action', 'confirm');
    ok3.setAttribute('data-gbp-payload', payload);
    ok3.innerHTML = '&#x2713; Apply to Google';
    var no3 = document.createElement('button');
    no3.className = 'action-btn red';
    no3.setAttribute('data-gbp-action', 'discard');
    no3.innerHTML = '&#x2715; Cancel';
    br3.appendChild(ok3); br3.appendChild(no3);
    el3.querySelector('.bubble').appendChild(br3);
    return;
  }

  // Read-only GBP actions — execute and summarise
  window.showWhisper('Fetching from Google Business...');
  window.gbpAPI(action).then(function(result) {
    window.hideWhisper();
    if (!result) return;
    var followUp = 'Google Business Profile data:\n' + JSON.stringify(result, null, 2) + '\n\nPresent this clearly and concisely in plain language.';
    var readEl     = addAI('');
    var readBubble = readEl.querySelector('.bubble');
    var buf = '', cur = document.createElement('span');
    cur.className = 'cursor';
    readBubble.appendChild(cur);
    window.showWhisper('Summarising...');
    window.callAI(followUp, function(chunk) {
      buf += chunk;
      window.hideWhisper();
      readBubble.innerHTML = fmt(buf);
      readBubble.appendChild(cur);
      scrollBot();
    }).then(function() {
      readBubble.innerHTML = fmt(buf);
    }).catch(function(e) {
      window.hideWhisper();
      readBubble.innerHTML = '<strong>Error summarising:</strong> ' + esc(e.message);
    });
  }).catch(function(e) {
    window.hideWhisper();
    addAI('<strong>GBP Error:</strong> ' + esc(e.message));
  });
}

async function confirmGBPPost(btn, action) {
  btn.parentNode.innerHTML = '<em style="color:var(--text3);font-size:12px;">Publishing...</em>';
  window.showWhisper('Publishing to Google Business...');
  try {
    var result = await window.gbpAPI(action);
    window.hideWhisper();
    if (!result) return;
    if (result.success) {
      addAI('&#x2705; <strong>Post published</strong> to Google Business Profile. It will appear within a few minutes.');
    } else {
      addAI('<strong>Publish issue:</strong> ' + esc(JSON.stringify(result)));
    }
  } catch(e) {
    window.hideWhisper();
    addAI('<strong>Publish failed:</strong> ' + esc(e.message));
  }
}

async function confirmGBPAction(btn, action) {
  btn.parentNode.innerHTML = '<em style="color:var(--text3);font-size:12px;">Applying...</em>';
  window.showWhisper('Updating Google Business Profile...');
  try {
    var result = await window.gbpAPI(action);
    window.hideWhisper();
    if (!result) return;
    if (result.success) {
      var msgs = {
        replyReview:        '&#x2705; <strong>Review reply posted</strong> on Google.',
        updateHours:        '&#x2705; <strong>Business hours updated</strong> on Google.',
        updateSpecialHours: '&#x2705; <strong>Special hours set</strong> on Google.',
        updateDescription:  '&#x2705; <strong>Business description updated</strong> on Google.',
      };
      addAI(msgs[action.action] || '&#x2705; Done.');
    } else {
      addAI('<strong>Issue applying change:</strong> ' + esc(JSON.stringify(result)));
    }
  } catch(e) {
    window.hideWhisper();
    addAI('<strong>Update failed:</strong> ' + esc(e.message));
  }
}


// ── UI callbacks registered by api.js ─────────────────
// These are set on window so api.js can call them without
// importing UI code directly.

function _showRepoSwitchNotice(detectedRepo) {
  var msgs = document.getElementById('messages');
  if (!msgs) return;
  var noticeEl = document.createElement('div');
  noticeEl.style.cssText = 'width:100%;max-width:760px;margin:0 auto;padding:4px 24px 4px 72px;font-size:11.5px;color:var(--text3);';
  noticeEl.innerHTML = '&#x1F4C2; Switched to <strong style="color:var(--text2)">' + esc(detectedRepo) + '</strong>';
  msgs.appendChild(noticeEl);
  scrollBot();
}

async function _renderProfileSummary(fetchFn) {
  var el     = addAI('');
  var bubble = el.querySelector('.bubble');
  showWhisper('Reflecting on our conversations...');
  try {
    var data = await fetchFn();
    hideWhisper();
    bubble.innerHTML = data.summary
      ? fmt(data.summary)
      : 'I have not gathered enough data yet. Keep chatting and I will build a picture of how you like to work.';
  } catch(e) {
    hideWhisper();
    bubble.innerHTML = 'Could not retrieve profile summary right now.';
  }
  scrollBot();
}

async function _renderDigest(fetchFn) {
  var el     = addAI('');
  var bubble = el.querySelector('.bubble');
  showWhisper('Preparing weekly digest...');
  try {
    var data      = await fetchFn();
    hideWhisper();
    var dateLabel = window.get('weeklyDigestDate', '') || new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
    bubble.innerHTML = data.digest
      ? '<div style="font-size:11px;color:var(--text3);margin-bottom:10px;text-transform:uppercase;letter-spacing:0.08em;">&#x1F4C6; Weekly digest — ' + dateLabel + '</div>' + fmt(data.digest)
      : 'Not enough interaction data yet. Come back after a few more sessions.';
  } catch(e) {
    hideWhisper();
    bubble.innerHTML = 'Could not retrieve digest right now.';
  }
  scrollBot();
}

// ── Expose to window ───────────────────────────────────
Object.assign(window, {
  esc,
  fmt,
  safeParseJSON,
  scrollBot,
  showWhisper,
  hideWhisper,
  updateStatus,
  geminiResetAt,
  countdownInterval,
  messageQueue,
  markGeminiLimited,
  isGeminiLimited,
  clearGeminiLimit,
  formatCountdown,
  startCountdown,
  queueMessage,
  flushQueue,
  addUser,
  addAI,
  _addUser,
  _addAI,
  showTyping,
  hideTyping,
  showWelcome,
  showWeeklyDigestInChat,
  currentMode,
  setMode,
  detectMode,
  toggleTheme,
  applyTheme,
  toggleSidebar,
  closeSidebar,
  openSettings,
  closeSettings,
  saveSettings,
  clearMemory,
  clearAllChats,
  toggleSection,
  clearActiveRepo,
  autoResize,
  handleKey,
  quickSend,
  executeDeploy,
  confirmDeploy,
  handleGBPAction,
  confirmGBPPost,
  confirmGBPAction,
  _showRepoSwitchNotice,
  _renderProfileSummary,
  _renderDigest,
});
