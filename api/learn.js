/**
 * /api/learn  —  Perpetual adaptive learning engine
 *
 * POST { action: 'log',     userMsg, aiReply, feedback }   -> log interaction + extract patterns immediately
 * POST { action: 'analyse' }                                -> deep analysis of last 100 interactions
 * POST { action: 'digest'  }                                -> weekly digest
 * GET  ?action=summary                                      -> plain-language profile summary
 * GET  ?action=digest                                       -> weekly digest
 * GET                                                       -> raw profile + lastLearn
 */

import { verifyToken } from './auth.js';

function authenticate(req, res) {
  const apiKey = process.env.AGENT_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'AGENT_API_KEY not set.' }); return null; }
  const payload = verifyToken(req.headers['x-agent-token'] || '', apiKey);
  if (!payload) { res.status(401).json({ error: 'Unauthorized.' }); return null; }
  return payload.sub;
}

function sbHeaders() {
  return {
    'Content-Type':  'application/json',
    'apikey':        process.env.SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + process.env.SUPABASE_ANON_KEY,
    'Prefer':        'resolution=merge-duplicates,return=representation',
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
    'user_id=eq.' + encodeURIComponent(userId) + '&select=timestamp&order=timestamp.desc&limit=1&offset=300');
  if (!rows.length) return;
  const cutoff = rows[0].timestamp;
  await fetch(sbUrl('interactions?user_id=eq.' + encodeURIComponent(userId) + '&timestamp=lt.' + cutoff),
    { method: 'DELETE', headers: sbHeaders() });
}

// ── ENT-aware topic classifier ────────────────────────────────────────────────
const TOPIC_PATTERNS = [
  { topic: 'ent_procedures',    re: /\b(rhinoplasty|septoplasty|tympanoplasty|myringotomy|mastoidectomy|adenoidectomy|tonsillectomy|stapedectomy|laryngoscopy|endoscopy|sinusitis|epistaxis|turbinate|nasal|polyp|otitis|tinnitus|vertigo|hearing loss|cholesteatoma|cochlear|ossiculoplasty|ear|nose|throat|ent)\b/i },
  { topic: 'clinic_ops',        re: /\b(patient|clinic|appointment|referral|booking|theatre|ward|outpatient|inpatient|consent|discharge|follow.?up|review|consultation|diagnosis|prescription|anaes|clinic|medical)\b/i },
  { topic: 'medical_admin',     re: /\b(insurance|nhif|billing|invoice|medical record|hospital|staff|nurse|theatre list|operation list|waiting list|bed|admission|fee|payment)\b/i },
  { topic: 'seo',               re: /\b(seo|google|search|ranking|keyword|traffic|backlink|meta|sitemap|schema|crawl|serp|domain|analytics|impression|search console)\b/i },
  { topic: 'social_media',      re: /\b(social|instagram|facebook|twitter|tiktok|post|caption|reel|story|content|audience|follower|engagement|hashtag|gmb|google business)\b/i },
  { topic: 'strategy',          re: /\b(business|revenue|growth|market|strateg|plan|goal|expansion|partnership|brand|reputation|referral network|compete|launch|scale)\b/i },
  { topic: 'finance',           re: /\b(revenue|cost|budget|profit|invoice|payment|price|fee|salary|expense|cash flow|financial|pricing|charge)\b/i },
  { topic: 'coding',            re: /\b(code|deploy|github|html|css|javascript|bug|fix|function|api|database|server|frontend|backend|vercel|supabase|error|file)\b/i },
  { topic: 'automation',        re: /\b(automat|workflow|system|process|tool|script|schedule|zap|make|integration|webhook|agent)\b/i },
  { topic: 'patient_education', re: /\b(educate|awareness|explain|patient understand|brochure|leaflet|video|FAQ|what is|how does|symptoms|condition|treatment)\b/i },
];

function classifyTopics(text) {
  return TOPIC_PATTERNS.filter(p => p.re.test(text)).map(p => p.topic);
}

