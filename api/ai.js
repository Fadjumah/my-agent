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
  const {
    provider,
    systemPrompt,
    history = [],
    userMessage,
    extendedThinking = false,
    thinkingBudget   = 8000,
    attachments      = [],   // [{type:'image/jpeg'|'text', name, data, textContent}]
  } = body;

  if (!userMessage && !attachments.length)
    return res.status(400).json({ error: 'userMessage or attachments required' });
  if (!provider)
    return res.status(400).json({ error: 'provider is required' });

  // ── Streaming headers ──────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  function send(text)  { res.write('data: ' + JSON.stringify({ t: text }) + '\n\n'); }
  function sendMeta(m) { res.write('data: ' + JSON.stringify({ meta: m }) + '\n\n'); }
  function sendError(msg) { res.write('data: ' + JSON.stringify({ error: msg }) + '\n\n'); res.end(); }
  function sendDone()  { res.write('data: [DONE]\n\n'); res.end(); }

  try {

    // ── Gemini ─────────────────────────────────────────────────────────────
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

      // Build user parts (text + attachments)
      const userParts = [];
      for (const att of attachments) {
        if (att.type && att.type.startsWith('image/')) {
          userParts.push({ inlineData: { mimeType: att.type, data: att.data } });
        } else if (att.textContent) {
          userParts.push({ text: '[Attached file: ' + att.name + ']\n' + att.textContent });
        }
      }
      if (userMessage) userParts.push({ text: userMessage });
      contents.push({ role: 'user', parts: userParts });

      const upstream = await fetch(
        'https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body:    JSON.stringify({ contents, generationConfig: { maxOutputTokens: 3000, temperature: 0.7 } }),
        }
      );

      if (!upstream.ok) {
        const errText = await upstream.text();
        let errMsg = 'Gemini error HTTP ' + upstream.status;
        try { const j = JSON.parse(errText); errMsg = j.error?.message || errMsg; } catch(e) {}
        if (upstream.status === 429 || errMsg.toLowerCase().includes('quota'))
          return sendError('QUOTA:' + errMsg);
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
            const text  = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) send(text);
          } catch(e) {}
        }
      }
      return sendDone();
    }

    // ── OpenAI ─────────────────────────────────────────────────────────────
    if (provider === 'openai') {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return sendError('OPENAI_API_KEY not configured.');

      const messages = [];
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
      for (const m of history) messages.push({ role: m.role, content: m.content });

      // Build user content with attachments
      if (attachments.length) {
        const content = [];
        for (const att of attachments) {
          if (att.type && att.type.startsWith('image/')) {
            content.push({ type: 'image_url', image_url: { url: 'data:' + att.type + ';base64,' + att.data } });
          } else if (att.textContent) {
            content.push({ type: 'text', text: '[Attached: ' + att.name + ']\n' + att.textContent });
          }
        }
        if (userMessage) content.push({ type: 'text', text: userMessage });
        messages.push({ role: 'user', content });
      } else {
        messages.push({ role: 'user', content: userMessage });
      }

      const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body:    JSON.stringify({ model: 'gpt-4o-mini', messages, max_tokens: 3000, temperature: 0.7, stream: true }),
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
          } catch(e) {}
        }
      }
      return sendDone();
    }

    // ── Anthropic Claude (claude-sonnet-4-6) ───────────────────────────────
    if (provider === 'claude') {
      const apiKey = process.env.CLAUDE_KEY;
      if (!apiKey) return sendError('CLAUDE_KEY not configured in Vercel environment variables.');

      const messages = [];
      for (const m of history) {
        messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
      }

      // Build last user message — support attachments
      let lastUserContent;
      if (attachments.length) {
        lastUserContent = [];
        for (const att of attachments) {
          if (att.type && att.type.startsWith('image/')) {
            lastUserContent.push({
              type: 'image',
              source: { type: 'base64', media_type: att.type, data: att.data },
            });
          } else if (att.type === 'application/pdf' && att.data) {
            lastUserContent.push({
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: att.data },
            });
          } else if (att.textContent) {
            lastUserContent.push({ type: 'text', text: '[Attached file: ' + att.name + ']\n' + att.textContent });
          }
        }
        if (userMessage) lastUserContent.push({ type: 'text', text: userMessage });
      } else {
        lastUserContent = userMessage;
      }
      messages.push({ role: 'user', content: lastUserContent });

      // ── Extended thinking config ──────────────────────────────────────────
      const useThinking   = extendedThinking === true;
      const budgetTokens  = Math.min(Math.max(thinkingBudget, 1024), 32000);
      const maxTokens     = useThinking ? Math.max(4000, budgetTokens + 2000) : 3000;

      const claudeBody = {
        model:      'claude-sonnet-4-6',
        max_tokens: maxTokens,
        system:     systemPrompt || undefined,
        messages,
        stream:     true,
      };

      if (useThinking) {
        claudeBody.thinking   = { type: 'enabled', budget_tokens: budgetTokens };
        claudeBody.temperature = 1; // required when extended thinking is on
        sendMeta({ thinkingStarted: true });
      } else {
        claudeBody.temperature = 0.7;
      }

      const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method:  'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta':    'interleaved-thinking-2025-05-14',
        },
        body: JSON.stringify(claudeBody),
      });

      if (!upstream.ok) {
        const errText = await upstream.text();
        let errMsg = 'Claude error HTTP ' + upstream.status;
        try { const j = JSON.parse(errText); errMsg = j.error?.message || errMsg; } catch(e) {}
        if (upstream.status === 429) return sendError('QUOTA:' + errMsg);
        if (upstream.status === 401) return sendError('Invalid Anthropic API key — check CLAUDE_KEY in Vercel.');
        return sendError(errMsg);
      }

      const reader  = upstream.body.getReader();
      const decoder = new TextDecoder();
      let   buffer  = '';
      let   currentBlockType = 'text'; // track whether current block is thinking or text

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

            // Track block type — skip thinking blocks, stream only text
            if (chunk.type === 'content_block_start') {
              currentBlockType = chunk.content_block?.type || 'text';
              // Signal thinking in progress to frontend (shown as subtle indicator)
              if (currentBlockType === 'thinking' && useThinking) {
                sendMeta({ thinking: true });
              }
            }

            if (chunk.type === 'content_block_delta') {
              if (chunk.delta?.type === 'text_delta' && currentBlockType !== 'thinking') {
                send(chunk.delta.text);
              }
              // thinking_delta silently discarded — never shown to user
            }

            if (chunk.type === 'content_block_stop' && currentBlockType === 'thinking') {
              sendMeta({ thinkingDone: true });
            }

          } catch(e) {}
        }
      }

      return sendDone();
    }

    sendError("Invalid provider. Use 'gemini', 'openai', or 'claude'.");

  } catch (err) {
    console.error('AI handler error:', err);
    sendError(err.message || 'Internal server error');
  }
}
