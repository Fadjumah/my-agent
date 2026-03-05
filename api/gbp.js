/**
 * /api/gbp  —  Google Business Profile management
 *
 * POST { action: 'getProfile'   }                          -> get listing info
 * POST { action: 'createPost', topic, content, callToAction? } -> create a post
 * POST { action: 'publishPost', postData }                 -> publish a drafted post
 * POST { action: 'getReviews'  }                          -> list recent reviews
 * POST { action: 'replyReview', reviewId, reply }          -> reply to a review
 * POST { action: 'updateHours', hours }                    -> update regular hours
 * POST { action: 'updateSpecialHours', specialHours }      -> set holiday hours
 * POST { action: 'updateDescription', description }        -> update business description
 * POST { action: 'getAccounts' }                           -> list GBP accounts (setup helper)
 * POST { action: 'getLocations', accountId }               -> list locations (setup helper)
 *
 * Required env vars:
 *   AGENT_API_KEY, GBP_CLIENT_ID, GBP_CLIENT_SECRET,
 *   SUPABASE_URL, SUPABASE_ANON_KEY
 *   After first OAuth: GBP_ACCOUNT_ID, GBP_LOCATION_ID (set in Vercel after discovery)
 */

import { verifyToken } from './auth.js';

// ── Auth ──────────────────────────────────────────────────────────────────────
function authenticate(req, res) {
  const apiKey = process.env.AGENT_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'AGENT_API_KEY not set.' }); return null; }
  const payload = verifyToken(req.headers['x-agent-token'] || '', apiKey);
  if (!payload) { res.status(401).json({ error: 'Unauthorized.' }); return null; }
  return payload.sub;
}

// ── Supabase: fetch stored tokens ─────────────────────────────────────────────
async function getStoredTokens(userId) {
  const r = await fetch(
    process.env.SUPABASE_URL + '/rest/v1/profiles?user_id=eq.' + encodeURIComponent(userId) + '&limit=1',
    {
      headers: {
        'apikey':        process.env.SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + process.env.SUPABASE_ANON_KEY,
      }
    }
  );
  const rows = await r.json();
  return rows[0]?.profile_json?.gbp_tokens || null;
}

async function updateStoredTokens(userId, tokens, existingProfile) {
  const profile = existingProfile || {};
  profile.gbp_tokens = tokens;
  await fetch(
    process.env.SUPABASE_URL + '/rest/v1/profiles?on_conflict=user_id',
    {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        process.env.SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + process.env.SUPABASE_ANON_KEY,
        'Prefer':        'resolution=merge-duplicates',
      },
      body: JSON.stringify({ user_id: userId, profile_json: profile }),
    }
  );
}

// ── Get a valid access token ──────────────────────────────────────────────────
// Priority:
//   1. Env var GBP_REFRESH_TOKEN — permanent, survives all deployments
//   2. Supabase stored tokens — set by OAuth flow
// This means once GBP_REFRESH_TOKEN is in Vercel, the agent never loses connection.
async function refreshWithToken(refreshToken) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      refresh_token: refreshToken,
      client_id:     process.env.GBP_CLIENT_ID,
      client_secret: process.env.GBP_CLIENT_SECRET,
      grant_type:    'refresh_token',
    }).toString(),
  });
  const fresh = await r.json();
  if (!r.ok || !fresh.access_token) {
    throw new Error('Token refresh failed: ' + (fresh.error_description || fresh.error || 'unknown'));
  }
  return { access_token: fresh.access_token, expires_in: fresh.expires_in || 3600 };
}

// In-memory access token cache — survives within a single Vercel invocation
let _cachedToken     = null;
let _cachedExpiresAt = 0;

async function getAccessToken(userId) {
  // Serve from in-memory cache if still valid (60s buffer)
  if (_cachedToken && Date.now() < _cachedExpiresAt - 60000) {
    return _cachedToken;
  }

  // ── Path 1: GBP_REFRESH_TOKEN env var (permanent, deployment-safe) ─────
  const envRefreshToken = process.env.GBP_REFRESH_TOKEN;
  if (envRefreshToken) {
    try {
      const fresh = await refreshWithToken(envRefreshToken);
      _cachedToken     = fresh.access_token;
      _cachedExpiresAt = Date.now() + fresh.expires_in * 1000;
      return _cachedToken;
    } catch(e) {
      console.warn('[gbp] env refresh token failed, trying Supabase:', e.message);
      // Fall through to Supabase path
    }
  }

  // ── Path 2: Supabase stored tokens (set by OAuth flow) ──────────────────
  const stored = await getStoredTokens(userId);
  if (!stored) {
    throw new Error(
      'GBP not connected. Add GBP_REFRESH_TOKEN to Vercel env vars, or visit /api/gbp-auth?user=' + userId + ' to authorise.'
    );
  }

  // If stored access token still valid, return it
  if (stored.expires_at && Date.now() < stored.expires_at - 60000) {
    _cachedToken     = stored.access_token;
    _cachedExpiresAt = stored.expires_at;
    return _cachedToken;
  }

  // Stored token expired — refresh it
  if (!stored.refresh_token) {
    throw new Error('No refresh token in Supabase. Add GBP_REFRESH_TOKEN to Vercel, or re-authorise at /api/gbp-auth?user=' + userId);
  }

  const fresh = await refreshWithToken(stored.refresh_token);
  const updated = {
    ...stored,
    access_token: fresh.access_token,
    expires_at:   Date.now() + fresh.expires_in * 1000,
  };
  // Update Supabase async — don't block the response
  updateStoredTokens(userId, updated).catch(e => console.warn('[gbp] Supabase token update failed:', e.message));

  _cachedToken     = fresh.access_token;
  _cachedExpiresAt = updated.expires_at;
  return _cachedToken;
}

