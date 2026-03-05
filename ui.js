// ═══════════════════════════════════════════════════════
// ui.js — All DOM manipulation and UI updates
// SYNAPSE Agent v2 — file attachments, code viewer,
//   diff preview, copy buttons, rollback, token budget,
//   extended thinking toggle, precise status messages
// ═══════════════════════════════════════════════════════

// ── Utilities ──────────────────────────────────────────
function esc(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmt(text) {
  if (!text) return '';
  // Code blocks — detect filename in the fence e.g. ```js filename.js
  text = text.replace(/```(\w*)\s*([^\n]*)\n?([\s\S]*?)```/g, function(_, lang, filename, code) {
    var safeLang = lang || 'code';
    var safeName = filename.trim();
    var safeCode = code.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    var header   = '';
    if (safeName) {
      var safeFile = esc(safeName);
      var rawCode  = code; // capture for download
      header = '<div class="code-header">'
        + '<span class="code-lang">' + esc(safeLang) + '</span>'
        + '<span class="code-filename">' + safeFile + '</span>'
        + '<button class="code-btn" onclick="viewCode(' + JSON.stringify(safeName) + ', ' + JSON.stringify(rawCode) + ', ' + JSON.stringify(safeLang) + ')">&#x1F5C2; View</button>'
        + '<button class="code-btn" onclick="downloadCode(' + JSON.stringify(safeName) + ', ' + JSON.stringify(rawCode) + ')">&#x2913; Download</button>'
        + '</div>';
    }
    return header + '<pre><code class="lang-' + esc(safeLang) + '">' + safeCode + '</code></pre>';
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

function safeParseJSON(str) {
  var c = String(str).trim()
    .replace(/^```json\s*/i, '').replace(/```\s*$/, '')
    .replace(/^`+|`+$/g, '').trim();
  return JSON.parse(c);
}

// ── Scroll ─────────────────────────────────────────────
function scrollBot() {
  var m = document.getElementById('messages');
  if (m) setTimeout(function() { m.scrollTop = m.scrollHeight; }, 60);
}

// ── Precise status (exact operation) ──────────────────
function showStatusExact(msg) {
  var w = document.getElementById('whisper');
  if (w) {
    // Wave shimmer: wrap text in span with data-text for CSS ::after overlay
    w.innerHTML = '<span class="whisper-text" data-text="' + msg.replace(/"/g, '&quot;') + '">' + msg + '</span>';
    w.classList.add('show');
  }
  var st = document.getElementById('statusText');
  if (st) st.textContent = msg;
}
function showWhisper(text) { showStatusExact(text); }
function hideWhisper() {
  var w = document.getElementById('whisper');
  if (w) { w.classList.remove('show'); w.textContent = ''; }
}

// ── Status bar ─────────────────────────────────────────
function updateStatus() {
  var n          = window.get('userName', '');
  var rn         = window.get('repo1name', '') || (window.get('repo1', '').split('/')[1] || '');
  var brainLabel = { auto: 'Auto', gemini: 'Gemini', claude: 'Claude', openai: 'GPT-4o' };
  var brain      = brainLabel[window._lastBrainUsed || window.get('brain', 'auto')] || 'Auto';
  var thinking   = window.get('extendedThinking', false) ? ' ✦ Thinking' : '';

  var dot = document.getElementById('statusDot');
  var txt = document.getElementById('statusText');
  if (dot) dot.className = 'status-dot ready';
  if (txt) txt.textContent = 'Ready · ' + brain + thinking + (rn ? ' · ' + rn : '') + (n ? ' · ' + n : '');

  if (n) {
    var at = document.getElementById('agentTitle');
    var wt = document.getElementById('welcomeTitle');
    if (at) at.textContent = 'Synapse';  // brand name — not user-tagged
    if (wt) wt.textContent = 'Welcome back, ' + n + ' ✦';
  }
  if (rn) {
    var as = document.getElementById('agentSubtitle');
    if (as) as.textContent = 'SYNAPSE · ' + rn;
  }
}

// ── Token budget display ───────────────────────────────
window._updateTokenBudget = function(estimate) {
  var el = document.getElementById('tokenBudget');
  if (!el) return;
  var max     = 8000;
  var used    = estimate || 0;
  var pct     = Math.min(Math.round((used / max) * 100), 100);
  var color   = pct < 60 ? 'var(--accent)' : pct < 85 ? 'var(--amber)' : 'var(--red)';
  el.innerHTML = '<div class="token-bar"><div class="token-fill" style="width:' + pct + '%;background:' + color + '"></div></div>'
    + '<span class="token-label">~' + used + ' tokens</span>';
};

// ── Countdown / Gemini quota ───────────────────────────
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
    if (!isGeminiLimited()) { clearInterval(countdownInterval); countdownInterval = null; clearGeminiLimit(); updateStatus(); flushQueue(); return; }
    var dot = document.getElementById('statusDot'), txt = document.getElementById('statusText');
    if (dot) dot.className = 'status-dot';
    if (txt) txt.textContent = 'Quota resets in ' + formatCountdown(geminiResetAt - Date.now());
  }, 1000);
}

function queueMessage(text) {
  messageQueue.push(text);
  window.set('msg_queue', messageQueue);
  addAI('<strong>Gemini quota reached.</strong> Resets in <strong>' + formatCountdown(geminiResetAt - Date.now()) + '</strong>. Tip: switch brain to Claude in Settings.');
}

async function flushQueue() {
  var saved = window.get('msg_queue', []);
  if (saved.length && !messageQueue.length) messageQueue = saved;
  window.set('msg_queue', []);
  if (!messageQueue.length) return;
  var queued = messageQueue.splice(0);
  addAI('<strong>Quota restored!</strong> Sending ' + queued.length + ' queued message' + (queued.length > 1 ? 's' : '') + '...');
  for (var i = 0; i < queued.length; i++) {
    try { await window.sendMessageText(queued[i], []); } catch(e) {}
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

// Display user message with attachment previews
function addUserWithAttachments(text, attachments) {
  var w = document.getElementById('welcomeScreen');
  if (w) w.remove();
  var msgs = document.getElementById('messages');
  if (!msgs) return;
  var d = document.createElement('div');
  d.className = 'msg-wrap user';
  var attHTML = '';
  if (attachments && attachments.length) {
    attHTML = '<div class="att-previews">';
    attachments.forEach(function(att) {
      if (att.type === 'image') {
        attHTML += '<img src="data:' + att.mediaType + ';base64,' + att.data + '" class="att-thumb" alt="' + esc(att.name) + '"/>';
      } else {
        attHTML += '<div class="att-file-chip">📄 ' + esc(att.name) + '</div>';
      }
    });
    attHTML += '</div>';
  }
  d.innerHTML = attHTML + (text ? '<div class="bubble">' + esc(text) + '</div>' : '');
  msgs.appendChild(d);
  scrollBot();
}

function _addAI(html, animate, noCopy) {
  var msgs = document.getElementById('messages');
  if (!msgs) return document.createElement('div');
  var d = document.createElement('div');
  d.className = 'msg-wrap ai';
  if (!animate) d.style.animation = 'none';

  var copyBtn = noCopy ? '' : '<button class="copy-msg-btn" onclick="copyMsgText(this)" title="Copy message">&#x2398;</button>';
  d.innerHTML = '<div class="bubble">' + html + '</div>' + copyBtn;
  msgs.appendChild(d);
  scrollBot();
  return d;
}
function addAI(html) { return _addAI(html, true, false); }

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

// ── Copy message text ──────────────────────────────────
function copyMsgText(btn) {
  var bubble = btn.closest('.msg-wrap').querySelector('.bubble');
  if (!bubble) return;
  var text = bubble.innerText || bubble.textContent || '';
  navigator.clipboard.writeText(text.trim()).then(function() {
    btn.textContent = '✓';
    setTimeout(function() { btn.innerHTML = '&#x2398;'; }, 1500);
  }).catch(function() {
    // Fallback for older browsers
    var ta = document.createElement('textarea');
    ta.value = text.trim();
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    btn.textContent = '✓';
    setTimeout(function() { btn.innerHTML = '&#x2398;'; }, 1500);
  });
}

// ── Code viewer modal ──────────────────────────────────
function viewCode(filename, content, lang) {
  var existing = document.getElementById('codeViewerModal');
  if (existing) existing.remove();

  var modal = document.createElement('div');
  modal.id = 'codeViewerModal';
  modal.className = 'code-viewer-overlay';
  modal.innerHTML = '<div class="code-viewer-panel">'
    + '<div class="code-viewer-header">'
    + '<span class="code-viewer-title">&#x1F5C2; ' + esc(filename) + '</span>'
    + '<div style="display:flex;gap:8px;">'
    + '<button class="code-btn" onclick="downloadCode(' + JSON.stringify(filename) + ',' + JSON.stringify(content) + ')">&#x2913; Download</button>'
    + '<button class="code-btn" onclick="copyCode(' + JSON.stringify(content) + ', this)">&#x2398; Copy</button>'
    + '<button class="code-viewer-close" onclick="document.getElementById(\'codeViewerModal\').remove()">&#x2715;</button>'
    + '</div>'
    + '</div>'
    + '<div class="code-viewer-body"><pre><code class="lang-' + esc(lang || 'text') + '">' + esc(content) + '</code></pre></div>'
    + '</div>';

  modal.addEventListener('click', function(e) {
    if (e.target === modal) modal.remove();
  });

  document.body.appendChild(modal);
  // Prevent background scroll
  modal.querySelector('.code-viewer-panel').addEventListener('click', function(e) { e.stopPropagation(); });
}

function downloadCode(filename, content) {
  var blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function copyCode(content, btn) {
  navigator.clipboard.writeText(content).then(function() {
    if (btn) { var old = btn.innerHTML; btn.innerHTML = '✓ Copied'; setTimeout(function() { btn.innerHTML = old; }, 1500); }
  }).catch(function() {});
}

// ── Deploy diff preview ────────────────────────────────
function showDeployPreview(depAction) {
  var cnt  = (depAction.files && depAction.files.length) || 0;
  var el   = addAI('');
  var b    = el.querySelector('.bubble');

  var filesHTML = (depAction.files || []).map(function(f) {
    var lines  = (f.content || '').split('\n');
    var preview = lines.slice(0, 6).map(function(l) { return '<span class="diff-add">+ ' + esc(l) + '</span>'; }).join('\n');
    var more    = lines.length > 6 ? '<span style="color:var(--text3);font-size:11px">... ' + (lines.length - 6) + ' more lines</span>' : '';
    return '<div class="diff-file">'
      + '<div class="diff-filename">&#x1F4C4; ' + esc(f.path) + ' <span style="color:var(--text3);font-size:11px">(' + lines.length + ' lines)</span>'
      + '<button class="code-btn" style="margin-left:8px" onclick="viewCode(' + JSON.stringify(f.path) + ',' + JSON.stringify(f.content || '') + ',\'text\')">&#x1F5C2; View</button>'
      + '<button class="code-btn" onclick="downloadCode(' + JSON.stringify(f.path) + ',' + JSON.stringify(f.content || '') + ')">&#x2913; Download</button>'
      + '</div>'
      + '<pre class="diff-preview">' + preview + '\n' + more + '</pre>'
      + '</div>';
  }).join('');

  var safe = JSON.stringify(depAction).replace(/"/g, '&quot;');
  b.innerHTML = '<strong>Ready to deploy ' + cnt + ' file(s) to <code>' + esc(depAction.repo) + '</code></strong>'
    + ' on branch <code>' + esc(depAction.branch || 'main') + '</code>'
    + '<div class="diff-container">' + filesHTML + '</div>'
    + '<div style="margin-top:12px;display:flex;gap:8px;">'
    + '<button class="action-btn green" onclick="confirmDeploy(this,\'' + safe + '\')">&#x2713; Deploy all</button>'
    + '<button class="action-btn red" onclick="this.closest(\'.msg-wrap\').remove()">&#x2715; Cancel</button>'
    + '</div>';
}

// ── Rollback button ────────────────────────────────────
function addRollbackBtn(msgEl, repo, path, sha, branch) {
  var b = msgEl.querySelector('.bubble');
  if (!b) return;
  var rb = document.createElement('button');
  rb.className = 'action-btn rollback';
  rb.innerHTML = '&#x21A9; Rollback';
  rb.title = 'Revert ' + path + ' to commit before this push';
  rb.onclick = function() {
    rb.disabled = true; rb.textContent = 'Rolling back...';
    window.showStatusExact('Rolling back ' + path + ' to ' + sha + '...');
    window.githubAPI({ action: 'rollback', repo: repo, path: path, targetSha: sha, commitMessage: 'rollback: revert ' + path + ' to ' + sha }).then(function(r) {
      window.hideWhisper();
      window.addAI('&#x21A9; <strong>Rollback complete.</strong> ' + path + ' reverted to <code>' + sha + '</code>. New commit: <code>' + (r.sha || '?') + '</code>');
      window.logAuditEntry && window.logAuditEntry({ action: 'rollback', repo: repo, path: path, sha: r.sha, message: 'rollback to ' + sha });
    }).catch(function(e) {
      window.hideWhisper();
      rb.textContent = '&#x21A9; Rollback failed'; rb.style.color = 'var(--red)';
      window.addAI('&#x274C; Rollback failed: ' + window.esc(e.message));
    });
  };
  b.appendChild(rb);
}

// ── Deploy confirm with retry + rollback button ────────
async function confirmDeploy(btn, actionStr) {
  btn.parentNode.innerHTML = '<em>Deploying...</em>';
  var action;
  try { action = JSON.parse(actionStr.replace(/&quot;/g, '"')); }
  catch(e) { addAI('<strong>Deploy error:</strong> Could not parse action.'); return; }
  var el = addAI('<strong>Starting deploy...</strong>');
  try {
    await executeDeploy(action, el);
  } catch(e) {
    var b = el.querySelector('.bubble');
    if (b) b.innerHTML = '&#x274C; Deploy failed: ' + esc(e.message);
  }
}

async function executeDeploy(action, msgEl) {
  var repo = action.repo, branch = action.branch || 'main', files = action.files || [];
  var bubble = msgEl.querySelector('.bubble');
  var log = '';

  function appendLog(line, cls) {
    log += '<div class="' + (cls || '') + '">' + line + '</div>';
    var dl = bubble.querySelector('.deploy-log');
    if (dl) dl.innerHTML = log;
    scrollBot();
  }

  bubble.innerHTML = '<strong>Deploying ' + files.length + ' file(s) to ' + esc(repo) + '...</strong>'
    + '<div class="deploy-bar-wrap"><div class="deploy-bar" id="dBar"></div></div>'
    + '<div class="deploy-label" id="dLabel">Starting...</div>'
    + '<div class="deploy-log"></div>';

  var pushedFiles = [];

  for (var i = 0; i < files.length; i++) {
    var f   = files[i];
    var dBar = bubble.querySelector('#dBar');
    var dLbl = bubble.querySelector('#dLabel');
    if (dBar) dBar.style.width = Math.round((i / files.length) * 100) + '%';
    if (dLbl) dLbl.textContent = (i + 1) + '/' + files.length + ' — ' + f.path;

    appendLog('&#x1F4E4; ' + esc(f.path) + '...', 'info');
    window.showStatusExact('Pushing ' + f.path + ' to ' + branch + '...');

    try {
      var result = await window.pushFileWithRetry({
        repo: repo, branch: branch, path: f.path,
        content: f.content || '',
        commitMessage: action.commit_message || ('update: ' + f.path),
      });
      appendLog('&#x2705; Pushed — commit <code>' + (result.sha || '?') + '</code>', 'ok');
      pushedFiles.push({ path: f.path, sha: result.sha });
    } catch(e) {
      appendLog('&#x274C; ' + esc(e.message), 'err');
    }

    await new Promise(function(r) { setTimeout(r, 300); });
  }

  var dBar2 = bubble.querySelector('#dBar');
  var dLbl2 = bubble.querySelector('#dLabel');
  if (dBar2) dBar2.style.width = '100%';
  if (dLbl2) dLbl2.textContent = files.length + '/' + files.length + ' complete';
  appendLog('&#x2728; Done! Vercel rebuilds in ~60s.', 'ok');
  window.hideWhisper();

  // Add rollback button for each pushed file
  if (pushedFiles.length) {
    var rollDiv = document.createElement('div');
    rollDiv.style.marginTop = '10px';
    pushedFiles.forEach(function(pf) {
      var rb = document.createElement('button');
      rb.className = 'action-btn rollback';
      rb.innerHTML = '&#x21A9; Rollback ' + esc(pf.path.split('/').pop());
      rb.onclick = (function(pp, ps) {
        return function() {
          rb.disabled = true;
          window.showStatusExact('Rolling back ' + pp + '...');
          window.githubAPI({ action: 'rollback', repo: repo, path: pp, targetSha: ps, commitMessage: 'rollback: revert ' + pp }).then(function(r) {
            window.hideWhisper();
            window.addAI('&#x21A9; <strong>Rolled back</strong> ' + pp + '. New commit: <code>' + (r.sha || '?') + '</code>');
          }).catch(function(e) { window.hideWhisper(); window.addAI('&#x274C; Rollback failed: ' + window.esc(e.message)); });
        };
      })(pf.path, pf.sha);
      rollDiv.appendChild(rb);
    });
    bubble.appendChild(rollDiv);
  }

  scrollBot();
}

// ── File attachment handling ───────────────────────────
window._pendingAttachments = [];

function clearAttachments() {
  window._pendingAttachments = [];
  var preview = document.getElementById('attachPreview');
  if (preview) preview.innerHTML = '';
}

function triggerAttach() {
  var fi = document.getElementById('fileInput');
  if (fi) fi.click();
}

async function handleFileInput(input) {
  var files = Array.from(input.files || []);
  if (!files.length) return;
  var preview = document.getElementById('attachPreview');

  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var att = await readFileAsAttachment(file);
    if (!att) continue;
    window._pendingAttachments.push(att);

    if (preview) {
      var chip = document.createElement('div');
      chip.className = 'att-chip';
      var idx = window._pendingAttachments.length - 1;
      if (att.type === 'image') {
        chip.innerHTML = '<img src="data:' + att.mediaType + ';base64,' + att.data + '" class="att-chip-thumb"/>'
          + '<span>' + esc(att.name) + '</span>'
          + '<button onclick="removeAttachment(' + idx + ', this.parentNode)">&#x2715;</button>';
      } else {
        chip.innerHTML = '<span style="font-size:16px">📄</span>'
          + '<span>' + esc(att.name) + '</span>'
          + '<button onclick="removeAttachment(' + idx + ', this.parentNode)">&#x2715;</button>';
      }
      preview.appendChild(chip);
    }
  }

  // Reset file input so same file can be re-selected
  input.value = '';
}

async function readFileAsAttachment(file) {
  return new Promise(function(resolve) {
    var reader = new FileReader();
    reader.onload = function(e) {
      var result = e.target.result;
      var isImage   = file.type.startsWith('image/');
      var isPDF     = file.type === 'application/pdf';
      var isText    = file.type.startsWith('text/') || /\.(js|ts|css|html|json|md|py|sh|yaml|yml|xml)$/i.test(file.name);

      if (isImage) {
        // result is data URL — extract base64 part
        var base64 = result.split(',')[1];
        resolve({ type: 'image', name: file.name, mediaType: file.type, data: base64 });
      } else if (isPDF) {
        var base64 = result.split(',')[1];
        resolve({ type: 'document', name: file.name, mediaType: 'application/pdf', data: base64 });
      } else if (isText) {
        // Text files — send as text content
        resolve({ type: 'text', name: file.name, mediaType: file.type, data: result });
      } else {
        // Generic binary — attempt base64
        var base64 = result.split(',')[1];
        resolve({ type: 'document', name: file.name, mediaType: file.type || 'application/octet-stream', data: base64 });
      }
    };
    reader.onerror = function() { resolve(null); };
    if (file.type.startsWith('text/') || /\.(js|ts|css|html|json|md|py|sh|yaml|yml|xml)$/i.test(file.name)) {
      reader.readAsText(file);
    } else {
      reader.readAsDataURL(file);
    }
  });
}

function removeAttachment(idx, chipEl) {
  window._pendingAttachments.splice(idx, 1);
  if (chipEl) chipEl.remove();
}

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
    + '<circle cx="12" cy="15" r="2.5" fill="url(#wlg)" opacity="0.75"/><circle cx="28" cy="15" r="2.5" fill="url(#wlg)" opacity="0.75"/>'
    + '<circle cx="12" cy="25" r="2.5" fill="url(#wlg)" opacity="0.55"/><circle cx="28" cy="25" r="2.5" fill="url(#wlg)" opacity="0.55"/>'
    + '<line x1="20" y1="20" x2="12" y2="15" stroke="url(#wlg)" stroke-width="1.5" opacity="0.5"/>'
    + '<line x1="20" y1="20" x2="28" y2="15" stroke="url(#wlg)" stroke-width="1.5" opacity="0.5"/>'
    + '<line x1="20" y1="20" x2="12" y2="25" stroke="url(#wlg)" stroke-width="1.5" opacity="0.4"/>'
    + '<line x1="20" y1="20" x2="28" y2="25" stroke="url(#wlg)" stroke-width="1.5" opacity="0.4"/>'
    + '</svg></div>'
    + '<h1 id="welcomeTitle">Welcome back, ' + esc(n) + ' ✦</h1>'
    + '<p>Your personal cognitive extension. I think, plan, build, and deploy.</p>'
    + '<div class="suggestions">'
    + '<div class="suggestion" onclick="quickSend(\'List all my GitHub repositories\')">&#x1F4C1; List my repos</div>'
    + '<div class="suggestion" onclick="quickSend(\'What strategies can grow my clinic patient base?\')">&#x1F3E5; Grow my clinic</div>'
    + '<div class="suggestion" onclick="quickSend(\'Give me an SEO audit plan for eritageentcare.com\')">&#x1F50D; SEO audit plan</div>'
    + '<div class="suggestion" onclick="quickSend(\'What have you learned about how I like to work?\')">&#x1F9E0; What you\'ve learned</div>'
    + '</div>';
  msgs.appendChild(w);
}

function showWeeklyDigestInChat(digest) {
  var msgs = document.getElementById('messages');
  if (!msgs || msgs.querySelectorAll('.msg-wrap').length > 0) return;
  var w = document.getElementById('welcomeScreen');
  if (w) w.remove();
  var d = document.createElement('div');
  d.className = 'msg-wrap ai'; d.style.animation = 'none';
  d.innerHTML = '<div class="bubble"><div style="font-size:11px;color:var(--text3);margin-bottom:10px;text-transform:uppercase;letter-spacing:0.08em;">&#x1F4C6; Weekly digest</div>' + fmt(digest) + '</div>';
  msgs.appendChild(d);
  scrollBot();
}

// ── Mode ───────────────────────────────────────────────
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
  if (badge) badge.className = 'mode-badge ' + mode;
  if (label) label.textContent = mode === 'code' ? 'Code Mode' : 'Strategic Mode';
}

function detectMode(text) {
  var codeSignals = /\b(code|github|repo|deploy|push|commit|file|function|bug|refactor|html|css|js|javascript|api|edit|update|fix|build|implement|create.*file|write.*code)\b/i;
  if (codeSignals.test(text) && currentMode !== 'code')       { setMode('code'); return true; }
  if (!codeSignals.test(text) && currentMode !== 'strategic') { setMode('strategic'); }
  return false;
}

// ── Extended thinking toggle ───────────────────────────
function toggleExtendedThinking() {
  var current = window.get('extendedThinking', false);
  var next    = !current;
  window.set('extendedThinking', next);
  var btn = document.getElementById('thinkingBtn');
  if (btn) {
    btn.classList.toggle('active', next);
    btn.title = next ? 'Extended thinking ON — deeper reasoning' : 'Extended thinking OFF';
  }
  updateStatus();
  addAI(next
    ? '&#x2728; <strong>Extended thinking ON.</strong> Claude will reason deeply before responding. Best for complex problems. Responses will be slower and use more tokens.'
    : '&#x26A1; <strong>Extended thinking OFF.</strong> Back to fast mode.'
  );
}

function initThinkingBtn() {
  var btn = document.getElementById('thinkingBtn');
  if (!btn) return;
  var current = window.get('extendedThinking', false);
  btn.classList.toggle('active', current);
  btn.title = current ? 'Extended thinking ON' : 'Extended thinking OFF';
}

// ── Theme ──────────────────────────────────────────────
function toggleTheme() {
  var isLight = document.documentElement.classList.toggle('light');
  var btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = isLight ? '🌑' : '🌙';
  window.set('theme', isLight ? 'light' : 'dark');
}

function applyTheme() {
  if (window.get('theme', 'dark') === 'light') {
    document.documentElement.classList.add('light');
    var btn = document.getElementById('themeToggle');
    if (btn) btn.textContent = '🌑';
  }
}

// ── Sidebar ────────────────────────────────────────────
function toggleSidebar() {
  var sb = document.getElementById('sidebar'), bd = document.getElementById('sidebarBackdrop');
  if (sb) sb.classList.toggle('open');
  if (bd) bd.classList.toggle('show');
}
function closeSidebar() {
  var sb = document.getElementById('sidebar'), bd = document.getElementById('sidebarBackdrop');
  if (sb) sb.classList.remove('open');
  if (bd) bd.classList.remove('show');
}

// ── Settings ───────────────────────────────────────────
function openSettings() {
  var sn = document.getElementById('s_name'),    sb = document.getElementById('s_brain');
  var sa = document.getElementById('s_about'),   sp = document.getElementById('s_prefs');
  var mb = document.getElementById('memoryBox'), ov = document.getElementById('settingsOverlay');
  var arn = document.getElementById('activeRepoName'), pb = document.getElementById('profileBox');
  var al  = document.getElementById('auditLogBox');

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
      if (ap.totalInteractions) lines.push('Conversations tracked: ' + ap.totalInteractions);
      if (ap.style && ap.style.avgReplyWordCount) lines.push('Preferred reply length: ~' + ap.style.avgReplyWordCount + ' words');
      if (ap.recurringTopics && ap.recurringTopics.length) lines.push('Top topics: ' + ap.recurringTopics.slice(0, 4).map(function(t) { return t.topic.replace(/_/g, ' '); }).join(', '));
      (ap.observations || []).forEach(function(o) { lines.push(o); });
      pb.textContent = lines.length ? lines.join('\n') : 'Not enough interactions yet.';
    } else {
      pb.textContent = 'Not enough interactions yet. Builds over time.';
    }
  }

  if (al) {
    var log = window.getAuditLog ? window.getAuditLog() : [];
    if (!log.length) {
      al.textContent = 'No operations logged yet.';
    } else {
      al.innerHTML = log.slice(0, 20).map(function(e) {
        return '<div class="audit-entry">'
          + '<span class="audit-date">' + esc(e.date) + '</span> '
          + '<span class="audit-action">' + esc(e.action || '') + '</span> '
          + '<span class="audit-path">' + esc(e.path || '') + '</span>'
          + (e.sha ? ' <code class="audit-sha">' + esc(e.sha) + '</code>' : '')
          + '</div>';
      }).join('');
    }
  }

  if (ov) ov.classList.add('open');
}

function closeSettings() {
  var ov = document.getElementById('settingsOverlay');
  if (ov) ov.classList.remove('open');
}

function saveSettings() {
  var sn = document.getElementById('s_name'), sb = document.getElementById('s_brain');
  var sa = document.getElementById('s_about'), sp = document.getElementById('s_prefs');
  var newName  = sn ? sn.value.trim() : '';
  var newBrain = sb ? sb.value        : 'auto';
  var newAbout = sa ? sa.value.trim() : '';
  var newPrefs = sp ? sp.value.trim() : '';

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
  addAI('Settings saved' + (newName ? ', ' + newName : '') + '. What would you like to work on?');
}

function clearMemory() {
  if (!confirm('Clear all agent memory?')) return;
  window.set('learnedFacts', []);
  addAI('Memory cleared.');
  openSettings();
}

function clearAllChats() {
  if (!confirm('Delete all chat history? This cannot be undone.')) return;
  // Wipe local + cloud
  if (typeof window.deleteAllChats === 'function') {
    window.deleteAllChats(); // handles local + cloud wipe
  } else {
    window.set('sessions', []); window.set('conversation', []); window.set('currentSession', null);
  }
  window.renderChatList && window.renderChatList();
  window.renderMessages && window.renderMessages([]);
  showWelcome();
  closeSettings();
  // Start fresh session
  setTimeout(function() { window.newChat && window.newChat(); }, 100);
}

function toggleSection(id, rowEl) {
  var col = document.getElementById(id);
  var row = rowEl && rowEl.closest ? rowEl.closest('.settings-row') : rowEl;
  if (!col) return;
  var isOpen = col.classList.contains('open');
  document.querySelectorAll('.settings-collapsible').forEach(function(el) { el.classList.remove('open'); });
  document.querySelectorAll('.settings-row').forEach(function(el) { el.classList.remove('open'); });
  if (!isOpen) { col.classList.add('open'); if (row) row.classList.add('open'); }
}

function clearActiveRepo() {
  window.set('repo1', ''); window.set('repo1name', '');
  window._repoList = null;
  if (window._ghCache) Object.keys(window._ghCache).forEach(function(k) { delete window._ghCache[k]; });
  var el = document.getElementById('activeRepoName');
  if (el) { el.textContent = 'None detected yet'; el.style.color = 'var(--text3)'; }
  updateStatus();
  addAI('Active repo cleared. Mention a repo name and I\'ll switch automatically.');
  closeSettings();
}

// ── Input helpers ──────────────────────────────────────
function autoResize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 140) + 'px'; }
function handleKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); window.sendMessage(); } }
function quickSend(t) { var inp = document.getElementById('userInput'); if (inp) inp.value = t; window.sendMessage(); }

