/**
 * /api/learn  —  Adaptive learning engine (Supabase backend)
 *
 * POST { action: 'log',     userMsg, aiReply, feedback }  ->  logs one exchange
 * POST { action: 'analyse' }                               ->  runs daily analysis, updates profile
 * GET                                                       ->  returns current profile + lastLearn
 *
 * Supabase tables (create once via SQL editor):
 *   interactions  — one row per message exchange
 *   profiles      — one row per user, upserted on each analysis run
 *
 * Required env vars: AGENT_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY
 */

import { verifyToken } from './auth.js';

// ── Auth ──────────────────────────────────────────────────────────────────────
function authenticate(req, res) {
  const apiKey = process.env.AGENT_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'AGENT_API_KEY not set.' }); return null; }
  const payload = verifyToken(req.headers['x-agent-token'] || '', apiKey);
  if (!payload)  { res.status(401).json({ error: 'Unauthorized.' }); return null; }
  return payload.sub; // username as userId
}

// ── Supabase REST helpers (no SDK — pure fetch) ───────────────────────────────
function sbHeaders() {
  return {
    'Content-Type':  'application/json',
    'apikey':        process.env.SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + process.env.SUPABASE_ANON_KEY,
    'Prefer':        'return=representation',
  };
}

function sbUrl(path) {
  return process.env.SUPABASE_URL + '/rest/v1/' + path;
}

// INSERT a row
async function sbInsert(table, row) {
  const r = await fetch(sbUrl(table), {
    method:  'POST',
    headers: sbHeaders(),
    body:    JSON.stringify(row),
  });
  const text = await r.text();
  if (!r.ok) throw new Error('Supabase insert failed: ' + text.slice(0, 200));
  return text ? JSON.parse(text) : [];
}

// SELECT rows — filter is a query string e.g. "user_id=eq.fahad&order=timestamp.desc&limit=50"
async function sbSelect(table, filter) {
  const r = await fetch(sbUrl(table + '?' + filter), {
    method:  'GET',
    headers: { ...sbHeaders(), 'Prefer': 'return=representation' },
  });
  const text = await r.text();
  if (!r.ok) throw new Error('Supabase select failed: ' + text.slice(0, 200));
  return text ? JSON.parse(text) : [];
}

// UPSERT a row (insert or update on conflict)
async function sbUpsert(table, row, onConflict) {
  const headers = { ...sbHeaders(), 'Prefer': 'resolution=merge-duplicates,return=representation' };
  const url     = sbUrl(table) + (onConflict ? '?on_conflict=' + onConflict : '');
  const r = await fetch(url, {
    method:  'POST',
    headers: headers,
    body:    JSON.stringify(row),
  });
  const text = await r.text();
  if (!r.ok) throw new Error('Supabase upsert failed: ' + text.slice(0, 200));
  return text ? JSON.parse(text) : [];
}

// DELETE old rows to keep the table lean (keep most recent 200 per user)
async function sbTrimInteractions(userId) {
  // Get the 201st row's timestamp (if it exists) and delete everything older
  const rows = await sbSelect(
    'interactions',
    'user_id=eq.' + encodeURIComponent(userId) + '&select=timestamp&order=timestamp.desc&limit=1&offset=200'
  );
  if (!rows.length) return; // fewer than 200 rows — nothing to trim
  const cutoff = rows[0].timestamp;
  await fetch(
    sbUrl('interactions?user_id=eq.' + encodeURIComponent(userId) + '&timestamp=lt.' + cutoff),
    { method: 'DELETE', headers: sbHeaders() }
  );
}

// ── Topic classifier ──────────────────────────────────────────────────────────
const TOPIC_PATTERNS = [
  { topic: 'seo',          re: /\b(seo|google|search|ranking|keyword|traffic|backlink)\b/i },
  { topic: 'clinic_ops',   re: /\b(patient|clinic|appointment|ent|medical|surgery|referral|booking)\b/i },
  { topic: 'coding',       re: /\b(code|deploy|github|html|css|javascript|bug|fix|function|api)\b/i },
  { topic: 'automation',   re: /\b(automat|workflow|system|process|tool|script|schedule)\b/i },
  { topic: 'strategy',     re: /\b(business|revenue|growth|market|strateg|plan|goal)\b/i },
  { topic: 'social_media', re: /\b(social|instagram|facebook|twitter|post|content|caption)\b/i },
  { topic: 'finance',      re: /\b(revenue|cost|budget|profit|invoice|payment|price)\b/i },
];

function classifyTopics(text) {
  return TOPIC_PATTERNS.filter(p => p.re.test(text)).map(p => p.topic);
}

