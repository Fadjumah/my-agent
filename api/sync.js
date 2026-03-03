/**
 * /api/sync  —  Cross-device state sync via Supabase
 *
 * GET  /api/sync?keys=userName,about,prefs,learnedFacts,sessions,...
 *   Returns all requested keys from user's cloud state
 *
 * POST { action: 'set', key, value }
 *   Stores one key-value pair
 *
 * POST { action: 'setBulk', data: { key: value, ... } }
 *   Stores multiple key-value pairs atomically
 *
 * POST { action: 'get', keys: ['userName','about',...] }
 *   Returns requested keys
 *
 * Stored in Supabase `user_state` table:
 *   user_id TEXT, key TEXT, value JSONB, updated_at TIMESTAMPTZ
 *   PRIMARY KEY (user_id, key)
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

async function getKeys(userId, keys) {
  const filter = 'user_id=eq.' + encodeURIComponent(userId)
    + '&key=in.(' + keys.map(k => encodeURIComponent(k)).join(',') + ')';
  const r    = await fetch(sbUrl('user_state?' + filter), { headers: sbHeaders() });
  const rows = await r.json();
  const result = {};
  (rows || []).forEach(row => { result[row.key] = row.value; });
  return result;
}

async function setKey(userId, key, value) {
  await fetch(sbUrl('user_state?on_conflict=user_id,key'), {
    method:  'POST',
    headers: sbHeaders(),
    body:    JSON.stringify({ user_id: userId, key, value, updated_at: new Date().toISOString() }),
  });
}

async function setBulk(userId, data) {
  const rows = Object.entries(data).map(([key, value]) => ({
    user_id:    userId,
    key,
    value,
    updated_at: new Date().toISOString(),
  }));
  if (!rows.length) return;
  await fetch(sbUrl('user_state?on_conflict=user_id,key'), {
    method:  'POST',
    headers: sbHeaders(),
    body:    JSON.stringify(rows),
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Agent-Token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const userId = authenticate(req, res);
  if (!userId) return;

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'Supabase not configured.' });
  }

  try {
    if (req.method === 'GET') {
      const keys = (req.query?.keys || '').split(',').filter(Boolean);
      if (!keys.length) return res.status(400).json({ error: 'keys param required' });
      const data = await getKeys(userId, keys);
      return res.status(200).json({ data });
    }

    const body = req.body || {};

    if (body.action === 'set') {
      if (!body.key) return res.status(400).json({ error: 'key required' });
      await setKey(userId, body.key, body.value);
      return res.status(200).json({ ok: true });
    }

    if (body.action === 'setBulk') {
      if (!body.data) return res.status(400).json({ error: 'data required' });
      await setBulk(userId, body.data);
      return res.status(200).json({ ok: true });
    }

    if (body.action === 'get') {
      const keys = body.keys || [];
      if (!keys.length) return res.status(400).json({ error: 'keys required' });
      const data = await getKeys(userId, keys);
      return res.status(200).json({ data });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch(e) {
    console.error('[sync]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