// ── Real-time micro-pattern extractor (runs on every message) ─────────────────
async function extractMicroPatterns(userMsg, aiReply, existingProfile, geminiKey) {
  if (!geminiKey || !userMsg) return null;

  const existing = existingProfile ? JSON.stringify({
    style:   existingProfile.style,
    patterns: existingProfile.microPatterns,
    prefs:   existingProfile.extractedPrefs,
  }) : '{}';

  const prompt = `You are a pattern recognition engine. Analyse this single conversation exchange and extract any learnable signals about this user. Be hyper-specific and concrete — even tiny signals matter.

User message: "${userMsg.slice(0, 400)}"
AI reply: "${(aiReply || '').slice(0, 300)}"

Existing profile so far: ${existing}

Return ONLY a valid JSON object (no markdown, no explanation) with these fields:
{
  "newPrefs": ["list of new specific preferences noticed, e.g. 'prefers numbered lists', 'asks follow-up immediately', 'uses voice-like sentence structure'"],
  "topicSignal": "dominant topic or null",
  "urgencyLevel": "low|medium|high based on message tone",
  "questionPattern": "type of question asked: directive|exploratory|clarification|approval-seeking|null",
  "impliedGoal": "what the user is ultimately trying to achieve, in 8 words or less, or null",
  "styleSignal": "any writing style observation or null",
  "timePattern": null
}

Only include fields where you actually detected something. Return {} if nothing notable.`;

  try {
    const r = await fetch(
      'https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent',
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
        body:    JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 300, temperature: 0.3 },
        }),
      }
    );
    const data = await r.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch(e) {
    return null;
  }
}

