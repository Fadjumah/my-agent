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

// ── Task-type classifier ────────────────────────────────────────────────────
// Returns 'creative' | 'code' | 'fast' | 'general'
function classifyTask(systemPrompt, userMessage, history) {
  const text = [userMessage, (history || []).slice(-2).map(m => m.content).join(' ')].join(' ').toLowerCase();

  // Code / logic / structured
  if (/\b(code|debug|fix|refactor|deploy|git|github|function|class|api|json|sql|bash|python|javascript|typescript|error|bug|stack trace|implement|algorithm|regex|compile|lint)\b/.test(text))
    return 'code';

  // Creative / long-form
  if (/\b(write|draft|essay|article|story|creative|blog|caption|post|email|letter|describe|narrative|poem|script|rewrite|tone|voice|brand)\b/.test(text))
    return 'creative';

  // Fast / short — greetings, simple lookups, status checks
  if (text.length < 80 || /^(what|when|where|who|how many|list|show|get|fetch|check|status|yes|no|ok|sure|done)\b/.test(text.trim()))
    return 'fast';

  return 'general';
}

// ── Model priority chains per task type ─────────────────────────────────────
// Each entry: { provider, model, label }
function buildModelChain(preferredProvider, taskType, availableKeys) {
  const has = {
    claude: !!availableKeys.claude,
    openai: !!availableKeys.openai,
    gemini: !!availableKeys.gemini,
  };

  const claude  = { provider: 'claude',  model: 'claude-sonnet-4-6',    label: 'Claude Sonnet 4.6' };
  const gpt4o   = { provider: 'openai',  model: 'gpt-4o',               label: 'GPT-4o' };
  const gpt4om  = { provider: 'openai',  model: 'gpt-4o-mini',          label: 'GPT-4o Mini' };
  const gemflash= { provider: 'gemini',  model: 'gemini-2.5-flash',     label: 'Gemini 2.5 Flash' };
  const gempro  = { provider: 'gemini',  model: 'gemini-2.5-pro',       label: 'Gemini 2.5 Pro' };

  // Chains ordered by task preference
  const chains = {
    code:     [gpt4o, gempro, claude, gpt4om, gemflash],
    creative: [claude, gpt4o, gempro, gpt4om, gemflash],
    fast:     [gemflash, gpt4om, claude, gpt4o, gempro],
    general:  [claude, gpt4o, gemflash, gpt4om, gempro],
  };

  let chain = chains[taskType] || chains.general;

  // If user has a preferred provider, move it to the front (keeping task order for rest)
  if (preferredProvider && preferredProvider !== 'auto') {
    const preferred = chain.filter(m => m.provider === preferredProvider);
    const rest      = chain.filter(m => m.provider !== preferredProvider);
    chain = [...preferred, ...rest];
  }

  // Filter to only models whose API keys exist
  return chain.filter(m => has[m.provider]);
}

// ── Streaming helpers ────────────────────────────────────────────────────────
function makeSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  return {
    send:  (text) => res.write('data: ' + JSON.stringify({ t: text }) + '\n\n'),
    meta:  (m)    => res.write('data: ' + JSON.stringify({ meta: m }) + '\n\n'),
    error: (msg)  => { res.write('data: ' + JSON.stringify({ error: msg }) + '\n\n'); res.end(); },
    done:  ()     => { res.write('data: [DONE]\n\n'); res.end(); },
  };
}

// ── Error classifier — is this retryable? ───────────────────────────────────
function isRetryable(status, message) {
  if (status === 429)  return true;   // rate limit
  if (status === 529)  return true;   // Anthropic overloaded
  if (status === 503)  return true;   // service unavailable
  if (status === 502)  return true;   // bad gateway
  if (status >= 500)   return true;   // server errors
  if (status === 401)  return false;  // auth failure — not retryable with same key
  if (status === 400)  return false;  // bad request — our payload is wrong
  const msg = (message || '').toLowerCase();
  if (msg.includes('quota'))         return true;
  if (msg.includes('rate limit'))    return true;
  if (msg.includes('overloaded'))    return true;
  if (msg.includes('capacity'))      return true;
  if (msg.includes('too many'))      return true;
  return false;
}