// ── GBP Actions ────────────────────────────────────────
document.addEventListener('click', function(e) {
  var btn = e.target.closest('[data-gbp-action]');
  if (!btn) return;
  var type = btn.getAttribute('data-gbp-action');
  var raw  = btn.getAttribute('data-gbp-payload') || '{}';
  var action;
  try { action = JSON.parse(raw); } catch(err) { return; }
  if (type === 'post')    confirmGBPPost(btn, action);
  if (type === 'confirm') confirmGBPAction(btn, action);
  if (type === 'discard') btn.closest('.msg-wrap').remove();
});

// handleGBPAction — executes GBP action and injects result back into conversation
// agentRaw: the agent's full message that contained the action tag (used for history)
function handleGBPAction(action, agentRaw) {
  var payload = JSON.stringify(action);

  // ── Write actions: show draft for approval first, don't execute yet ────────
  if (action.action === 'createPost') {
    var el = addAI('<div style="border-left:3px solid var(--accent);padding-left:14px;margin-bottom:12px;"><div style="font-size:10.5px;color:var(--text3);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;">&#x1F4DD; Draft GBP post</div><div style="font-size:15px;line-height:1.85">' + esc(action.content) + '</div>' + (action.callToAction ? '<div style="margin-top:8px;font-size:12px;color:var(--text3)">CTA: ' + esc(action.callToAction) + '</div>' : '') + '</div>');
    var br = document.createElement('div');
    var pb = document.createElement('button'); pb.className = 'action-btn green'; pb.setAttribute('data-gbp-action','post'); pb.setAttribute('data-gbp-payload', payload); pb.innerHTML = '&#x2713; Publish';
    var db = document.createElement('button'); db.className = 'action-btn red';   db.setAttribute('data-gbp-action','discard'); db.innerHTML = '&#x2715; Discard';
    br.appendChild(pb); br.appendChild(db); el.querySelector('.bubble').appendChild(br);
    // Inject draft into context so agent knows what it proposed
    if (typeof window.pushConvo === 'function') {
      window.pushConvo('assistant', 'Drafted GBP post for approval: "' + action.content + '"');
    }
    return;
  }

  if (action.action === 'replyReview' || action.action === 'updateHours' || action.action === 'updateSpecialHours' || action.action === 'updateDescription') {
    var label   = { replyReview: 'Review reply', updateHours: 'Update hours', updateSpecialHours: 'Special hours', updateDescription: 'Update description' }[action.action] || action.action;
    var preview = action.reply || action.description || JSON.stringify(action.hours || action.specialHours, null, 2) || '';
    var el2 = addAI('<div style="border-left:3px solid var(--amber);padding-left:14px;margin-bottom:12px;"><div style="font-size:10.5px;color:var(--text3);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;">&#x1F4CB; ' + esc(label) + '</div><pre style="font-size:12px;background:var(--code-bg);padding:10px;border-radius:8px;white-space:pre-wrap;">' + esc(preview) + '</pre></div>');
    var br2 = document.createElement('div');
    var ok2 = document.createElement('button'); ok2.className = 'action-btn green'; ok2.setAttribute('data-gbp-action','confirm'); ok2.setAttribute('data-gbp-payload', payload); ok2.innerHTML = '&#x2713; Apply';
    var no2 = document.createElement('button'); no2.className = 'action-btn red'; no2.setAttribute('data-gbp-action','discard'); no2.innerHTML = '&#x2715; Cancel';
    br2.appendChild(ok2); br2.appendChild(no2); el2.querySelector('.bubble').appendChild(br2);
    if (typeof window.pushConvo === 'function') {
      window.pushConvo('assistant', label + ' drafted for approval: ' + preview.slice(0, 200));
    }
    return;
  }

  // ── Read actions: fetch, inject result into conversation, continue ─────────
  var statusMsg = action.action === 'getAccounts'   ? 'Fetching your Google Business accounts...'
                : action.action === 'getLocations'  ? 'Fetching your GBP locations...'
                : action.action === 'getReviews'    ? 'Fetching your GBP reviews...'
                : action.action === 'getProfile'    ? 'Fetching your GBP profile...'
                : 'Fetching Google Business data...';

  window.showWhisper(statusMsg);
  var readEl     = addAI('<em style="color:var(--text3);font-size:13px">&#x1F504; ' + esc(statusMsg) + '</em>');
  var readBubble = readEl.querySelector('.bubble');

  window.gbpAPI(action).then(async function(result) {
    window.hideWhisper();
    if (!result) {
      readBubble.innerHTML = 'No data returned from Google Business Profile.';
      return;
    }

    // Build tool result message
    var toolResultText = '[TOOL_RESULT gbp:' + action.action + ']\n'
      + JSON.stringify(result, null, 2)
      + '\n[/TOOL_RESULT]\n\nPresent this Google Business Profile data clearly and helpfully to the user. Be specific.';

    // Commit the tool result to conversation BEFORE calling AI
    // (agentRaw already committed by chat.js handleResponse before calling us)
    // If called standalone (from reasoningGate), push a synthetic agent turn
    if (!agentRaw && typeof window.pushConvo === 'function') {
      window.pushConvo('assistant', '[ACTION:GBP]' + JSON.stringify(action) + '[/ACTION:GBP]');
    }

    window.showWhisper('Reading GBP data...');
    var buf = '';
    var cur = document.createElement('span'); cur.className = 'cursor';
    readBubble.innerHTML = ''; readBubble.appendChild(cur);

    try {
      var gbpResponse = await window.callAI(toolResultText, function(chunk) {
        buf += chunk;
        window.hideWhisper();
        // Strip action tags during streaming so they never render raw
        readBubble.innerHTML = fmt(window.stripActionTags ? window.stripActionTags(buf) : buf);
        readBubble.appendChild(cur);
        scrollBot();
      }, [], false);

      // Commit both sides to conversation history
      if (typeof window.pushConvo === 'function') {
        window.pushConvo('user', toolResultText);
        window.pushConvo('assistant', gbpResponse);
      }

      window.hideWhisper();

      // Strip tags from final display
      var cleanGbpResponse = window.stripActionTags ? window.stripActionTags(gbpResponse) : gbpResponse;
      readBubble.innerHTML = fmt(cleanGbpResponse);
      scrollBot();

      // If the continuation itself contains action tags (e.g. chained getLocations after getAccounts)
      // pipe it through handleResponse so the next action actually fires
      if (/\[ACTION:/.test(gbpResponse) && typeof window.handleResponse === 'function') {
        await window.handleResponse(gbpResponse, readEl);
      }

    } catch(e) {
      window.hideWhisper();
      readBubble.innerHTML = '<strong>GBP summarise error:</strong> ' + esc(e.message);
    }

  }).catch(function(e) {
    window.hideWhisper();
    readBubble.innerHTML = '&#x274C; <strong>GBP Error:</strong> ' + esc(e.message);
    if (typeof window.pushConvo === 'function') {
      window.pushConvo('user', '[TOOL_RESULT gbp:' + action.action + '] ERROR: ' + e.message);
    }
  });
}

async function confirmGBPPost(btn, action) {
  btn.parentNode.innerHTML = '<em>Publishing...</em>';
  window.showStatusExact('Publishing to Google Business Profile...');
  try {
    var r = await window.gbpAPI(action); window.hideWhisper();
    if (r && r.success) {
      addAI('&#x2705; <strong>Post published</strong> to Google Business Profile.' + (r.postUrl ? ' <a href="' + r.postUrl + '" target="_blank" style="color:var(--accent)">View post</a>' : ''));
      if (typeof window.pushConvo === 'function') {
        window.pushConvo('user',      '[TOOL_RESULT gbp:createPost]\n{"success":true,"postName":"' + (r.postName||'') + '"}');
        window.pushConvo('assistant', 'Post published successfully to Google Business Profile.');
      }
      window.saveCurrentMessages && window.saveCurrentMessages();
    } else {
      addAI('<strong>Publish issue:</strong> ' + esc(JSON.stringify(r)));
      if (typeof window.pushConvo === 'function') {
        window.pushConvo('user', '[TOOL_RESULT gbp:createPost]\n{"success":false}');
        window.pushConvo('assistant', 'Post publish failed: ' + JSON.stringify(r));
      }
    }
  } catch(e) {
    window.hideWhisper();
    addAI('<strong>Publish failed:</strong> ' + esc(e.message));
    if (typeof window.pushConvo === 'function') {
      window.pushConvo('user', '[TOOL_RESULT gbp:createPost]\nERROR: ' + e.message);
      window.pushConvo('assistant', 'Post publish failed: ' + e.message);
    }
  }
}

async function confirmGBPAction(btn, action) {
  var applyingEl = btn.parentNode;
  applyingEl.innerHTML = '<em style="color:var(--text3);font-size:13px">&#x1F504; Applying...</em>';
  window.showStatusExact && window.showStatusExact('Updating Google Business Profile...');

  var toolResult;
  try {
    var r = await window.gbpAPI(action);
    window.hideWhisper && window.hideWhisper();

    if (r === null) {
      applyingEl.innerHTML = '<em style="color:var(--text3);font-size:12px">GBP auth required — see message above.</em>';
      return;
    }

    if (r && r.success) {
      toolResult = '[TOOL_RESULT gbp:' + action.action + ']\n{"success":true,"action":"' + action.action + '"}\n[/TOOL_RESULT]';
    } else {
      toolResult = '[TOOL_RESULT gbp:' + action.action + ']\n{"success":false,"response":' + JSON.stringify(r) + '}\n[/TOOL_RESULT]';
    }
  } catch(e) {
    window.hideWhisper && window.hideWhisper();
    toolResult = '[TOOL_RESULT gbp:' + action.action + ']\nERROR: ' + e.message + '\n[/TOOL_RESULT]';
  }

  if (typeof window.pushConvo === 'function') window.pushConvo('user', toolResult);

  var confirmPrompt = toolResult + '\n\nConfirm the result of this GBP action to Fahad clearly and directly. '
    + 'If success:true, tell him exactly what was updated and that it is live on Google. '
    + 'If error, explain what went wrong and what to do next. Be specific, no hedging.';

  var replyEl     = addAI('');
  var replyBubble = replyEl.querySelector('.bubble');
  var buf = '';
  var cur = document.createElement('span'); cur.className = 'cursor';
  replyBubble.innerHTML = ''; replyBubble.appendChild(cur);

  try {
    var aiReply = await window.callAI(confirmPrompt, function(chunk) {
      buf += chunk;
      replyBubble.innerHTML = window.fmt(buf);
      replyBubble.appendChild(cur);
      window.scrollBot && window.scrollBot();
    }, [], false);

    window.hideWhisper && window.hideWhisper();
    replyBubble.innerHTML = window.fmt(aiReply);
    window.scrollBot && window.scrollBot();

    if (typeof window.pushConvo === 'function') window.pushConvo('assistant', aiReply);
    window.saveCurrentMessages && window.saveCurrentMessages();
  } catch(e) {
    window.hideWhisper && window.hideWhisper();
    replyBubble.innerHTML = '<strong>Could not get confirmation:</strong> ' + esc(e.message);
  }
}

// ── UI Callbacks for api.js ────────────────────────────
function _showRepoSwitchNotice(detectedRepo) {
  var msgs = document.getElementById('messages');
  if (!msgs) return;
  var n = document.createElement('div');
  n.style.cssText = 'width:100%;max-width:760px;margin:0 auto;padding:4px 24px 4px 72px;font-size:11.5px;color:var(--text3);';
  n.innerHTML = '&#x1F4C2; Switched to <strong style="color:var(--text2)">' + esc(detectedRepo) + '</strong>';
  msgs.appendChild(n);
  scrollBot();
}

async function _renderProfileSummary(fetchFn) {
  var el = addAI(''); var bubble = el.querySelector('.bubble');
  showWhisper('Reflecting on our conversations...');
  try { var d = await fetchFn(); hideWhisper(); bubble.innerHTML = d.summary ? fmt(d.summary) : 'Not enough data yet. Keep chatting.'; }
  catch(e) { hideWhisper(); bubble.innerHTML = 'Could not retrieve profile summary.'; }
  scrollBot();
}

async function _renderDigest(fetchFn) {
  var el = addAI(''); var bubble = el.querySelector('.bubble');
  showWhisper('Preparing weekly digest...');
  try {
    var d = await fetchFn(); hideWhisper();
    var dateLabel = window.get('weeklyDigestDate', '') || new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
    bubble.innerHTML = d.digest ? '<div style="font-size:11px;color:var(--text3);margin-bottom:10px;text-transform:uppercase;letter-spacing:0.08em;">&#x1F4C6; Weekly digest — ' + dateLabel + '</div>' + fmt(d.digest) : 'Not enough data yet.';
  } catch(e) { hideWhisper(); bubble.innerHTML = 'Could not retrieve digest.'; }
  scrollBot();
}


// ── Planning panel — Michael Scofield execution tracker ────────────────────
// Creates a live inline step-by-step plan that updates as each step runs.
// Returns a controller object: { setActive, setDone, setError, setDetail, finish }
window.showPlanningPanel = function(goal, steps) {
  var el = window.addAI('');
  var bubble = el.querySelector('.bubble');

  var stepEls = [];
  var html = '<div class="plan-panel">'
    + '<div class="plan-header"><span class="plan-header-dot"></span>'
    + window.esc(goal) + '</div>';

  steps.forEach(function(s, i) {
    html += '<div class="plan-step" id="ps-' + i + '">'
      + '<span class="plan-step-icon">&#x25CB;</span>'
      + '<div><div class="plan-step-text">' + window.esc(s) + '</div>'
      + '<div class="plan-step-detail" id="psd-' + i + '"></div></div>'
      + '</div>';
  });

  html += '<div class="plan-divider"></div>'
    + '<div class="plan-summary" id="plan-summary">&#x23F3; Running...</div>'
    + '</div>';

  bubble.innerHTML = html;
  window.scrollBot();

  return {
    setActive: function(i, statusText) {
      for (var j = 0; j < steps.length; j++) {
        var s = bubble.querySelector('#ps-' + j);
        if (!s) continue;
        var icon = s.querySelector('.plan-step-icon');
        if (j < i) { /* already done, keep */ }
        else if (j === i) {
          s.className = 'plan-step active';
          if (icon) icon.innerHTML = '&#x25D4;';
          if (statusText) window.showStatusExact(statusText);
        } else {
          if (s.className === 'plan-step') return; // pending, don't change
        }
      }
      window.scrollBot();
    },
    setDone: function(i, detail) {
      var s = bubble.querySelector('#ps-' + i);
      if (!s) return;
      s.className = 'plan-step done';
      var icon = s.querySelector('.plan-step-icon');
      if (icon) icon.innerHTML = '&#x2714;';
      if (detail) {
        var d = bubble.querySelector('#psd-' + i);
        if (d) d.textContent = detail;
      }
      window.scrollBot();
    },
    setError: function(i, detail) {
      var s = bubble.querySelector('#ps-' + i);
      if (!s) return;
      s.className = 'plan-step error';
      var icon = s.querySelector('.plan-step-icon');
      if (icon) icon.innerHTML = '&#x2715;';
      if (detail) {
        var d = bubble.querySelector('#psd-' + i);
        if (d) d.textContent = detail;
      }
      window.scrollBot();
    },
    finish: function(summary, success) {
      var sm = bubble.querySelector('#plan-summary');
      if (sm) {
        sm.innerHTML = (success !== false ? '&#x2705; ' : '&#x26A0; ') + window.esc(summary || 'Complete.');
      }
      window.hideWhisper();
      window.scrollBot();
    },
    bubble: bubble,
    el: el,
  };
};

Object.assign(window, {
  esc, fmt, safeParseJSON, scrollBot,
  showStatusExact, showWhisper, hideWhisper, updateStatus,
  geminiResetAt, countdownInterval, messageQueue,
  markGeminiLimited, isGeminiLimited, clearGeminiLimit,
  formatCountdown, startCountdown, queueMessage, flushQueue,
  addUser, addAI, _addUser, _addAI, addUserWithAttachments,
  showTyping, hideTyping, copyMsgText,
  showWelcome, showWeeklyDigestInChat,
  viewCode, downloadCode, copyCode,
  showDeployPreview, confirmDeploy, executeDeploy, addRollbackBtn,
  clearAttachments, triggerAttach, handleFileInput, removeAttachment,
  currentMode, setMode, detectMode,
  toggleTheme, applyTheme,
  toggleSidebar, closeSidebar,
  openSettings, closeSettings, saveSettings, clearMemory, clearAllChats,
  toggleSection, clearActiveRepo,
  autoResize, handleKey, quickSend,
  handleGBPAction, confirmGBPPost, confirmGBPAction,
  toggleExtendedThinking, initThinkingBtn,
  _showRepoSwitchNotice, _renderProfileSummary, _renderDigest,
});
