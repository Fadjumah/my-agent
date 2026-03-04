// ═══════════════════════════════════════════════════════
// app.js — Storage layer + application initialization
// SYNAPSE Agent
// Loaded last. Wires everything together.
// ═══════════════════════════════════════════════════════

// ── Hybrid storage: localStorage + Supabase ────────────
var MEM_KEY = 'aiagent_v4';

function mem() {
  try { return JSON.parse(localStorage.getItem(MEM_KEY) || '{}'); } catch(e) { return {}; }
}
function saveMem(d) {
  localStorage.setItem(MEM_KEY, JSON.stringify(d));
}
function get(k, def) {
  var v = mem()[k];
  return (v !== undefined && v !== null) ? v : (def !== undefined ? def : null);
}
function set(k, v) {
  var m = mem(); m[k] = v; saveMem(m);
  // Fire-and-forget cloud sync for important keys
  if (typeof window.syncKeyToCloud === 'function') window.syncKeyToCloud(k, v);
}

// Expose storage to window immediately — other modules depend on these
Object.assign(window, { mem, saveMem, get, set });

// ── Application init ───────────────────────────────────
async function initApp() {
  // 0. Apply saved theme before anything renders
  window.applyTheme();

  // 1. Pull cloud state — merges into localStorage (cross-device sync)
  await window.syncFromCloud();

  // 2. Session bootstrap
  if (!window.getCurrentSessionId()) window.set('currentSession', 'chat_' + Date.now());
  window.setMode(window.get('mode', 'strategic'));
  window.updateStatus();
  window.renderChatList();

  // 3. Restore conversation or show welcome
  var id = window.getCurrentSessionId();
  if (id) {
    var session = window.loadSession(id);
    if (session && session.messages && session.messages.length) {
      window.set('conversation', session.messages);
      window.renderMessages(session.messages);
    } else {
      window.showWelcome();
    }
  } else {
    window.showWelcome();
  }

  // 4. First-run: open settings
  if (!window.get('setupDone')) setTimeout(window.openSettings, 700);

  // 5. Gemini quota countdown (if active)
  if (window.isGeminiLimited()) window.startCountdown();

  // 6. Load adaptive learning profile
  window.fetchAdaptiveProfile().then(function(profile) {
    if (profile) console.log('[learn] profile loaded. Interactions:', profile.totalInteractions || 0);
    // Mirror into window so sysPrompt() and openSettings() can read it
    window._adaptiveProfile = profile;
  });

  // 7. Daily analysis / weekly digest (fire-and-forget)
  window.maybeRunDailyAnalysis();

  // 8. Focus input (app.js is the coordinator — safe to touch DOM here)
  var _inp = document.getElementById('userInput');
  if (_inp) _inp.focus();
}

// Expose initApp so auth.js can call it after login
window.initApp = initApp;

// ── Boot ───────────────────────────────────────────────
window.onload = function() {
  if (window.isLoggedIn()) {
    window.hideLoginScreen();
    initApp();
  } else {
    window.showLoginScreen();
  }
};