// ── Individual provider stream functions ────────────────────────────────────
async function streamGemini(apiKey, modelId, systemPrompt, history, userMessage, attachments) {
  const modelName = modelId || 'gemini-2.5-flash';
  const contents  = [];
  if (systemPrompt) {
    contents.push({ role: 'user',  parts: [{ text: systemPrompt }] });
    contents.push({ role: 'model', parts: [{ text: 'Understood.' }] });
  }
  for (const m of history) {
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
  }
  const userParts = [];
  for (const att of (attachments || [])) {
    if (att.type && att.type.startsWith('image/')) userParts.push({ inlineData: { mimeType: att.type, data: att.data } });
    else if (att.textContent) userParts.push({ text: '[Attached: ' + att.name + ']\n' + att.textContent });
  }
  if (userMessage) userParts.push({ text: userMessage });
  contents.push({ role: 'user', parts: userParts });

  const r = await fetch(
    'https://generativelanguage.googleapis.com/v1/models/' + modelName + ':streamGenerateContent?alt=sse',
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body:    JSON.stringify({ contents, generationConfig: { maxOutputTokens: 3000, temperature: 0.7 } }),
    }
  );
  if (!r.ok) {
    const txt = await r.text();
    let msg = 'Gemini HTTP ' + r.status;
    try { msg = JSON.parse(txt).error?.message || msg; } catch(e) {}
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return r; // return raw response for streaming
}

async function streamOpenAI(apiKey, modelId, systemPrompt, history, userMessage, attachments) {
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  for (const m of history) messages.push({ role: m.role, content: m.content });

  let lastContent;
  if ((attachments || []).length) {
    lastContent = [];
    for (const att of attachments) {
      if (att.type && att.type.startsWith('image/')) lastContent.push({ type: 'image_url', image_url: { url: 'data:' + att.type + ';base64,' + att.data } });
      else if (att.textContent) lastContent.push({ type: 'text', text: '[Attached: ' + att.name + ']\n' + att.textContent });
    }
    if (userMessage) lastContent.push({ type: 'text', text: userMessage });
  } else {
    lastContent = userMessage;
  }
  messages.push({ role: 'user', content: lastContent });

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body:    JSON.stringify({ model: modelId || 'gpt-4o-mini', messages, max_tokens: 3000, temperature: 0.7, stream: true }),
  });
  if (!r.ok) {
    const txt = await r.text();
    let msg = 'OpenAI HTTP ' + r.status;
    try { msg = JSON.parse(txt).error?.message || msg; } catch(e) {}
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return r;
}

async function streamClaude(apiKey, modelId, systemPrompt, history, userMessage, attachments, extendedThinking, thinkingBudget) {
  const messages = [];
  for (const m of history) messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });

  let lastContent;
  if ((attachments || []).length) {
    lastContent = [];
    for (const att of attachments) {
      if (att.type && att.type.startsWith('image/')) lastContent.push({ type: 'image', source: { type: 'base64', media_type: att.type, data: att.data } });
      else if (att.type === 'application/pdf' && att.data) lastContent.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: att.data } });
      else if (att.textContent) lastContent.push({ type: 'text', text: '[Attached: ' + att.name + ']\n' + att.textContent });
    }
    if (userMessage) lastContent.push({ type: 'text', text: userMessage });
  } else {
    lastContent = userMessage;
  }
  messages.push({ role: 'user', content: lastContent });

  const useThinking  = extendedThinking === true;
  const budgetTokens = Math.min(Math.max(thinkingBudget || 8000, 1024), 32000);
  const maxTokens    = useThinking ? Math.max(4000, budgetTokens + 2000) : 3000;

  const claudeBody = {
    model:      modelId || 'claude-sonnet-4-6',
    max_tokens: maxTokens,
    system:     systemPrompt || undefined,
    messages,
    stream:     true,
    temperature: useThinking ? 1 : 0.7,
  };
  if (useThinking) claudeBody.thinking = { type: 'enabled', budget_tokens: budgetTokens };

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta':    'interleaved-thinking-2025-05-14',
    },
    body: JSON.stringify(claudeBody),
  });
  if (!r.ok) {
    const txt = await r.text();
    let msg = 'Claude HTTP ' + r.status;
    try { msg = JSON.parse(txt).error?.message || msg; } catch(e) {}
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return r;
}

