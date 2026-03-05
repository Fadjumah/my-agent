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

  // 3. Cloud sync — 5s timeout so a slow Supabase never hangs the whole app
  try {
    await Promise.race([
      window.syncFromCloud ? window.syncFromCloud() : Promise.resolve(),
      new Promise(function(_, rej) { setTimeout(function() { rej(new Error('sync timeout')); }, 5000); })
    ]);
  } catch(e) { console.warn('[initApp] cloud sync skipped:', e.message); }

  // 4. Fetch instructions.md from GitHub (1-hour cached)
  window.loadInstructions && window.loadInstructions().then(function(instr) {
    if (instr) console.log('[instructions] ready (' + instr.length + ' chars)');
  });

  // 5. Save existing session to cloud before opening fresh (don't lose work)
  var prevId = window.getCurrentSessionId ? window.getCurrentSessionId() : null;
  if (prevId && window.saveCurrentMessages) window.saveCurrentMessages();

  // 6. Mode + UI (safe — these are always defined before initApp can be called)
  window.setMode && window.setMode(window.get('mode', 'strategic'));
  window.updateStatus && window.updateStatus();
  window.renderChatList && window.renderChatList();

  // 7. Always open a fresh chat — previous sessions visible in sidebar
  window.newChat && window.newChat();

  // 8. First run setup
  if (!window.get('setupDone')) setTimeout(function() { window.openSettings && window.openSettings(); }, 700);

  // 9. Gemini countdown
  window.isGeminiLimited && window.isGeminiLimited() && window.startCountdown && window.startCountdown();

  // 10. Adaptive learning profile (background, non-blocking)
  window.fetchAdaptiveProfile && window.fetchAdaptiveProfile().then(function(p) {
    if (p) { window._adaptiveProfile = p; }
  }).catch(function(){});

  // 11. Daily analysis (background)
  window.maybeRunDailyAnalysis && window.maybeRunDailyAnalysis();

  // 12. Focus input
  setTimeout(function() { var i = document.getElementById('userInput'); if (i) i.focus(); }, 100);
}

window.initApp = initApp;

window.onload = function() {
  if (window.isLoggedIn()) { window.hideLoginScreen(); initApp(); }
  else { window.showLoginScreen(); }
};
