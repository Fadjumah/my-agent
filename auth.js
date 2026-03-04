// ═══════════════════════════════════════════════════════
// auth.js — Authentication & session management
// SYNAPSE Agent
// ═══════════════════════════════════════════════════════

// ── Session token (sessionStorage — cleared on tab close) ──
function getSessionToken()   { return sessionStorage.getItem('agent_tok') || ''; }
function setSessionToken(t)  { sessionStorage.setItem('agent_tok', t); }
function clearSessionToken() { sessionStorage.removeItem('agent_tok'); }
function isLoggedIn()        { return !!getSessionToken(); }

// ── Login screen DOM ───────────────────────────────────
function showLoginScreen() {
  const screen = document.getElementById('loginScreen');
  if (!screen) return;
  screen.classList.remove('hidden');

  const u = document.getElementById('loginUser');
  const p = document.getElementById('loginPass');
  const e = document.getElementById('loginError');
  const b = document.getElementById('loginBtn');

  if (u) u.value = '';
  if (p) p.value = '';
  if (e) { e.classList.remove('show'); e.textContent = ''; }
  if (b) { b.disabled = false; b.textContent = 'Sign in'; }
}

function hideLoginScreen() {
  const screen = document.getElementById('loginScreen');
  if (screen) screen.classList.add('hidden');
}

function handleSessionExpiry() {
  clearSessionToken();
  showLoginScreen();
  const e = document.getElementById('loginError');
  if (e) {
    e.textContent = 'Session expired. Please sign in again.';
    e.classList.add('show');
  }
}

// ── Login key handler ──────────────────────────────────
function loginKey(e) {
  if (e.key === 'Enter') doLogin();
}

// ── Login submit ───────────────────────────────────────
async function doLogin() {
  const user  = document.getElementById('loginUser').value.trim();
  const pass  = document.getElementById('loginPass').value;
  const errEl = document.getElementById('loginError');
  const btn   = document.getElementById('loginBtn');

  errEl.classList.remove('show');

  if (!user || !pass) {
    errEl.textContent = 'Please enter both username and password.';
    errEl.classList.add('show');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Signing in...';

  try {
    const r = await fetch('/api/auth', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username: user, password: pass }),
    });
    const text = await r.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }

    if (r.ok && data.token) {
      setSessionToken(data.token);
      hideLoginScreen();
      // initApp is defined in app.js and exposed via window
      if (typeof window.initApp === 'function') window.initApp();
    } else {
      errEl.textContent = data.error || 'Login failed. Check your credentials.';
      errEl.classList.add('show');
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  } catch (ex) {
    errEl.textContent = 'Network error. Is the server running?';
    errEl.classList.add('show');
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
}

// ── Logout ─────────────────────────────────────────────
function doLogout() {
  clearSessionToken();
  showLoginScreen();
}

// ── Expose to window (for onclick attributes + cross-module) ──
Object.assign(window, {
  getSessionToken,
  setSessionToken,
  clearSessionToken,
  isLoggedIn,
  showLoginScreen,
  hideLoginScreen,
  handleSessionExpiry,
  loginKey,
  doLogin,
  doLogout,
});
