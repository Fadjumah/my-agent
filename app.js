// ═══════════════════════════════════════════════════════
// app.js — Storage layer + application initialization
// SYNAPSE Agent v2
// ═══════════════════════════════════════════════════════

var MEM_KEY = 'aiagent_v4';

function mem() { try { return JSON.parse(localStorage.getItem(MEM_KEY) || '{}'); } catch(e) { return {}; } }
function saveMem(d) { localStorage.setItem(MEM_KEY, JSON.stringify(d)); }
function get(k, def) { var v = mem()[k]; return (v !== undefined && v !== null) ? v : (def !== undefined ? def : null); }
function set(k, v)   { var m = mem(); m[k] = v; saveMem(m); if (typeof window.syncKeyToCloud === 'function') window.syncKeyToCloud(k, v); }

// Expose storage immediately — all other modules need these
Object.assign(window, { mem, saveMem, get, set });

async function initApp() {
  // 1. Theme before first paint
  window.applyTheme();

  // 2. Init extended thinking state
  window.initThinkingBtn && window.initThinkingBtn();

  // 3. Cloud sync
  await window.syncFromCloud();

  // 4. Fetch instructions.md from GitHub (1-hour cached)
  window.loadInstructions && window.loadInstructions().then(function(instr) {
    if (instr) console.log('[instructions] ready (' + instr.length + ' chars)');
  });

  // 5. Session bootstrap
  if (!window.getCurrentSessionId()) window.set('currentSession', 'chat_' + Date.now());
  window.setMode(window.get('mode', 'strategic'));
  window.updateStatus();
  window.renderChatList();

  // 6. Restore or welcome
  var id = window.getCurrentSessionId();
  var session = id ? window.loadSession(id) : null;
  if (session && session.messages && session.messages.length) {
    window.set('conversation', session.messages);
    window.renderMessages(session.messages);
  } else {
    window.showWelcome();
  }

  // 7. First run
  if (!window.get('setupDone')) setTimeout(window.openSettings, 700);

  // 8. Gemini countdown
  if (window.isGeminiLimited()) window.startCountdown();

  // 9. Adaptive learning profile
  window.fetchAdaptiveProfile().then(function(p) {
    if (p) { window._adaptiveProfile = p; console.log('[learn] profile loaded:', p.totalInteractions || 0, 'interactions'); }
  });

  // 10. Daily analysis
  window.maybeRunDailyAnalysis();

  // 11. Focus input
  var _inp = document.getElementById('userInput');
  if (_inp) _inp.focus();
}

window.initApp = initApp;

window.onload = function() {
  if (window.isLoggedIn()) { window.hideLoginScreen(); initApp(); }
  else { window.showLoginScreen(); }
};