// ── Deep analysis engine ──────────────────────────────────────────────────────
function analyseInteractions(rows) {
  if (!rows || !rows.length) return null;

  const w100 = rows.slice(-100);
  const profile = {
    updatedAt:         Date.now(),
    totalInteractions: rows.length,
    style:             { prefersBrief: null, prefersBullets: null, avgReplyWordCount: null },
    topicFrequency:    {},
    hourlyActivity:    Array(24).fill(0),
    dailyActivity:     Array(7).fill(0),
    recentSentiment:   0,
    recurringTopics:   [],
    observations:      [],
    feedbackTrend:     [],
    weeklyTopics:      {},
    microPatterns:     [],
    extractedPrefs:    [],
    predictedNeeds:    [],
    sessionPatterns:   {},
  };

  let posCount = 0, negCount = 0;
  let totalWords = 0, wordSamples = 0;
  let bulletPos = 0, bulletNeg = 0;
  let shortMsgCount = 0, longMsgCount = 0;
  const weekAgo   = Date.now() - 7  * 24 * 60 * 60 * 1000;
  const monthAgo  = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const topicSequence = [];

  for (const row of w100) {
    const ts = row.timestamp || 0;
    if (ts) {
      const d = new Date(ts);
      profile.hourlyActivity[d.getHours()]++;
      profile.dailyActivity[d.getDay()]++;
    }
    const score = typeof row.feedback === 'number' ? row.feedback : 0;
    if (score ===  1) posCount++;
    if (score === -1) negCount++;
    profile.feedbackTrend.push({ t: ts, score });
    if (row.reply_words) { totalWords += row.reply_words; wordSamples++; }
    if (score ===  1 && row.had_bullets) bulletPos++;
    if (score === -1 && row.had_bullets) bulletNeg++;
    const msgLen = (row.user_msg || '').length;
    if (msgLen < 60)  shortMsgCount++;
    if (msgLen > 200) longMsgCount++;
    const topics = Array.isArray(row.topics) ? row.topics : [];
    topics.forEach(t => {
      profile.topicFrequency[t] = (profile.topicFrequency[t] || 0) + 1;
      if (ts > weekAgo) profile.weeklyTopics[t] = (profile.weeklyTopics[t] || 0) + 1;
    });
    if (topics.length) topicSequence.push({ ts, topics });

    // Collect micro patterns from stored interaction data
    if (row.micro_patterns) {
      try {
        const mp = typeof row.micro_patterns === 'string' ? JSON.parse(row.micro_patterns) : row.micro_patterns;
        if (mp.newPrefs) profile.microPatterns.push(...mp.newPrefs);
        if (mp.impliedGoal) profile.extractedPrefs.push(mp.impliedGoal);
      } catch(e) {}
    }
  }

  const total = posCount + negCount || 1;
  profile.recentSentiment = Math.round(((posCount - negCount) / total) * 100) / 100;

  if (wordSamples >= 5) {
    const avg = Math.round(totalWords / wordSamples);
    profile.style.avgReplyWordCount = avg;
    profile.style.prefersBrief      = avg < 140;
  }
  if (bulletPos + bulletNeg >= 4) profile.style.prefersBullets = bulletPos > bulletNeg;
  profile.style.messageStyle = shortMsgCount > longMsgCount * 2 ? 'terse' : longMsgCount > shortMsgCount * 2 ? 'verbose' : 'mixed';

  profile.recurringTopics = Object.entries(profile.topicFrequency)
    .sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([topic, count]) => ({ topic, count }));

  const maxAct = Math.max(...profile.hourlyActivity);
  profile.peakUsageHour = profile.hourlyActivity.indexOf(maxAct);

  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const maxDay   = Math.max(...profile.dailyActivity);
  profile.peakUsageDay = dayNames[profile.dailyActivity.indexOf(maxDay)];

  // Deduplicate micro patterns
  profile.microPatterns   = [...new Set(profile.microPatterns)].slice(-30);
  profile.extractedPrefs  = [...new Set(profile.extractedPrefs)].slice(-15);

  // Predict likely next needs based on topic sequences
  if (topicSequence.length >= 3) {
    const recent = topicSequence.slice(-5).flatMap(t => t.topics);
    const counts = {};
    recent.forEach(t => { counts[t] = (counts[t] || 0) + 1; });
    profile.predictedNeeds = Object.entries(counts)
      .sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([t]) => t.replace(/_/g, ' '));
  }

  // Build observations
  const obs = [];
  if (profile.recentSentiment >= 0.4)
    obs.push('Strong positive feedback — current approach is working well.');
  else if (profile.recentSentiment <= -0.2)
    obs.push('Some friction detected — be more direct and cut padding.');

  if (profile.style.prefersBrief === true)
    obs.push('Prefers concise replies under 140 words.');
  else if (profile.style.prefersBrief === false)
    obs.push('Engages well with detailed, thorough responses.');

  if (profile.style.messageStyle === 'terse')
    obs.push('Sends short, directive messages — match the energy, be direct back.');
  else if (profile.style.messageStyle === 'verbose')
    obs.push('Writes detailed messages — engage fully with all points raised.');

  if (profile.style.prefersBullets === false)
    obs.push('Dislikes bullet lists — use flowing prose.');
  else if (profile.style.prefersBullets === true)
    obs.push('Responds well to structured bullet answers.');

  if (profile.recurringTopics.length) {
    const names = profile.recurringTopics.slice(0, 4).map(t => t.topic.replace(/_/g, ' ')).join(', ');
    obs.push('Core focus areas: ' + names + '.');
  }

  const weekTopNames = Object.entries(profile.weeklyTopics)
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t.replace(/_/g, ' '));
  if (weekTopNames.length)
    obs.push('This week focused on: ' + weekTopNames.join(', ') + '.');

  if (profile.predictedNeeds.length)
    obs.push('Likely next focus: ' + profile.predictedNeeds.join(', ') + '.');

  const h = profile.peakUsageHour;
  if (maxAct > 0) {
    if (h >= 5  && h < 12) obs.push('Most active in mornings. Peak: ' + h + ':00.');
    if (h >= 12 && h < 17) obs.push('Most active in afternoons. Peak: ' + h + ':00.');
    if (h >= 17 || h < 5)  obs.push('Most active in evenings/nights. Peak: ' + h + ':00.');
  }
  if (profile.peakUsageDay) obs.push('Most active day: ' + profile.peakUsageDay + '.');

  if (profile.microPatterns.length)
    obs.push('Micro patterns: ' + profile.microPatterns.slice(0, 5).join('; ') + '.');

  profile.observations = obs;
  return profile;
}

