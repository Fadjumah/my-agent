# Synapse ✦

**A precision execution agent for Fadjumah — connected to GitHub, Google Business Profile, and the web. Hosted on Vercel. Zero API keys in the browser.**

---

## What Synapse Is

Synapse is not a generic chatbot. It is a named, self-aware agent built specifically to manage Eritage ENT Care's digital operations — code deployments, Google Business Profile, strategy, and institutional memory — from any device, without technical knowledge.

It runs the **Scofield Method**: every complex task goes through four explicit phases before a single file is touched.

```
SURVEY → MAP → PLAN → EXECUTE
```

Survey the terrain. Map what was found. Plan every step in sequence. Execute fully, in one session, without stalling.

---

## Architecture

```
Browser (index.html + auth.js + api.js + ui.js + chat.js + app.js)
│
│  sends: userMessage, history, systemPrompt, session token
│  receives: streaming SSE chunks
▼
Vercel Serverless Functions
├── /api/auth.js       → login / JWT session tokens
├── /api/ai.js         → Claude Sonnet (primary), Gemini fallback, extended thinking
├── /api/github.js     → GitHub API (read, write, scan, diff, revert, impact analysis)
├── /api/gbp.js        → Google Business Profile (24 actions across 6 categories)
├── /api/sync.js       → Supabase cloud sync — persistent memory across devices
├── /api/learn.js      → Adaptive learning profile, interaction scoring
├── /api/gbp-auth.js   → GBP OAuth flow (one-time setup)
└── /api/debug.js      → Environment health check

API keys never touch the browser.
They live exclusively in Vercel environment variables.
```

---

## Core Capabilities

### 🧠 Persistent Memory
- Cross-session, cross-device memory via Supabase
- Learns facts from every conversation automatically
- Long-term memory summary injected into every system prompt
- Adaptive profile: communication style, interaction patterns, predicted needs

### 🐙 GitHub — Full Repository Control
| Action | Description |
|---|---|
| `listRepos` | List all accessible repositories |
| `getRepo` | Fetch repo metadata and language |
| `listFiles` | Browse directory structure |
| `getFile` | Read any file with SHA tracking |
| `listCommits` | Commit history |
| `pushFile` | Write file with conflict detection + secrets scan |
| `revertFile` | Roll back a file to any prior commit |
| `getDiff` | Compare two refs |
| `analyzeImpact` | Assess change impact before pushing |
| `scanSecrets` | Detect exposed API keys before any push |

All multi-step GitHub tasks use the **PLAN tag** — reads before writes, full step tracker visible in the UI, AI synthesis delivered at the end.

### 📍 Google Business Profile — 24 Live Actions
**Read:** `getProfile`, `getReviews`, `getPosts`, `listPhotos`, `getQuestions`, `getInsights`

**Contact & Identity:** `updatePhoneNumbers` (primary + additional), `updateWebsite`, `updateAddress`, `updateCategory`, `updateDescription`, `updateHours`, `updateSpecialHours`

**Posts:** `createPost`, `updatePost`, `deletePost`

**Reviews:** `replyReview`, `deleteReviewReply`

**Photos:** `uploadPhoto`, `deletePhoto`

**Q&A:** `answerQuestion`, `deleteAnswer`

**Analytics:** `getInsights` — impressions (Maps + Search), direction requests, call clicks, website clicks — by date range.

### ⚡ AI Engine
- **Primary:** Claude Sonnet 4 (claude-sonnet-4-20250514) — streaming, extended thinking
- **Fallback:** Gemini 2.0 Flash (automatic on rate limit or error)
- **Extended Thinking:** toggleable deep reasoning mode for complex problems
- **Mode switching:** Strategic mode (planning, GBP, advice) ↔ Code mode (GitHub, deployments)
- Exponential backoff with automatic provider switching — never fails silently

### 🔐 Security
- JWT session tokens (never raw passwords after login)
- All API keys in Vercel env vars — never in localStorage, never sent to client
- Secrets scanner runs before every push — aborts if keys detected
- Conflict detection on every write — prevents overwriting remote changes
- Audit trail — full log of every push with SHA, branch, timestamp

---

## File Structure

