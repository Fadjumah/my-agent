/**
 * /api/learn  —  Adaptive learning engine (Supabase backend)
 *
 * POST { action: 'log',      userMsg, aiReply, feedback }  ->  logs one exchange
 * POST { action: 'analyse' }                                ->  daily analysis, updates profile
 * POST { action: 'digest'  }                                ->  generates weekly digest
 * GET  { ?action=profile   }                                ->  returns full readable profile summary
 * GET                                                        ->  returns raw profile + lastLearn
 *
 * Required env vars: AGENT_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, GEMINI_API_KEY
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

// ── Supabase REST helpers ─────────────────────────────────────────────────────
function sbHeaders() {
  return {
    'Content-Type':  'application/json',
    'apikey':        process.env.SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + process.env.SUPABASE_ANON_KEY,
    'Prefer':        'return=representation',
  };
}
function sbUrl(path) { return process.env.SUPABASE_URL + '/rest/v1/' + path; }

async function sbInsert(table, row) {
  const r = await fetch(sbUrl(table), { method: 'POST', headers: sbHeaders(), body: JSON.stringify(row) });
  const t = await r.text();
  if (!r.ok) throw new Error('Supabase insert failed: ' + t.slice(0, 200));
  return t ? JSON.parse(t) : [];
}

async function sbSelect(table, filter) {
  const r = await fetch(sbUrl(table + '?' + filter), { method: 'GET', headers: { ...sbHeaders(), Prefer: 'return=representation' } });
  const t = await r.text();
  if (!r.ok) throw new Error('Supabase select failed: ' + t.slice(0, 200));
  return t ? JSON.parse(t) : [];
}

async function sbUpsert(table, row, onConflict) {
  const headers = { ...sbHeaders(), Prefer: 'resolution=merge-duplicates,return=representation' };
  const url     = sbUrl(table) + (onConflict ? '?on_conflict=' + onConflict : '');
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(row) });
  const t = await r.text();
  if (!r.ok) throw new Error('Supabase upsert failed: ' + t.slice(0, 200));
  return t ? JSON.parse(t) : [];
}

async function sbTrimInteractions(userId) {
  const rows = await sbSelect('interactions',
    'user_id=eq.' + encodeURIComponent(userId) + '&select=timestamp&order=timestamp.desc&limit=1&offset=200');
  if (!rows.length) return;
  const cutoff = rows[0].timestamp;
  await fetch(sbUrl('interactions?user_id=eq.' + encodeURIComponent(userId) + '&timestamp=lt.' + cutoff),
    { method: 'DELETE', headers: sbHeaders() });
}

// ── Topic classifier — ENT-aware ──────────────────────────────────────────────
const TOPIC_PATTERNS = [
  // ENT clinical procedures
  { topic: 'ent_procedures',  re: /\b(rhinoplasty|septoplasty|tympanoplasty|myringotomy|mastoidectomy|adenoidectomy|tonsillectomy|stapedectomy|laryngoscopy|endoscopy|sinusitis|epistaxis|turbinate|nasal|polyp|otitis|tinnitus|vertigo|hearing loss|cholesteatoma|cochlear|ossiculoplasty)\b/i },
  // ENT clinic operations
  { topic: 'clinic_ops',      re: /\b(patient|clinic|appointment|referral|booking|theatre|ward|outpatient|inpatient|consent|discharge|follow.?up|review|consultation|diagnosis|prescription|anaes)\b/i },
  // Medical business & admin
  { topic: 'medical_admin',   re: /\b(insurance|nhif|billing|invoice|medical record|hospital|staff|nurse|theatre list|operation list|waiting list|bed|admission)\b/i },
  // SEO & digital marketing
  { topic: 'seo',             re: /\b(seo|google|search|ranking|keyword|traffic|backlink|meta|sitemap|schema|crawl|serp|domain|analytics|impression)\b/i },
  // Social media & content
  { topic: 'social_media',    re: /\b(social|instagram|facebook|twitter|tiktok|post|caption|reel|story|content|audience|follower|engagement|hashtag)\b/i },
  // Business strategy
  { topic: 'strategy',        re: /\b(business|revenue|growth|market|strateg|plan|goal|expansion|partnership|brand|reputation|referral network|compete)\b/i },
  // Finance
  { topic: 'finance',         re: /\b(revenue|cost|budget|profit|invoice|payment|price|fee|salary|expense|cash flow|financial)\b/i },
  // Coding & tech
  { topic: 'coding',          re: /\b(code|deploy|github|html|css|javascript|bug|fix|function|api|database|server|frontend|backend|vercel|supabase)\b/i },
  // Automation & tools
  { topic: 'automation',      re: /\b(automat|workflow|system|process|tool|script|schedule|zap|make|integration|webhook)\b/i },
  // Patient education & awareness
  { topic: 'patient_education', re: /\b(educate|awareness|explain to patient|patient understand|brochure|leaflet|video|FAQ|what is|how does|symptoms)\b/i },
];

function classifyTopics(text) {
  return TOPIC_PATTERNS.filter(p => p.re.test(text)).map(p => p.topic);
}

// ── Core analysis ─────────────────────────────────────────────────────────────
function analyseInteractions(rows) {
  if (!rows || !rows.length) return null;

  const w50 = rows.slice(-50);
  const profile = {
    updatedAt:         Date.now(),
    totalInteractions: rows.length,
    style:             { prefersBrief: null, prefersBullets: null, avgReplyWordCount: null },
    topicFrequency:    {},
    hourlyActivity:    Array(24).fill(0),
    recentSentiment:   0,
    recurringTopics:   [],
    observations:      [],
    feedbackTrend:     [],
    weeklyTopics:      {},   // topics from last 7 days only
  };

  let posCount = 0, negCount = 0;
  let totalWords = 0, wordSamples = 0;
  let bulletPos = 0, bulletNeg = 0;
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  for (const row of w50) {
    if (row.timestamp) profile.hourlyActivity[new Date(row.timestamp).getHours()]++;
    const score = typeof row.feedback === 'number' ? row.feedback : 0;
    if (score ===  1) posCount++;
    if (score === -1) negCount++;
    profile.feedbackTrend.push({ t: row.timestamp, score });
    if (row.reply_words) { totalWords += row.reply_words; wordSamples++; }
    if (score ===  1 && row.had_bullets) bulletPos++;
    if (score === -1 && row.had_bullets) bulletNeg++;
    const topics = Array.isArray(row.topics) ? row.topics : [];
    topics.forEach(t => {
      profile.topicFrequency[t] = (profile.topicFrequency[t] || 0) + 1;
      if (row.timestamp > weekAgo) {
        profile.weeklyTopics[t] = (profile.weeklyTopics[t] || 0) + 1;
      }
    });
  }

  const total = posCount + negCount || 1;
  profile.recentSentiment = Math.round(((posCount - negCount) / total) * 100) / 100;

  if (wordSamples >= 5) {
    const avg = Math.round(totalWords / wordSamples);
    profile.style.avgReplyWordCount = avg;
    profile.style.prefersBrief      = avg < 120;
  }
  if (bulletPos + bulletNeg >= 4) profile.style.prefersBullets = bulletPos > bulletNeg;

  profile.recurringTopics = Object.entries(profile.topicFrequency)
    .sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([topic, count]) => ({ topic, count }));

  const maxAct = Math.max(...profile.hourlyActivity);
  profile.peakUsageHour = profile.hourlyActivity.indexOf(maxAct);

  // ── Human-readable observations ───────────────────────────────────────────
  const obs = [];
  if (profile.recentSentiment >= 0.4)
    obs.push('Strong positive feedback recently — current reply style is working well, keep it.');
  else if (profile.recentSentiment <= -0.2)
    obs.push('Some friction in recent exchanges — be more direct and concise, cut padding.');
  if (profile.style.prefersBrief === true)
    obs.push('Prefers concise replies under 120 words.');
  else if (profile.style.prefersBrief === false)
    obs.push('Engages well with detailed, thorough responses.');
  if (profile.style.prefersBullets === false)
    obs.push('Dislikes bullet-point lists — use flowing prose instead.');
  else if (profile.style.prefersBullets === true)
    obs.push('Responds well to structured bullet-point answers.');
  if (profile.recurringTopics.length) {
    const names = profile.recurringTopics.slice(0, 4)
      .map(t => t.topic.replace(/_/g, ' ')).join(', ');
    obs.push('Most active topics overall: ' + names + '.');
  }
  const weekTopNames = Object.entries(profile.weeklyTopics)
    .sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([t]) => t.replace(/_/g, ' '));
  if (weekTopNames.length)
    obs.push('This week focused on: ' + weekTopNames.join(', ') + '.');
  const h = profile.peakUsageHour;
  if (maxAct > 0) {
    if (h >= 5  && h < 12) obs.push('Most active in the mornings.');
    if (h >= 12 && h < 17) obs.push('Most active in the afternoons.');
    if (h >= 17 || h < 5)  obs.push('Most active in the evenings.');
  }
  profile.observations = obs;

  return profile;
}

// ── Build plain-language "what do you know about me" summary via Gemini ───────
async function buildReadableSummary(profile, interactions, userId) {
  if (!profile) return 'I have not gathered enough data yet. Keep chatting and I will build a picture of how you like to work.';

  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    // Fallback: build summary without LLM
    const lines = [];
    lines.push('Here is what I have learned about you so far:\n');
    if (profile.totalInteractions) lines.push('We have had ' + profile.totalInteractions + ' exchanges together.');
    if (profile.observations && profile.observations.length) {
      profile.observations.forEach(o => lines.push('• ' + o));
    }
    if (profile.style.avgReplyWordCount) lines.push('• Your preferred reply length seems to be around ' + profile.style.avgReplyWordCount + ' words.');
    return lines.join('\n');
  }

  // Sample recent messages to give Gemini real context
  const recentSample = (interactions || []).slice(-20).map(r =>
    'User said: "' + (r.user_msg || '').slice(0, 120) + '"'
  ).join('\n');

  const topicList = (profile.recurringTopics || []).map(t =>
    t.topic.replace(/_/g, ' ') + ' (' + t.count + ' times)'
  ).join(', ');

  const prompt = `You are an AI agent writing a warm, personal summary for your user named Fahad about what you have learned about them from your conversations.

Data about Fahad:
- Total conversations: ${profile.totalInteractions}
- Most discussed topics: ${topicList || 'not enough data yet'}
- Recent sentiment score: ${profile.recentSentiment} (range -1 to +1, higher = more positive)
- Prefers brief replies: ${profile.style.prefersBrief === null ? 'unknown yet' : profile.style.prefersBrief}
- Prefers bullet points: ${profile.style.prefersBullets === null ? 'unknown yet' : profile.style.prefersBullets}
- Peak usage hour: ${profile.peakUsageHour}:00
- Weekly focus: ${JSON.stringify(profile.weeklyTopics || {})}
- Observations so far: ${(profile.observations || []).join(' | ')}

Sample of recent messages from Fahad:
${recentSample || '(none yet)'}

Write a warm, conversational 3–5 sentence paragraph (no bullet points, no headers) summarising:
1. What topics Fahad focuses on most
2. How he likes replies (style, length, tone)
3. Any patterns you have noticed about when and how he works
4. What this week has been about

Write in second person (you/your), as if speaking directly to Fahad. Be specific and personal, not generic. Keep it under 150 words.`;

  try {
    const r = await fetch(
      'https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent',
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
        body:    JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 300, temperature: 0.7 },
        }),
      }
    );
    const data = await r.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Could not generate summary right now.';
  } catch(e) {
    return 'Could not generate summary: ' + e.message;
  }
}

// ── Generate weekly digest ────────────────────────────────────────────────────
async function generateWeeklyDigest(profile, interactions, userId) {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) return null;

  const weekAgo     = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weekRows    = (interactions || []).filter(r => r.timestamp > weekAgo);
  const allMessages = weekRows.map(r => '"' + (r.user_msg || '').slice(0, 100) + '"').join('\n');
  const topicCount  = {};
  weekRows.forEach(r => (r.topics || []).forEach(t => { topicCount[t] = (topicCount[t] || 0) + 1; }));
  const topTopics = Object.entries(topicCount).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t.replace(/_/g, ' ')).join(', ');
  const posCount  = weekRows.filter(r => r.feedback ===  1).length;
  const negCount  = weekRows.filter(r => r.feedback === -1).length;

  const prompt = `You are a smart AI agent writing a weekly digest for your user Fahad (an ENT surgeon in Uganda running Eritage ENT Care).

This past week's data:
- Number of conversations: ${weekRows.length}
- Main topics discussed: ${topTopics || 'various'}
- Positive feedback moments: ${posCount}
- Moments of friction: ${negCount}
- Sample of what Fahad worked on this week:
${allMessages.slice(0, 1500) || '(no data)'}

Write a concise weekly digest with exactly these three sections, each 2–3 sentences:

**This week** — what Fahad focused on and accomplished

**Patterns noticed** — any recurring themes, habits, or working style observations from this week

**To carry forward** — one or two concrete suggestions for next week based on what you observed

Keep the tone warm, direct, and professional. No fluff. Total length under 200 words.`;

  try {
    const r = await fetch(
      'https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent',
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
        body:    JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 400, temperature: 0.6 },
        }),
      }
    );
    const data = await r.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch(e) {
    console.error('[digest] generation failed:', e.message);
    return null;
  }
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
    return res.status(500).json({ error: 'SUPABASE_URL or SUPABASE_ANON_KEY not set.' });
  }

  try {
    // ── GET: return profile or readable summary ───────────────────────────
    if (req.method === 'GET') {
      const action = req.query?.action;

      const profileRows = await sbSelect('profiles',
        'user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
      const profileRow  = profileRows[0] || null;
      const profile     = profileRow?.profile_json || null;
      const lastLearn   = profileRow?.last_analysed_at
        ? new Date(profileRow.last_analysed_at).getTime() : 0;

      // Return plain-language "what do you know about me" summary
      if (action === 'summary') {
        const interactions = await sbSelect('interactions',
          'user_id=eq.' + encodeURIComponent(userId) + '&order=timestamp.desc&limit=20');
        const summary = await buildReadableSummary(profile, interactions, userId);
        return res.status(200).json({ summary });
      }

      // Return weekly digest (cached or freshly generated)
      if (action === 'digest') {
        const interactions = await sbSelect('interactions',
          'user_id=eq.' + encodeURIComponent(userId) + '&order=timestamp.desc&limit=100');
        // Use cached digest if generated in last 24h
        const cachedDigest = profile?.lastDigest;
        const digestAge    = profile?.lastDigestAt ? Date.now() - profile.lastDigestAt : Infinity;
        if (cachedDigest && digestAge < 24 * 60 * 60 * 1000) {
          return res.status(200).json({ digest: cachedDigest, cached: true });
        }
        const digest = await generateWeeklyDigest(profile, interactions, userId);
        // Cache digest inside profile
        if (digest && profile) {
          profile.lastDigest   = digest;
          profile.lastDigestAt = Date.now();
          await sbUpsert('profiles', {
            user_id:          userId,
            profile_json:     profile,
            last_analysed_at: new Date().toISOString(),
          }, 'user_id');
        }
        return res.status(200).json({ digest: digest || 'Not enough data yet for a weekly digest.' });
      }

      return res.status(200).json({ profile, lastLearn });
    }

    const body = req.body || {};

    // ── POST action=log ───────────────────────────────────────────────────
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
      sbTrimInteractions(userId).catch(() => {});
      return res.status(200).json({ logged: true });
    }

    // ── POST action=analyse ───────────────────────────────────────────────
    if (body.action === 'analyse' || !body.action) {
      const rows = await sbSelect('interactions',
        'user_id=eq.' + encodeURIComponent(userId) + '&order=timestamp.desc&limit=50');
      const totalRows = await sbSelect('interactions',
        'user_id=eq.' + encodeURIComponent(userId) + '&select=id');
      const profile = analyseInteractions(rows);
      if (profile) {
        profile.totalInteractions = totalRows.length;
        await sbUpsert('profiles', {
          user_id:          userId,
          profile_json:     profile,
          last_analysed_at: new Date().toISOString(),
        }, 'user_id');
      }
      return res.status(200).json({ analysed: true, interactionCount: totalRows.length, profile });
    }

    // ── POST action=digest ────────────────────────────────────────────────
    if (body.action === 'digest') {
      const profileRows = await sbSelect('profiles',
        'user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
      const profile = profileRows[0]?.profile_json || null;
      const interactions = await sbSelect('interactions',
        'user_id=eq.' + encodeURIComponent(userId) + '&order=timestamp.desc&limit=100');
      const digest = await generateWeeklyDigest(profile, interactions, userId);
      // Cache it
      if (digest) {
        const updated = profile || {};
        updated.lastDigest   = digest;
        updated.lastDigestAt = Date.now();
        await sbUpsert('profiles', {
          user_id:          userId,
          profile_json:     updated,
          last_analysed_at: new Date().toISOString(),
        }, 'user_id');
      }
      return res.status(200).json({ digest: digest || 'Not enough interaction data yet for a digest.' });
    }

    return res.status(400).json({ error: 'Unknown action: ' + body.action });

  } catch(err) {
    console.error('[learn] error:', err.message);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
