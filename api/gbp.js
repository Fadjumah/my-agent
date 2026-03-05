/**
 * /api/gbp  —  Google Business Profile management
 *
 * ── READ ──────────────────────────────────────────────────────────────────────
 * POST { action: 'getProfile'   }                          -> get listing info
 * POST { action: 'getReviews'   }                          -> list recent reviews
 * POST { action: 'getPosts',    limit? }                   -> list recent posts
 * POST { action: 'listPhotos'   }                          -> list all photos
 * POST { action: 'getQuestions', limit? }                  -> list customer Q&A
 * POST { action: 'getInsights', startDate, endDate }       -> views/searches/calls analytics
 * POST { action: 'getAccounts'  }                          -> list GBP accounts (setup)
 * POST { action: 'getLocations', accountId }               -> list locations (setup)
 *
 * ── WRITE — contact & identity ────────────────────────────────────────────────
 * POST { action: 'updatePhoneNumbers', primaryPhone, additionalPhones? } -> update phone(s)
 * POST { action: 'updateWebsite',     websiteUri }         -> update website URL
 * POST { action: 'updateAddress',     address }            -> update physical address
 * POST { action: 'updateCategory',    primaryCategory, additionalCategories? } -> update categories
 * POST { action: 'updateDescription', description }        -> update business description
 * POST { action: 'updateHours',       hours }              -> update regular hours
 * POST { action: 'updateSpecialHours',specialHours }       -> set holiday/special hours
 *
 * ── WRITE — posts ─────────────────────────────────────────────────────────────
 * POST { action: 'createPost',  content, callToAction?, actionType?, actionUrl? } -> new post
 * POST { action: 'deletePost',  postName }                 -> delete a post
 * POST { action: 'updatePost',  postName, content }        -> edit existing post
 *
 * ── WRITE — reviews ───────────────────────────────────────────────────────────
 * POST { action: 'replyReview',       reviewId, reply }    -> reply to a review
 * POST { action: 'deleteReviewReply', reviewId }           -> delete your reply
 *
 * ── WRITE — photos ────────────────────────────────────────────────────────────
 * POST { action: 'uploadPhoto',  sourceUrl, category? }    -> add photo by URL
 * POST { action: 'deletePhoto',  mediaName }               -> delete a photo
 *
 * ── WRITE — Q&A ───────────────────────────────────────────────────────────────
 * POST { action: 'answerQuestion', questionId, answer }    -> answer a customer question
 * POST { action: 'deleteAnswer',   questionId }            -> remove your answer
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
async function timedFetch(url, opts, label, maxRetries = 3) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, Math.min(attempt * 1500, 5000)));
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), 12000);
    try {
      const r = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timer);
      // Retry on 503 (Google GBP has occasional service blips)
      if (r.status === 503 && attempt < maxRetries) {
        console.warn('[gbp] 503 on ' + label + ', retrying (' + (attempt+1) + '/' + maxRetries + ')');
        continue;
      }
      return r;
    } catch(e) {
      clearTimeout(timer);
      lastErr = e;
      if (e.name === 'AbortError') lastErr = new Error(label + ' timed out after 12s');
      if (attempt < maxRetries) continue;
    }
  }
  throw lastErr || new Error(label + ' failed after retries');
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

    // ── Get recent posts ─────────────────────────────────────────────────────
    if (action === 'getPosts') {
      const { limit = 5 } = body;
      const data = await gbpPostsFetch(accessToken, fullName || locationName);
      const posts = (data.localPosts || []).slice(0, limit).map(p => ({
        name:        p.name,
        summary:     p.summary || '',
        state:       p.state || '',
        topicType:   p.topicType || '',
        createTime:  p.createTime || '',
        updateTime:  p.updateTime || '',
        searchUrl:   p.searchUrl || null,
        callToAction: p.callToAction || null,
      }));
      return res.status(200).json({
        posts,
        total:    posts.length,
        hasMore:  (data.localPosts || []).length > limit,
        nextPage: data.nextPageToken || null,
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

    // ── Update phone numbers ─────────────────────────────────────────────────
    if (action === 'updatePhoneNumbers') {
      const { primaryPhone, additionalPhones } = body;
      if (!primaryPhone) return res.status(400).json({ error: 'primaryPhone required (e.g. +256XXXXXXXXX)' });
      const phoneNumbers = { primaryPhone };
      if (additionalPhones && additionalPhones.length) {
        phoneNumbers.additionalPhones = Array.isArray(additionalPhones) ? additionalPhones : [additionalPhones];
      }
      await gbpFetch(accessToken,
        'https://mybusinessbusinessinformation.googleapis.com/v1/' + locationName +
        '?updateMask=phoneNumbers',
        'PATCH',
        { phoneNumbers }
      );
      return res.status(200).json({ success: true, phoneNumbers });
    }

    // ── Update website URL ───────────────────────────────────────────────────
    if (action === 'updateWebsite') {
      const { websiteUri } = body;
      if (!websiteUri) return res.status(400).json({ error: 'websiteUri required' });
      await gbpFetch(accessToken,
        'https://mybusinessbusinessinformation.googleapis.com/v1/' + locationName +
        '?updateMask=websiteUri',
        'PATCH',
        { websiteUri }
      );
      return res.status(200).json({ success: true, websiteUri });
    }

    // ── Update physical address ──────────────────────────────────────────────
    if (action === 'updateAddress') {
      const { address } = body;
      // address: { regionCode, postalCode, administrativeArea, locality, addressLines: [] }
      if (!address) return res.status(400).json({ error: 'address object required' });
      await gbpFetch(accessToken,
        'https://mybusinessbusinessinformation.googleapis.com/v1/' + locationName +
        '?updateMask=storefrontAddress',
        'PATCH',
        { storefrontAddress: address }
      );
      return res.status(200).json({ success: true });
    }

    // ── Update business categories ───────────────────────────────────────────
    if (action === 'updateCategory') {
      const { primaryCategory, additionalCategories } = body;
      // primaryCategory: { name: 'categories/gcid:otolaryngologist' }
      if (!primaryCategory) return res.status(400).json({ error: 'primaryCategory required e.g. { name: "categories/gcid:otolaryngologist" }' });
      const cats = { primaryCategory };
      if (additionalCategories && additionalCategories.length) {
        cats.additionalCategories = additionalCategories;
      }
      await gbpFetch(accessToken,
        'https://mybusinessbusinessinformation.googleapis.com/v1/' + locationName +
        '?updateMask=categories',
        'PATCH',
        cats
      );
      return res.status(200).json({ success: true });
    }

    // ── Delete a post ────────────────────────────────────────────────────────
    if (action === 'deletePost') {
      const { postName } = body;
      if (!postName) return res.status(400).json({ error: 'postName required (get from getPosts)' });
      const url = 'https://mybusiness.googleapis.com/v4/' + postName;
      const r = await timedFetch(url, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + accessToken },
      }, 'GBP Delete Post');
      if (!r.ok) {
        const txt = await r.text();
        throw new Error('Delete post failed ' + r.status + ': ' + txt.slice(0, 200));
      }
      return res.status(200).json({ success: true, deleted: postName });
    }

    // ── Update (edit) an existing post ──────────────────────────────────────
    if (action === 'updatePost') {
      const { postName, content } = body;
      if (!postName || !content) return res.status(400).json({ error: 'postName and content required' });
      const url = 'https://mybusiness.googleapis.com/v4/' + postName + '?updateMask=summary';
      const r = await timedFetch(url, {
        method:  'PATCH',
        headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ summary: content }),
      }, 'GBP Update Post');
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch(e) { data = {}; }
      if (!r.ok) throw new Error('Update post failed ' + r.status + ': ' + (data.error?.message || text.slice(0, 200)));
      return res.status(200).json({ success: true, post: data });
    }

    // ── Delete a review reply ────────────────────────────────────────────────
    if (action === 'deleteReviewReply') {
      const { reviewId } = body;
      if (!reviewId) return res.status(400).json({ error: 'reviewId required' });
      const url = 'https://mybusiness.googleapis.com/v4/' + (fullName || locationName) + '/reviews/' + reviewId + '/reply';
      const r = await timedFetch(url, {
        method:  'DELETE',
        headers: { 'Authorization': 'Bearer ' + accessToken },
      }, 'GBP Delete Review Reply');
      if (!r.ok) {
        const txt = await r.text();
        throw new Error('Delete reply failed ' + r.status + ': ' + txt.slice(0, 200));
      }
      return res.status(200).json({ success: true, reviewId });
    }

    // ── List photos ──────────────────────────────────────────────────────────
    if (action === 'listPhotos') {
      const url = 'https://mybusiness.googleapis.com/v4/' + (fullName || locationName) + '/media';
      const r   = await timedFetch(url, {
        headers: { 'Authorization': 'Bearer ' + accessToken },
      }, 'GBP List Photos');
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch(e) { data = {}; }
      if (!r.ok) throw new Error('List photos failed ' + r.status + ': ' + (data.error?.message || text.slice(0,200)));
      const photos = (data.mediaItems || []).map(m => ({
        name:        m.name,
        mediaFormat: m.mediaFormat,
        category:    m.locationAssociation?.category || null,
        sourceUrl:   m.sourceUrl || null,
        googleUrl:   m.googleUrl || null,
        createTime:  m.createTime || null,
        dimensions:  m.dimensions || null,
      }));
      return res.status(200).json({ photos, total: photos.length });
    }

    // ── Upload a photo by URL ────────────────────────────────────────────────
    if (action === 'uploadPhoto') {
      const { sourceUrl, category } = body;
      // category: EXTERIOR | INTERIOR | PRODUCT | AT_WORK | FOOD_AND_DRINK | MENU | COMMON_AREA | ROOMS | TEAMS | ADDITIONAL
      if (!sourceUrl) return res.status(400).json({ error: 'sourceUrl required (publicly accessible image URL)' });
      const url = 'https://mybusiness.googleapis.com/v4/' + (fullName || locationName) + '/media';
      const mediaBody = {
        mediaFormat:          'PHOTO',
        locationAssociation:  { category: category || 'ADDITIONAL' },
        sourceUrl,
      };
      const r = await timedFetch(url, {
        method:  'POST',
        headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
        body:    JSON.stringify(mediaBody),
      }, 'GBP Upload Photo');
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch(e) { data = {}; }
      if (!r.ok) throw new Error('Upload photo failed ' + r.status + ': ' + (data.error?.message || text.slice(0,200)));
      return res.status(200).json({ success: true, mediaName: data.name, googleUrl: data.googleUrl || null });
    }

    // ── Delete a photo ───────────────────────────────────────────────────────
    if (action === 'deletePhoto') {
      const { mediaName } = body;
      if (!mediaName) return res.status(400).json({ error: 'mediaName required (get from listPhotos)' });
      const url = 'https://mybusiness.googleapis.com/v4/' + mediaName;
      const r   = await timedFetch(url, {
        method:  'DELETE',
        headers: { 'Authorization': 'Bearer ' + accessToken },
      }, 'GBP Delete Photo');
      if (!r.ok) {
        const txt = await r.text();
        throw new Error('Delete photo failed ' + r.status + ': ' + txt.slice(0,200));
      }
      return res.status(200).json({ success: true, deleted: mediaName });
    }

    // ── Get customer Q&A ─────────────────────────────────────────────────────
    if (action === 'getQuestions') {
      const { limit = 10 } = body;
      const url = 'https://mybusiness.googleapis.com/v4/' + (fullName || locationName) + '/questions?pageSize=' + limit;
      const r   = await timedFetch(url, {
        headers: { 'Authorization': 'Bearer ' + accessToken },
      }, 'GBP Get Questions');
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch(e) { data = {}; }
      if (!r.ok) throw new Error('Get questions failed ' + r.status + ': ' + (data.error?.message || text.slice(0,200)));
      const questions = (data.questions || []).map(q => ({
        name:        q.name,
        questionId:  q.name?.split('/').pop(),
        text:        q.text,
        author:      q.author?.displayName || 'Customer',
        createTime:  q.createTime,
        upvoteCount: q.upvoteCount || 0,
        answered:    !!(q.topAnswers && q.topAnswers.length),
        answers:     (q.topAnswers || []).map(a => ({ text: a.text, author: a.author?.displayName, upvotes: a.upvoteCount })),
      }));
      return res.status(200).json({ questions, total: questions.length, totalSize: data.totalSize || 0 });
    }

    // ── Answer a customer question ───────────────────────────────────────────
    if (action === 'answerQuestion') {
      const { questionId, answer } = body;
      if (!questionId || !answer) return res.status(400).json({ error: 'questionId and answer required' });
      const locBase = fullName || locationName;
      const url     = 'https://mybusiness.googleapis.com/v4/' + locBase + '/questions/' + questionId + '/answers';
      const r = await timedFetch(url, {
        method:  'POST',
        headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text: answer }),
      }, 'GBP Answer Question');
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch(e) { data = {}; }
      if (!r.ok) throw new Error('Answer question failed ' + r.status + ': ' + (data.error?.message || text.slice(0,200)));
      return res.status(200).json({ success: true, answer: data });
    }

    // ── Delete your answer to a question ────────────────────────────────────
    if (action === 'deleteAnswer') {
      const { questionId } = body;
      if (!questionId) return res.status(400).json({ error: 'questionId required' });
      const locBase = fullName || locationName;
      const url     = 'https://mybusiness.googleapis.com/v4/' + locBase + '/questions/' + questionId + '/answers:delete';
      const r = await timedFetch(url, {
        method:  'DELETE',
        headers: { 'Authorization': 'Bearer ' + accessToken },
      }, 'GBP Delete Answer');
      if (!r.ok) {
        const txt = await r.text();
        throw new Error('Delete answer failed ' + r.status + ': ' + txt.slice(0,200));
      }
      return res.status(200).json({ success: true, questionId });
    }

    // ── Get insights / analytics ─────────────────────────────────────────────
    if (action === 'getInsights') {
      // Uses Business Profile Performance API (replaced old Insights API)
      const { startDate, endDate } = body;
      // Defaults: last 28 days
      const end   = endDate   ? new Date(endDate)   : new Date();
      const start = startDate ? new Date(startDate) : new Date(end.getTime() - 28 * 24 * 60 * 60 * 1000);
      const fmt   = d => ({ year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() });
      const metrics = [
        'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
        'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
        'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
        'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
        'BUSINESS_DIRECTION_REQUESTS',
        'CALL_CLICKS',
        'WEBSITE_CLICKS',
      ];
      const url = 'https://businessprofileperformance.googleapis.com/v1/' + locationName +
        ':fetchMultiDailyMetricsTimeSeries';
      const r = await timedFetch(url, {
        method:  'POST',
        headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          dailyMetrics:   metrics,
          dailyRange: { startDate: fmt(start), endDate: fmt(end) },
        }),
      }, 'GBP Insights');
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch(e) { data = {}; }
      if (!r.ok) throw new Error('Get insights failed ' + r.status + ': ' + (data.error?.message || text.slice(0,200)));

      // Summarise: sum each metric over the period
      const summary = {};
      (data.multiDailyMetricTimeSeries || []).forEach(series => {
        (series.dailyMetricTimeSeries || []).forEach(ts => {
          const key = ts.dailyMetric;
          const total = (ts.timeSeries?.datedValues || []).reduce((s, v) => s + (v.value || 0), 0);
          summary[key] = total;
        });
      });

      return res.status(200).json({
        period: {
          start: start.toISOString().slice(0,10),
          end:   end.toISOString().slice(0,10),
          days:  Math.round((end - start) / (24*60*60*1000)),
        },
        summary: {
          impressions_maps:    (summary.BUSINESS_IMPRESSIONS_DESKTOP_MAPS    || 0) + (summary.BUSINESS_IMPRESSIONS_MOBILE_MAPS    || 0),
          impressions_search:  (summary.BUSINESS_IMPRESSIONS_DESKTOP_SEARCH  || 0) + (summary.BUSINESS_IMPRESSIONS_MOBILE_SEARCH  || 0),
          direction_requests:  summary.BUSINESS_DIRECTION_REQUESTS || 0,
          call_clicks:         summary.CALL_CLICKS     || 0,
          website_clicks:      summary.WEBSITE_CLICKS  || 0,
        },
        raw: summary,
      });
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
