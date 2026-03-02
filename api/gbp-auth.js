/**
 * /api/gbp-auth  —  Google Business Profile OAuth 2.0 flow
 *
 * Step 1 — GET /api/gbp-auth
 *   Redirects user to Google consent screen
 *
 * Step 2 — GET /api/gbp-auth?code=...
 *   Google redirects back here with auth code
 *   Exchanges code for access + refresh tokens
 *   Stores refresh token in Supabase profiles table
 *   Shows success page
 *
 * Required env vars:
 *   GBP_CLIENT_ID, GBP_CLIENT_SECRET, GBP_REDIRECT_URI,
 *   SUPABASE_URL, SUPABASE_ANON_KEY, AGENT_API_KEY
 */

const SCOPES = [
  'https://www.googleapis.com/auth/business.manage',
].join(' ');

function sbHeaders() {
  return {
    'Content-Type':  'application/json',
    'apikey':        process.env.SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + process.env.SUPABASE_ANON_KEY,
    'Prefer':        'resolution=merge-duplicates,return=representation',
  };
}

function sbUrl(path) {
  return process.env.SUPABASE_URL + '/rest/v1/' + path;
}

async function storeTokens(userId, tokens) {
  // Store in profiles table under gbp_tokens key
  const existing = await fetch(
    sbUrl('profiles?user_id=eq.' + encodeURIComponent(userId) + '&limit=1'),
    { headers: sbHeaders() }
  ).then(r => r.json()).catch(() => []);

  const profile = (existing[0]?.profile_json) || {};
  profile.gbp_tokens = {
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at:    Date.now() + (tokens.expires_in || 3600) * 1000,
  };

  await fetch(sbUrl('profiles?on_conflict=user_id'), {
    method:  'POST',
    headers: sbHeaders(),
    body:    JSON.stringify({
      user_id:          userId,
      profile_json:     profile,
      last_analysed_at: new Date().toISOString(),
    }),
  });
}

export default async function handler(req, res) {
  const clientId     = process.env.GBP_CLIENT_ID;
  const clientSecret = process.env.GBP_CLIENT_SECRET;
  const redirectUri  = process.env.GBP_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return res.status(500).send('GBP_CLIENT_ID, GBP_CLIENT_SECRET, or GBP_REDIRECT_URI not set in Vercel env vars.');
  }

  const { code, state, error } = req.query || {};

  // ── Error from Google ──────────────────────────────────────────────────────
  if (error) {
    return res.status(400).send(
      '<h2>Google auth error: ' + error + '</h2><p>Close this tab and try again from your agent.</p>'
    );
  }

  // ── Step 2: Google redirected back with code ───────────────────────────────
  if (code) {
    try {
      // Exchange code for tokens
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({
          code,
          client_id:     clientId,
          client_secret: clientSecret,
          redirect_uri:  redirectUri,
          grant_type:    'authorization_code',
        }).toString(),
      });

      const tokens = await tokenRes.json();
      if (!tokenRes.ok || !tokens.refresh_token) {
        return res.status(400).send(
          '<h2>Token exchange failed</h2><pre>' + JSON.stringify(tokens, null, 2) + '</pre>'
        );
      }

      // userId passed through state param
      const userId = state || 'admin';
      await storeTokens(userId, tokens);

      return res.status(200).send(`
        <!DOCTYPE html><html><head>
        <meta charset="UTF-8"/>
        <style>
          body{font-family:system-ui,sans-serif;background:#0a0a0b;color:#e8e8f0;
               display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
          .card{background:#111113;border:1px solid #2a2a32;border-radius:20px;
                padding:40px;text-align:center;max-width:420px;}
          .icon{font-size:48px;margin-bottom:16px;}
          h2{margin:0 0 10px;font-size:22px;}
          p{color:#9090a8;font-size:14px;line-height:1.7;margin:0;}
        </style></head><body>
        <div class="card">
          <div class="icon">✅</div>
          <h2>Google Business Profile connected!</h2>
          <p>Your agent now has access to <strong>Eritage ENT Care</strong>.<br/>
          Close this tab and return to your agent.</p>
        </div>
        </body></html>
      `);
    } catch(e) {
      return res.status(500).send('<h2>Error: ' + e.message + '</h2>');
    }
  }

  // ── Step 1: Redirect to Google consent screen ──────────────────────────────
  // userId passed as query param e.g. /api/gbp-auth?user=fahad
  const userId = req.query?.user || 'admin';
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         SCOPES,
    access_type:   'offline',
    prompt:        'consent',   // force refresh_token to always be returned
    state:         userId,
  }).toString();

  return res.redirect(302, authUrl);
}
