import { verifyToken } from './auth.js';

function authenticate(req, res) {
  const apiKey = process.env.AGENT_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'AGENT_API_KEY not set.' }); return false; }
  const token = req.headers['x-agent-token'] || '';
  if (!verifyToken(token, apiKey)) {
    res.status(401).json({ error: 'Unauthorized. Session invalid or expired — please log in again.' });
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Agent-Token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });
  if (!authenticate(req, res)) return;

  const body = req.body || {};
  const { provider, systemPrompt, history = [], userMessage } = body;
  if (!userMessage) return res.status(400).json({ error: 'userMessage is required' });
  if (!provider)    return res.status(400).json({ error: 'provider is required' });

  // ── Set streaming headers ──────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering on Vercel

  // Helper: send one SSE chunk
  function send(text) {
    res.write('data: ' + JSON.stringify({ t: text }) + '\n\n');
  }
  function sendError(msg) {
    res.write('data: ' + JSON.stringify({ error: msg }) + '\n\n');
    res.end();
  }
  function sendDone() {
    res.write('data: [DONE]\n\n');
    res.end();
  }

  try {

    // ── Gemini streaming ───────────────────────────────────────────────────
    if (provider === 'gemini') {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return sendError('GEMINI_API_KEY not configured.');

      const contents = [];
      if (systemPrompt) {
        contents.push({ role: 'user',  parts: [{ text: systemPrompt }] });
        contents.push({ role: 'model', parts: [{ text: 'Understood.' }] });
      }
      for (const m of history) {
        contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
      }
      contents.push({ role: 'user', parts: [{ text: userMessage }] });

      const upstream = await fetch(
        'https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body:    JSON.stringify({ contents, generationConfig: { maxOutputTokens: 2000, temperature: 0.7 } }),
        }
      );

      if (!upstream.ok) {
        const errText = await upstream.text();
        let errMsg = 'Gemini error HTTP ' + upstream.status;
        try { const j = JSON.parse(errText); errMsg = j.error?.message || errMsg; } catch(e) {}
        if (upstream.status === 429 || errMsg.toLowerCase().includes('quota')) {
          return sendError('QUOTA:' + errMsg);
        }
        return sendError(errMsg);
      }

      // Parse Gemini's SSE stream
      const reader  = upstream.body.getReader();
      const decoder = new TextDecoder();
      let   buffer  = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === '[DONE]') continue;
          try {
            const chunk = JSON.parse(raw);
            const text  = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) send(text);
          } catch(e) { /* skip malformed chunk */ }
        }
      }

      return sendDone();
    }

    // ── OpenAI streaming ───────────────────────────────────────────────────
    if (provider === 'openai') {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return sendError('OPENAI_API_KEY not configured.');

      const messages = [];
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
      for (const m of history) messages.push({ role: m.role, content: m.content });
      messages.push({ role: 'user', content: userMessage });

      const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body:    JSON.stringify({ model: 'gpt-4o-mini', messages, max_tokens: 2000, temperature: 0.7, stream: true }),
      });

      if (!upstream.ok) {
        const errText = await upstream.text();
        let errMsg = 'OpenAI error HTTP ' + upstream.status;
        try { const j = JSON.parse(errText); errMsg = j.error?.message || errMsg; } catch(e) {}
        if (upstream.status === 429) return sendError('QUOTA:' + errMsg);
        if (upstream.status === 401) return sendError('Invalid OpenAI API key.');
        return sendError(errMsg);
      }

      const reader  = upstream.body.getReader();
      const decoder = new TextDecoder();
      let   buffer  = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === '[DONE]') continue;
          try {
            const chunk = JSON.parse(raw);
            const text  = chunk.choices?.[0]?.delta?.content;
            if (text) send(text);
          } catch(e) { /* skip */ }
        }
      }

      return sendDone();
    }

    sendError("Invalid provider. Use 'gemini' or 'openai'.");

  } catch (err) {
    console.error('AI handler error:', err);
    sendError(err.message || 'Internal server error');
  }
}