// ── Core analysis — runs on last 50 interactions ──────────────────────────────
function analyseInteractions(rows) {
  if (!rows || !rows.length) return null;

  const profile = {
    updatedAt:         Date.now(),
    totalInteractions: rows.length,
    style: {
      prefersBrief:      null,
      prefersBullets:    null,
      avgReplyWordCount: null,
    },
    topicFrequency:  {},
    hourlyActivity:  Array(24).fill(0),
    recentSentiment: 0,
    recurringTopics: [],
    observations:    [],
    feedbackTrend:   [],
  };

  let posCount = 0, negCount = 0;
  let totalWords = 0, wordSamples = 0;
  let bulletPos  = 0, bulletNeg  = 0;

  for (const row of rows) {
    // Hour-of-day pattern
    if (row.timestamp) {
      profile.hourlyActivity[new Date(row.timestamp).getHours()]++;
    }

    // Feedback
    const score = typeof row.feedback === 'number' ? row.feedback : 0;
    if (score ===  1) posCount++;
    if (score === -1) negCount++;
    profile.feedbackTrend.push({ t: row.timestamp, score });

    // Reply length
    if (row.reply_words) { totalWords += row.reply_words; wordSamples++; }

    // Bullet preference signal
    if (score ===  1 && row.had_bullets) bulletPos++;
    if (score === -1 && row.had_bullets) bulletNeg++;

    // Topic frequency — topics stored as Postgres array, arrives as JS array
    const topics = Array.isArray(row.topics) ? row.topics : [];
    topics.forEach(t => { profile.topicFrequency[t] = (profile.topicFrequency[t] || 0) + 1; });
  }

  // Derived preferences
  const total = posCount + negCount || 1;
  profile.recentSentiment = Math.round(((posCount - negCount) / total) * 100) / 100;

  if (wordSamples >= 5) {
    const avg = Math.round(totalWords / wordSamples);
    profile.style.avgReplyWordCount = avg;
    profile.style.prefersBrief      = avg < 120;
  }
  if (bulletPos + bulletNeg >= 4) {
    profile.style.prefersBullets = bulletPos > bulletNeg;
  }

  // Top topics
  profile.recurringTopics = Object.entries(profile.topicFrequency)
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([topic, count]) => ({ topic, count }));

  // Peak hour
  const maxAct = Math.max(...profile.hourlyActivity);
  profile.peakUsageHour = profile.hourlyActivity.indexOf(maxAct);

  // Human-readable observations injected into the system prompt
  const obs = [];

  if (profile.recentSentiment >= 0.4)
    obs.push('Strong positive feedback — current reply style is working well, keep it.');
  else if (profile.recentSentiment <= -0.2)
    obs.push('Friction detected recently — be more direct and concise, avoid padding.');

  if (profile.style.prefersBrief === true)
    obs.push('Prefers concise replies under 120 words.');
  else if (profile.style.prefersBrief === false)
    obs.push('Engages well with detailed, thorough responses.');

  if (profile.style.prefersBullets === false)
    obs.push('Dislikes bullet-point lists — use flowing prose instead.');
  else if (profile.style.prefersBullets === true)
    obs.push('Responds well to structured bullet-point answers.');

  if (profile.recurringTopics.length) {
    const names = profile.recurringTopics
      .slice(0, 3).map(t => t.topic.replace(/_/g, ' ')).join(', ');
    obs.push('Most active topics this period: ' + names + '.');
  }

  const h = profile.peakUsageHour;
  if (maxAct > 0) {
    if (h >= 5  && h < 12) obs.push('Most active in the mornings.');
    if (h >= 12 && h < 17) obs.push('Most active in the afternoons.');
    if (h >= 17 || h < 5)  obs.push('Most active in the evenings.');
  }

  profile.observations = obs;
  return profile;
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Agent-Token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const userId = authenticate(req, res);
  if (!userId) return;

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return res.status(500).json({
      error: 'SUPABASE_URL or SUPABASE_ANON_KEY not set in Vercel environment variables.',
    });
  }

  try {

    // ── GET: return current profile ─────────────────────────────────────────
    if (req.method === 'GET') {
      const rows = await sbSelect(
        'profiles',
        'user_id=eq.' + encodeURIComponent(userId) + '&limit=1'
      );
      if (!rows.length) return res.status(200).json({ profile: null, lastLearn: 0 });
      const row = rows[0];
      return res.status(200).json({
        profile:   row.profile_json   || null,
        lastLearn: row.last_analysed_at ? new Date(row.last_analysed_at).getTime() : 0,
      });
    }

    const body = req.body || {};

    // ── POST action=log: record one interaction ─────────────────────────────
    if (body.action === 'log') {
      const { userMsg, aiReply, feedback } = body;
      if (!userMsg) return res.status(400).json({ error: 'userMsg is required' });

      await sbInsert('interactions', {
        user_id:     userId,
        timestamp:   Date.now(),
        user_msg:    (userMsg || '').slice(0, 200),
        reply_words: aiReply ? aiReply.split(/\s+/).length : 0,
        had_bullets: !!(aiReply && (aiReply.includes('\u2022') || /^- /m.test(aiReply))),
        topics:      classifyTopics(userMsg),
        feedback:    typeof feedback === 'number' ? feedback : 0,
      });

      // Trim to 200 rows (fire-and-forget, don't await)
      sbTrimInteractions(userId).catch(() => {});

      return res.status(200).json({ logged: true });
    }

    // ── POST action=analyse: run learning analysis ──────────────────────────
    if (body.action === 'analyse' || !body.action) {
      // Fetch last 50 interactions for this user
      const rows = await sbSelect(
        'interactions',
        'user_id=eq.' + encodeURIComponent(userId)
          + '&order=timestamp.desc&limit=50'
      );

      const totalRows = await sbSelect(
        'interactions',
        'user_id=eq.' + encodeURIComponent(userId) + '&select=id'
      );

      const profile = analyseInteractions(rows);

      if (profile) {
        profile.totalInteractions = totalRows.length; // accurate total count
        await sbUpsert('profiles', {
          user_id:          userId,
          profile_json:     profile,
          last_analysed_at: new Date().toISOString(),
        }, 'user_id');
      }

      return res.status(200).json({
        analysed:         true,
        interactionCount: totalRows.length,
        profile:          profile,
      });
    }

    return res.status(400).json({ error: 'Unknown action: ' + body.action });

  } catch (err) {
    console.error('[learn] error:', err.message);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