// ── GBP API call helper ───────────────────────────────────────────────────────
// Fetch with 10s timeout so Vercel never hangs
async function timedFetch(url, opts, label) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timer);
    return r;
  } catch(e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error(label + ' timed out after 10s');
    throw e;
  }
}

async function gbpFetch(accessToken, path, method = 'GET', body = null) {
  const base = 'https://mybusinessbusinessinformation.googleapis.com/v1';
  const url  = path.startsWith('http') ? path : base + path;

  const opts = {
    method,
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type':  'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const r    = await timedFetch(url, opts, 'GBP API');
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch(e) { data = { raw: text }; }
  if (!r.ok) throw new Error('GBP API error ' + r.status + ': ' + (data.error?.message || text.slice(0,200)));
  return data;
}

// Posts use a different API base
async function gbpPostsFetch(accessToken, locationName, method = 'GET', body = null) {
  const url = 'https://mybusiness.googleapis.com/v4/' + locationName + '/localPosts';
  const opts = {
    method,
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const r    = await timedFetch(url, opts, 'GBP Posts');
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch(e) { data = { raw: text }; }
  if (!r.ok) throw new Error('GBP Posts error ' + r.status + ': ' + (data.error?.message || text.slice(0,200)));
  return data;
}

// Reviews also use v4
async function gbpReviewsFetch(accessToken, locationName, method = 'GET', body = null) {
  const url = 'https://mybusiness.googleapis.com/v4/' + locationName + '/reviews';
  const opts = {
    method,
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const r    = await timedFetch(url, opts, 'GBP Reviews');
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch(e) { data = { raw: text }; }
  if (!r.ok) throw new Error('GBP Reviews error ' + r.status + ': ' + (data.error?.message || text.slice(0,200)));
  return data;
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Agent-Token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const userId = authenticate(req, res);
  if (!userId) return;

  const accountId  = process.env.GBP_ACCOUNT_ID;   // e.g. accounts/123456789
  const locationId = process.env.GBP_LOCATION_ID;   // e.g. locations/987654321
  const body       = req.body || {};
  const { action } = body;

  if (!action) return res.status(400).json({ error: 'action is required' });

  try {
    const accessToken  = await getAccessToken(userId);
    // GBP v1 API uses just locationId for most calls (not account/location combined)
    const locationName = locationId || null;  // e.g. locations/9277209819091563497
    const fullName     = accountId && locationId ? accountId + '/' + locationId : null;

    // ── Get accounts (first-time setup — run this to find your account ID) ──
    if (action === 'getAccounts') {
      const data = await gbpFetch(accessToken,
        'https://mybusinessaccountmanagement.googleapis.com/v1/accounts');
      return res.status(200).json({
        accounts: (data.accounts || []).map(a => ({ name: a.name, accountName: a.accountName, type: a.type }))
      });
    }

    // ── Get locations (run after getAccounts to find your location ID) ──────
    if (action === 'getLocations') {
      const acct = body.accountId || accountId;
      if (!acct) return res.status(400).json({ error: 'accountId required' });
      const data = await gbpFetch(accessToken,
        'https://mybusinessbusinessinformation.googleapis.com/v1/' + acct + '/locations?readMask=name,title,phoneNumbers,websiteUri,regularHours');
      return res.status(200).json({
        locations: (data.locations || []).map(l => ({ name: l.name, title: l.title, phone: l.phoneNumbers?.primaryPhone }))
      });
    }

    // All remaining actions need account + location set
    if (!locationName) {
      return res.status(400).json({
        error: 'GBP_ACCOUNT_ID and GBP_LOCATION_ID not set in Vercel env vars. First run getAccounts then getLocations to find these values, then add them to Vercel.'
      });
    }

    // ── Get profile / listing info ───────────────────────────────────────────
    if (action === 'getProfile') {
      const data = await gbpFetch(accessToken,
        'https://mybusinessbusinessinformation.googleapis.com/v1/' + locationName +
        '?readMask=name,title,phoneNumbers,websiteUri,regularHours,specialHours,profile,categories,storefrontAddress');
      return res.status(200).json({ profile: data });
    }

    // ── Create / publish a post ──────────────────────────────────────────────
    if (action === 'createPost') {
      const { content, callToAction, actionType, actionUrl } = body;
      if (!content) return res.status(400).json({ error: 'content is required' });

      const postBody = {
        languageCode: 'en',
        summary:      content,
        topicType:    'STANDARD',
      };
      if (callToAction && actionUrl) {
        postBody.callToAction = {
          actionType: actionType || 'LEARN_MORE',
          url:        actionUrl,
        };
      }

      const data = await gbpPostsFetch(accessToken, fullName || locationName, 'POST', postBody);
      return res.status(200).json({
        success:  true,
        postName: data.name,
        postUrl:  data.searchUrl || null,
        state:    data.state || 'LIVE',
      });
    }

    // ── Get recent reviews ───────────────────────────────────────────────────
    if (action === 'getReviews') {
      const data = await gbpReviewsFetch(accessToken, fullName || locationName);
      const reviews = (data.reviews || []).slice(0, 10).map(r => ({
        reviewId:    r.reviewId,
        reviewer:    r.reviewer?.displayName || 'Anonymous',
        rating:      r.starRating,
        comment:     r.comment || '',
        time:        r.createTime,
        replied:     !!r.reviewReply,
        replyText:   r.reviewReply?.comment || null,
      }));
      return res.status(200).json({ reviews, totalReviews: data.totalReviewCount });
    }

    // ── Reply to a review ────────────────────────────────────────────────────
    if (action === 'replyReview') {
      const { reviewId, reply } = body;
      if (!reviewId || !reply) return res.status(400).json({ error: 'reviewId and reply required' });
      await timedFetch(
        'https://mybusiness.googleapis.com/v4/' + (fullName || locationName) + '/reviews/' + reviewId + '/reply',
        {
          method:  'PUT',
          headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ comment: reply }),
        },
        'GBP Review Reply'
      );
      return res.status(200).json({ success: true, reviewId });
    }

    // ── Update regular business hours ────────────────────────────────────────
    if (action === 'updateHours') {
      const { hours } = body;
      if (!hours) return res.status(400).json({ error: 'hours object required' });
      // hours format: { MONDAY: { open: '09:00', close: '17:00' }, ... }
      // or { MONDAY: null } to mark as closed
      const periods = [];
      const dayMap  = { MONDAY:1, TUESDAY:2, WEDNESDAY:3, THURSDAY:4, FRIDAY:5, SATURDAY:6, SUNDAY:7 };
      Object.entries(hours).forEach(([day, times]) => {
        if (!times) return; // closed day — omit from periods
        const [openH, openM]   = (times.open  || '09:00').split(':').map(Number);
        const [closeH, closeM] = (times.close || '17:00').split(':').map(Number);
        periods.push({
          openDay:   day,
          closeDay:  day,
          openTime:  { hours: openH,  minutes: openM  || 0 },
          closeTime: { hours: closeH, minutes: closeM || 0 },
        });
      });
      await gbpFetch(accessToken,
        'https://mybusinessbusinessinformation.googleapis.com/v1/' + locationName +
        '?updateMask=regularHours',
        'PATCH',
        { regularHours: { periods } }
      );
      return res.status(200).json({ success: true });
    }

    // ── Update special / holiday hours ───────────────────────────────────────
    if (action === 'updateSpecialHours') {
      const { specialHours } = body;
      // specialHours: [{ date: '2024-12-25', closed: true }, { date: '2024-12-26', open: '10:00', close: '14:00' }]
      if (!specialHours) return res.status(400).json({ error: 'specialHours array required' });
      const periods = specialHours.map(h => {
        const [y,mo,d] = h.date.split('-').map(Number);
        const period = { startDate: { year:y, month:mo, day:d }, endDate: { year:y, month:mo, day:d } };
        if (h.closed) {
          period.closed = true;
        } else {
          const [oh,om] = (h.open  || '09:00').split(':').map(Number);
          const [ch,cm] = (h.close || '17:00').split(':').map(Number);
          period.openTime  = { hours: oh, minutes: om || 0 };
          period.closeTime = { hours: ch, minutes: cm || 0 };
        }
        return period;
      });
      await gbpFetch(accessToken,
        'https://mybusinessbusinessinformation.googleapis.com/v1/' + locationName +
        '?updateMask=specialHours',
        'PATCH',
        { specialHours: { specialHourPeriods: periods } }
      );
      return res.status(200).json({ success: true });
    }

    // ── Update business description ──────────────────────────────────────────
    if (action === 'updateDescription') {
      const { description } = body;
      if (!description) return res.status(400).json({ error: 'description required' });
      if (description.length > 750) return res.status(400).json({ error: 'Description max 750 characters' });
      await gbpFetch(accessToken,
        'https://mybusinessbusinessinformation.googleapis.com/v1/' + locationName +
        '?updateMask=profile.description',
        'PATCH',
        { profile: { description } }
      );
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch(err) {
    console.error('[gbp] error:', err.message);
    // Detect auth errors specifically
    if (err.message.includes('not connected') || err.message.includes('authorise') || err.message.includes('refresh') || err.message.includes('Token refresh failed')) {
      return res.status(401).json({
        error: err.message,
        needsAuth: true,
        fix: 'Add GBP_REFRESH_TOKEN, GBP_CLIENT_ID, GBP_CLIENT_SECRET, GBP_ACCOUNT_ID, GBP_LOCATION_ID to Vercel environment variables.',
      });
    }
    return res.status(500).json({ error: err.message });
  }
}