// ── Build plain-language summary ──────────────────────────────────────────────
async function buildReadableSummary(profile, interactions, userId) {
  if (!profile) return 'I have not gathered enough data yet. Keep chatting and I will build a detailed picture of how you work.';

  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    const lines = [];
    if (profile.totalInteractions) lines.push('Conversations tracked: ' + profile.totalInteractions);
    (profile.observations || []).forEach(o => lines.push('• ' + o));
    return lines.join('\n') || 'Still building your profile.';
  }

  const recentSample = (interactions || []).slice(-15).map(r =>
    'User: "' + (r.user_msg || '').slice(0, 100) + '"'
  ).join('\n');

  const prompt = `You are an AI agent summarising what you have learned about your user Fahad from your conversation history.

Profile data:
- Total interactions: ${profile.totalInteractions}
- Top topics: ${(profile.recurringTopics || []).map(t => t.topic.replace(/_/g,' ') + '×' + t.count).join(', ')}
- This week: ${JSON.stringify(profile.weeklyTopics || {})}
- Sentiment: ${profile.recentSentiment} (-1 to +1)
- Prefers brief: ${profile.style?.prefersBrief}
- Message style: ${profile.style?.messageStyle}
- Peak hour: ${profile.peakUsageHour}:00, Peak day: ${profile.peakUsageDay}
- Micro patterns detected: ${(profile.microPatterns || []).slice(0,8).join('; ')}
- Inferred goals: ${(profile.extractedPrefs || []).slice(0,5).join('; ')}
- Predicted next focus: ${(profile.predictedNeeds || []).join(', ')}
- Observations: ${(profile.observations || []).join(' | ')}

Recent messages:
${recentSample || '(none yet)'}

Write a warm, specific, personal 4–5 sentence paragraph directly to Fahad about:
1. What he focuses on most and what drives him
2. How he communicates and what he expects from replies
3. Patterns you have noticed in his working style and timing
4. What this week has been about and what you predict he will need next

Be concrete and personal — mention specific topics, times, patterns. Second person. Under 180 words. No bullet points.`;

  try {
    const r = await fetch(
      'https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent',
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
        body:    JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 350, temperature: 0.6 },
        }),
      }
    );
    const data = await r.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Could not generate summary.';
  } catch(e) {
    return 'Could not generate summary: ' + e.message;
  }
}

