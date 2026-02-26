export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const { provider, systemPrompt, history = [], userMessage } = body;
  if (!userMessage) return res.status(400).json({ error: 'userMessage is required' });
  if (!provider)    return res.status(400).json({ error: 'provider is required' });

  try {

    if (provider === 'gemini') {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured on server.' });

      const contents = [];
      if (systemPrompt) {
        contents.push({ role: 'user',  parts: [{ text: systemPrompt }] });
        contents.push({ role: 'model', parts: [{ text: 'Understood. Ready to help.' }] });
      }
      for (const m of history) {
        contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
      }
      contents.push({ role: 'user', parts: [{ text: userMessage }] });

      const r = await fetch(
        'https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: 2000, temperature: 0.7 } }),
        }
      );

      const text = await r.text();
      let data;
      try { data = JSON.parse(text); }
      catch(e) { return res.status(502).json({ error: 'Gemini returned invalid response: ' + text.slice(0, 150) }); }

      if (!r.ok) {
        const msg    = data.error?.message || 'HTTP ' + r.status;
        const status = data.error?.status  || '';
        if (r.status === 429 || status === 'RESOURCE_EXHAUSTED' || msg.toLowerCase().includes('quota')) {
          return res.status(429).json({ error: 'Gemini quota exhausted. Resets at midnight Pacific time.' });
        }
        return res.status(r.status).json({ error: 'Gemini error: ' + msg });
      }

      const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!reply) return res.status(502).json({ error: 'Gemini returned empty response.' });
      return res.status(200).json({ response: reply });
    }

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

      const text = await r.text();
      let data;
      try { data = JSON.parse(text); }
      catch(e) { return res.status(502).json({ error: 'OpenAI returned invalid response' }); }

      if (!r.ok) {
        const msg = data.error?.message || 'HTTP ' + r.status;
        if (r.status === 401 || r.status === 403) return res.status(401).json({ error: 'Invalid OpenAI API key.' });
        if (r.status === 429) return res.status(429).json({ error: 'OpenAI rate limit or insufficient credits.' });
        return res.status(r.status).json({ error: msg });
      }

      const reply = data.choices?.[0]?.message?.content;
      if (!reply) return res.status(502).json({ error: 'OpenAI returned empty response.' });
      return res.status(200).json({ response: reply });
    }

    return res.status(400).json({ error: "Invalid provider. Use 'gemini' or 'openai'." });

  } catch (err) {
    console.error('AI handler error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
