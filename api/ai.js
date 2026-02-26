// Helper: parse raw JSON body from Vercel's Node.js runtime
async function parseBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let raw = '';
    req.on('data', chunk => raw += chunk);
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (e) { reject(new Error('Invalid JSON body: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body;
  try { body = await parseBody(req); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const { provider, systemPrompt, history = [], userMessage } = body;

  if (!userMessage) return res.status(400).json({ error: 'userMessage is required' });
  if (!provider)    return res.status(400).json({ error: 'provider is required' });

  try {

    // ── GEMINI ────────────────────────────────────────────────────────────────
    if (provider === 'gemini') {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured on server.' });

      const contents = [];
      if (systemPrompt) {
        contents.push({ role: 'user',  parts: [{ text: systemPrompt }] });
        contents.push({ role: 'model', parts: [{ text: 'Understood. I am ready to help.' }] });
      }
      for (const m of history) {
        contents.push({
          role:  m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        });
      }
      contents.push({ role: 'user', parts: [{ text: userMessage }] });

      const r = await fetch(
        'https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            contents,
            generationConfig: { maxOutputTokens: 2000, temperature: 0.7 },
          }),
        }
      );

      const data = await r.json();
      if (!r.ok) {
        const msg = data.error?.message || `HTTP ${r.status}`;
        if (r.status === 429) return res.status(429).json({ error: 'Gemini rate limit hit. Wait 30 seconds and try again.' });
        return res.status(r.status).json({ error: 'Gemini error: ' + msg });
      }
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) return res.status(502).json({ error: 'Gemini returned an empty response.' });
      return res.status(200).json({ response: text });
    }

    // ── OPENAI ────────────────────────────────────────────────────────────────
    if (provider === 'openai') {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not configured on server.' });

      const messages = [];
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
      for (const m of history) messages.push({ role: m.role, content: m.content });
      messages.push({ role: 'user', content: userMessage });

      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'gpt-4o-mini', messages, max_tokens: 2000, temperature: 0.7 }),
      });

      const data = await r.json();
      if (!r.ok) {
        const msg = data.error?.message || `HTTP ${r.status}`;
        if (r.status === 401 || r.status === 403) return res.status(401).json({ error: 'Invalid OpenAI API key.' });
        if (r.status === 429) return res.status(429).json({ error: 'OpenAI rate limit or insufficient credits.' });
        return res.status(r.status).json({ error: msg });
      }
      const text = data.choices?.[0]?.message?.content;
      if (!text) return res.status(502).json({ error: 'OpenAI returned an empty response.' });
      return res.status(200).json({ response: text });
    }

    return res.status(400).json({ error: "Invalid provider. Use 'gemini' or 'openai'." });

  } catch (err) {
    console.error('AI handler error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