// ── Weekly digest ─────────────────────────────────────────────────────────────
async function generateWeeklyDigest(profile, interactions) {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) return null;

  const weekAgo  = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weekRows = (interactions || []).filter(r => r.timestamp > weekAgo);
  const messages = weekRows.map(r => '"' + (r.user_msg || '').slice(0, 100) + '"').join('\n');
  const topicCount = {};
  weekRows.forEach(r => (r.topics || []).forEach(t => { topicCount[t] = (topicCount[t] || 0) + 1; }));
  const topTopics = Object.entries(topicCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t.replace(/_/g, ' ')).join(', ');

  const prompt = `Weekly digest for Fahad (ENT surgeon, Uganda, running Eritage ENT Care).

This week: ${weekRows.length} conversations. Topics: ${topTopics || 'various'}.
Positive feedback: ${weekRows.filter(r => r.feedback === 1).length}. Friction: ${weekRows.filter(r => r.feedback === -1).length}.
Sample messages this week:
${messages.slice(0, 1500) || '(none)'}
Micro patterns noticed: ${(profile?.microPatterns || []).slice(0,5).join('; ')}
Predicted next week focus: ${(profile?.predictedNeeds || []).join(', ')}

Write exactly three sections:

**This week** — what Fahad worked on, specific topics and themes (2–3 sentences)

**Patterns noticed** — concrete behavioural and working style observations (2 sentences)

**To carry forward** — 2 specific, actionable suggestions for next week based on trajectory (2 sentences)

Warm, direct, professional. Under 200 words total.`;

  try {
    const r = await fetch(
      'https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent',
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
        body:    JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 400, temperature: 0.5 },
        }),
      }
    );
    const data = await r.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch(e) { return null; }
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Agent-Token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const userId = authenticate(req, res);
  if (!userId) return;

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY)
    return res.status(500).json({ error: 'Supabase not configured.' });

  try {
    if (req.method === 'GET') {
      const action = req.query?.action;
      const profileRows = await sbSelect('profiles',
        'user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
      const profileRow = profileRows[0] || null;
      const profile    = profileRow?.profile_json || null;
      const lastLearn  = profileRow?.last_analysed_at ? new Date(profileRow.last_analysed_at).getTime() : 0;

      if (action === 'summary') {
        const interactions = await sbSelect('interactions',
          'user_id=eq.' + encodeURIComponent(userId) + '&order=timestamp.desc&limit=20');
        const summary = await buildReadableSummary(profile, interactions, userId);
        return res.status(200).json({ summary });
      }

      if (action === 'digest') {
        const interactions = await sbSelect('interactions',
          'user_id=eq.' + encodeURIComponent(userId) + '&order=timestamp.desc&limit=100');
        const digestAge = profile?.lastDigestAt ? Date.now() - profile.lastDigestAt : Infinity;
        if (profile?.lastDigest && digestAge < 24 * 60 * 60 * 1000)
          return res.status(200).json({ digest: profile.lastDigest, cached: true });
        const digest = await generateWeeklyDigest(profile, interactions);
        if (digest && profile) {
          profile.lastDigest   = digest;
          profile.lastDigestAt = Date.now();
          await sbUpsert('profiles', { user_id: userId, profile_json: profile, last_analysed_at: new Date().toISOString() }, 'user_id');
        }
        return res.status(200).json({ digest: digest || 'Not enough data yet.' });
      }

      return res.status(200).json({ profile, lastLearn });
    }

    const body = req.body || {};

    // ── POST action=log — runs on every single message ───────────────────────
    if (body.action === 'log') {
      const { userMsg, aiReply, feedback } = body;
      if (!userMsg) return res.status(400).json({ error: 'userMsg required' });

      const geminiKey = process.env.GEMINI_API_KEY;
      const profileRows = await sbSelect('profiles',
        'user_id=eq.' + encodeURIComponent(userId) + '&limit=1').catch(() => []);
      const existingProfile = profileRows[0]?.profile_json || null;

      // Extract micro patterns in real-time
      const microPatterns = await extractMicroPatterns(userMsg, aiReply, existingProfile, geminiKey);

      await sbInsert('interactions', {
        user_id:       userId,
        timestamp:     Date.now(),
        user_msg:      (userMsg || '').slice(0, 300),
        reply_words:   aiReply ? aiReply.split(/\s+/).length : 0,
        had_bullets:   !!(aiReply && (aiReply.includes('•') || /^- /m.test(aiReply) || /^\d+\. /m.test(aiReply))),
        topics:        classifyTopics(userMsg),
        feedback:      typeof feedback === 'number' ? feedback : 0,
        micro_patterns: microPatterns ? JSON.stringify(microPatterns) : null,
      });

      // Run mini-analysis every 5 interactions to keep profile fresh
      const totalRows = await sbSelect('interactions',
        'user_id=eq.' + encodeURIComponent(userId) + '&select=id');
      const count = totalRows.length;

      if (count % 5 === 0) {
        const recent = await sbSelect('interactions',
          'user_id=eq.' + encodeURIComponent(userId) + '&order=timestamp.desc&limit=100');
        const profile = analyseInteractions(recent);
        if (profile) {
          profile.totalInteractions = count;
          await sbUpsert('profiles', {
            user_id:          userId,
            profile_json:     profile,
            last_analysed_at: new Date().toISOString(),
          }, 'user_id');
        }
      }

      sbTrimInteractions(userId).catch(() => {});
      return res.status(200).json({ logged: true, count, microPatterns });
    }

    // ── POST action=analyse — full deep analysis ─────────────────────────────
    if (body.action === 'analyse' || !body.action) {
      const rows  = await sbSelect('interactions',
        'user_id=eq.' + encodeURIComponent(userId) + '&order=timestamp.desc&limit=100');
      const total = await sbSelect('interactions',
        'user_id=eq.' + encodeURIComponent(userId) + '&select=id');
      const profile = analyseInteractions(rows);
      if (profile) {
        profile.totalInteractions = total.length;
        await sbUpsert('profiles', {
          user_id:          userId,
          profile_json:     profile,
          last_analysed_at: new Date().toISOString(),
        }, 'user_id');
      }
      return res.status(200).json({ analysed: true, interactionCount: total.length, profile });
    }

    // ── POST action=digest ───────────────────────────────────────────────────
    if (body.action === 'digest') {
      const profileRows  = await sbSelect('profiles', 'user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
      const profile      = profileRows[0]?.profile_json || null;
      const interactions = await sbSelect('interactions',
        'user_id=eq.' + encodeURIComponent(userId) + '&order=timestamp.desc&limit=100');
      const digest = await generateWeeklyDigest(profile, interactions);
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
      return res.status(200).json({ digest: digest || 'Not enough data yet.' });
    }

    return res.status(400).json({ error: 'Unknown action: ' + body.action });
  } catch(err) {
    console.error('[learn] error:', err.message);
    if (err.message.includes('not connected') || err.message.includes('refresh'))
      return res.status(401).json({ error: err.message });
    return res.status(500).json({ error: err.message });
  }
}
