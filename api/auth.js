// POST /api/auth — validates admin credentials, returns a signed session token
// Required env vars: ADMIN_USERNAME, ADMIN_PASSWORD, AGENT_API_KEY

import { createHmac } from 'crypto';

export function signToken(payload, secret) {
  const data = JSON.stringify(payload);
  const sig  = createHmac('sha256', secret).update(data).digest('hex');
  return Buffer.from(data).toString('base64url') + '.' + sig;
}

export function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  try {
    const data     = Buffer.from(parts[0], 'base64url').toString('utf8');
    const expected = createHmac('sha256', secret).update(data).digest('hex');
    // Constant-time comparison — prevents timing attacks
    if (parts[1].length !== expected.length) return null;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= parts[1].charCodeAt(i) ^ expected.charCodeAt(i);
    }
    if (diff !== 0) return null;
    const payload = JSON.parse(data);
    if (Date.now() > payload.exp) return null; // expired
    return payload;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const adminUser = process.env.ADMIN_USERNAME;
  const adminPass = process.env.ADMIN_PASSWORD;
  const apiKey    = process.env.AGENT_API_KEY;   // used as the signing secret

  if (!adminUser || !adminPass || !apiKey) {
    return res.status(500).json({ error: 'ADMIN_USERNAME, ADMIN_PASSWORD, or AGENT_API_KEY not set in Vercel.' });
  }

  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required.' });
  }

  const userOk = username === adminUser;
  const passOk = password === adminPass;

  if (!userOk || !passOk) {
    await new Promise(r => setTimeout(r, 500)); // slow brute-force
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  const token = signToken({
    sub: username,
    iat: Date.now(),
    exp: Date.now() + 24 * 60 * 60 * 1000, // 24-hour session
  }, apiKey);

  return res.status(200).json({ token, expiresIn: 86400 });
}