```
/
├── index.html          ← Full UI shell (login, sidebar, chat, settings)
├── styles.css          ← Zinc dust design system + mobile responsive + planning panel
├── app.js              ← Storage layer, cloud sync, app init
├── auth.js             ← Login, JWT, session management
├── api.js              ← All client-side API calls (AI, GitHub, GBP, sync)
├── ui.js               ← DOM, status bar, wave shimmer, planning panel, settings
├── chat.js             ← System prompt (Scofield Method), message handling,
│                          executePlan, handleResponse, action tag routing
├── vercel.json         ← Routing config
└── api/
    ├── ai.js           ← Claude + Gemini handler (streaming SSE, extended thinking)
    ├── github.js       ← GitHub REST API (read/write/scan/diff/revert)
    ├── gbp.js          ← Google Business Profile (24 actions, token refresh)
    ├── gbp-auth.js     ← GBP OAuth 2.0 flow
    ├── auth.js         ← Login endpoint, JWT signing
    ├── sync.js         ← Supabase read/write for cross-device state
    ├── learn.js        ← Adaptive learning, interaction logging
    └── debug.js        ← Env var health check
```

---

## Vercel Environment Variables

| Variable | Purpose |
|---|---|
| `AGENT_API_KEY` | Master API key — signs all JWT session tokens |
| `AGENT_USERNAME` | Login username |
| `AGENT_PASSWORD` | Login password |
| `ANTHROPIC_API_KEY` | Claude Sonnet — primary AI engine |
| `GEMINI_API_KEY` | Gemini — fallback AI engine |
| `GITHUB_TOKEN` | GitHub Personal Access Token (scopes: `repo`) |
| `GBP_CLIENT_ID` | Google Cloud OAuth client ID |
| `GBP_CLIENT_SECRET` | Google Cloud OAuth client secret |
| `GBP_REFRESH_TOKEN` | GBP long-lived refresh token (set after OAuth) |
| `GBP_ACCOUNT_ID` | GBP account ID (e.g. `accounts/123456789`) |
| `GBP_LOCATION_ID` | GBP location ID (e.g. `locations/987654321`) |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anon key |
| `JWT_SECRET` | JWT signing secret |

---

## Data Storage Model

| Data | Where | Browser visible? |
|---|---|---|
| API keys | Vercel env vars | ❌ Never |
| GitHub token | Vercel env vars | ❌ Never |
| GBP credentials | Vercel env vars | ❌ Never |
| Session token (JWT) | sessionStorage | ✅ (expires on tab close) |
| Name, prefs, settings | localStorage + Supabase | ✅ (not sensitive) |
| Cross-chat memory | Supabase (cloud-synced) | ✅ (your own data) |
| Chat history | localStorage + Supabase | ✅ (your own data) |
| Audit log | localStorage | ✅ (your own data) |

---

## Setup

1. Push all files to a GitHub repository
2. Connect the repository to Vercel (auto-deploys on push)
3. In **Vercel → Settings → Environment Variables**, add all keys from the table above
4. For GBP: visit `/api/gbp-auth?user=yourusername` once to complete OAuth, then add `GBP_REFRESH_TOKEN` to Vercel
5. Open your Vercel URL, log in, tap ⚙️ Settings and fill in your name, preferences, and active repo

---

## The Scofield Method

When given a complex task — reviewing a repo, fixing multiple files, deploying changes — Synapse follows four explicit phases:

1. **SURVEY** — reads the repo structure first. Never writes blindly.
2. **MAP** — states exactly what it found and what needs doing, before any changes.
3. **PLAN** — emits a full execution plan: all steps in sequence, reads before writes.
4. **EXECUTE** — runs every step in the live planning panel, reports precisely, synthesises findings at the end.

The UI shows a live step tracker with status indicators (pending → active → done → error), file sizes, commit SHAs, and a final synthesis from the AI once all steps complete — all in a single session.

---

## Built With

- **Anthropic Claude Sonnet 4** — primary intelligence
- **Google Gemini 2.0 Flash** — fallback / rate limit resilience
- **GitHub REST API v3** — repository management
- **Google Business Profile API v1** + **Business Profile Performance API**
- **Vercel Serverless Functions** — zero-config deployment
- **Supabase** — cross-device persistent memory and cloud sync
- **Pure HTML, CSS, JavaScript** — zero frontend dependencies, zero build step
- **DM Sans** typography + zinc dust design system