// ── SSE stream drainer — provider-aware ─────────────────────────────────────
async function drainStream(upstream, provider, sse, useThinking) {
  const reader  = upstream.body.getReader();
  const decoder = new TextDecoder();
  let   buffer  = '';
  let   currentBlockType = 'text';

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

        if (provider === 'gemini') {
          const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) sse.send(text);
        }

        if (provider === 'openai') {
          const text = chunk.choices?.[0]?.delta?.content;
          if (text) sse.send(text);
        }

        if (provider === 'claude') {
          if (chunk.type === 'content_block_start') {
            currentBlockType = chunk.content_block?.type || 'text';
            if (currentBlockType === 'thinking' && useThinking) sse.meta({ thinking: true });
          }
          if (chunk.type === 'content_block_delta') {
            if (chunk.delta?.type === 'text_delta' && currentBlockType !== 'thinking') {
              sse.send(chunk.delta.text);
            }
            // thinking_delta: silently discarded, never sent to client
          }
          if (chunk.type === 'content_block_stop' && currentBlockType === 'thinking') {
            sse.meta({ thinkingDone: true });
          }
        }
      } catch(e) { /* skip malformed chunk */ }
    }
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Agent-Token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });
  if (!authenticate(req, res)) return;

  const body = req.body || {};
  const {
    provider: preferredProvider = 'auto',
    systemPrompt,
    history       = [],
    userMessage,
    extendedThinking = false,
    thinkingBudget   = 8000,
    attachments      = [],
    taskType: clientTaskType,    // optional hint from frontend
  } = body;

  if (!userMessage && !attachments.length)
    return res.status(400).json({ error: 'userMessage or attachments required' });

  // Available keys
  const keys = {
    claude: process.env.CLAUDE_KEY         || '',
    openai: process.env.OPENAI_API_KEY     || '',
    gemini: process.env.GEMINI_API_KEY     || '',
  };

  if (!keys.claude && !keys.openai && !keys.gemini)
    return res.status(500).json({ error: 'No AI provider keys configured.' });

  // Classify task
  const taskType = clientTaskType || classifyTask(systemPrompt, userMessage, history);

  // Build ordered fallback chain
  const chain = buildModelChain(preferredProvider, taskType, keys);
  if (!chain.length) return res.status(500).json({ error: 'No available AI providers.' });

  // Start SSE
  const sse = makeSSE(res);

  // ── Attempt each model in chain until one succeeds ──────────────────────
  let lastError = null;

  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    const key   = keys[model.provider];
    if (!key) continue;

    // On first model: no delay. On retry: 1.5s max delay (snappy)
    if (i > 0) await new Promise(r => setTimeout(r, Math.min(i * 500, 1500)));

    try {
      let upstream;

      if (model.provider === 'gemini') {
        upstream = await streamGemini(key, model.model, systemPrompt, history, userMessage, attachments);
      } else if (model.provider === 'openai') {
        upstream = await streamOpenAI(key, model.model, systemPrompt, history, userMessage, attachments);
      } else if (model.provider === 'claude') {
        upstream = await streamClaude(key, model.model, systemPrompt, history, userMessage, attachments, extendedThinking, thinkingBudget);
      }

      // Signal which model is actually responding (silent meta — frontend can log, not display)
      sse.meta({ activeModel: model.label, provider: model.provider, taskType, switchedFrom: i > 0 ? chain[i-1].label : null });

      // Drain the stream
      await drainStream(upstream, model.provider, sse, extendedThinking);
      sse.done();
      return; // success — we are done

    } catch (err) {
      lastError = err;
      const status  = err.status || 0;
      const retryable = isRetryable(status, err.message);

      console.warn('[ai] ' + model.label + ' failed (' + (status || 'network') + '): ' + err.message + ' — ' + (retryable ? 'trying next' : 'not retryable'));

      // Auth failure on a key — skip ALL models for this provider, not just this one
      if (status === 401) {
        // Remove remaining models from this provider
        while (i + 1 < chain.length && chain[i + 1].provider === model.provider) i++;
      }

      // Non-retryable + last model → bail immediately
      if (!retryable && i >= chain.length - 1) break;

      // Continue to next model in chain (loop increments i)
      continue;
    }
  }

  // All models exhausted — only now tell the user
  const finalMsg = lastError && lastError.message
    ? 'All AI providers are currently unavailable: ' + lastError.message
    : 'All AI providers are currently unavailable. Please try again shortly.';
  sse.error(finalMsg);
}
