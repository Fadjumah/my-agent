My AI Agent 🤖
A personal AI agent powered by Gemini/OpenAI and connected to GitHub — fully hosted on Vercel with zero API keys in the browser.
Architecture
Browser (index.html)
  │  sends: userMessage, history, systemPrompt, provider
  ▼
Vercel Serverless Functions
  ├── /api/ai.js      → calls Gemini or OpenAI using GEMINI_API_KEY / OPENAI_API_KEY
  └── /api/github.js  → calls GitHub API using GITHUB_TOKEN
API keys never touch the browser. They live exclusively in Vercel environment variables.
What It Does
Remembers you — saves your name, preferences, and learns new facts about you over time
Understands plain language — just tell it what you want, no technical knowledge needed
Deploys to GitHub — pushes file changes directly to your repos with a single confirmation tap
Works on any device — phone, tablet, desktop, any browser
Fully secure — no API keys stored in localStorage or exposed to the client
Vercel Environment Variables
Set these in your Vercel project dashboard under Settings → Environment Variables:
Variable
Value
Where to get it
GEMINI_API_KEY
AIza...
aistudio.google.com
OPENAI_API_KEY
sk-proj-...
platform.openai.com
GITHUB_TOKEN
ghp_...
GitHub → Settings → Developer Settings → Personal Access Tokens
GitHub Token Scopes needed: repo (full control of private repositories)
File Structure
/
├── index.html        ← Frontend UI (no keys here)
├── vercel.json       ← Routing config
├── api/
│   ├── ai.js         ← Gemini + OpenAI handler (server-side keys)
│   └── github.js     ← GitHub push/read handler (server-side token)
└── README.md
How To Use
Push these files to your GitHub repo
Connect the repo to Vercel (it will auto-deploy)
In Vercel → Settings → Environment Variables, add your 3 keys
Open your Vercel URL
Tap ⚙️ Settings and fill in:
Your name
Active AI brain (Gemini or OpenAI)
Your GitHub repo and a nickname
A bit about yourself and your preferences
Tap Save & Start Chatting
Example Things You Can Say
"Deploy all the ENT site fixes to GitHub now"
"What do you remember about me?"
"How do I add a new blog post to my site?"
"Update the address on my contact page"
"What sites do you know about?"
Security Model
Data
Where stored
Visible to browser?
API Keys
Vercel env vars
❌ Never
GitHub Token
Vercel env vars
❌ Never
Your name
localStorage
✅ (not sensitive)
Repo name
localStorage
✅ (not sensitive)
Preferences
localStorage
✅ (not sensitive)
Chat history
localStorage
✅ (your own chat)
Built With
Google Gemini 1.5 Flash / OpenAI GPT-4o-mini
GitHub Contents API
Vercel Serverless Functions
Pure HTML, CSS, JavaScript — zero frontend dependencies
