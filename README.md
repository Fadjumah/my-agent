# My AI Agent 🤖

A personal AI agent that lives in your browser. Powered by OpenAI and connected directly to GitHub — no server, no installation, no cost to host.

## What It Does

- **Remembers you** — saves your name, preferences, and learns new facts about you over time
- **Understands plain language** — just tell it what you want, no technical knowledge needed
- **Deploys to GitHub** — can push file changes directly to your repos with a single confirmation tap
- **Works on any device** — phone, tablet, desktop, any browser

## How To Use

1. Open the live site
2. Tap ⚙️ Settings and fill in:
   - Your name
   - OpenAI API key (`sk-proj-...`)
   - GitHub Personal Access Token (`ghp_...`)
   - Your GitHub repo and a nickname for it
   - A little about yourself and your preferences
3. Tap **Save & Start Chatting**
4. Talk to it like a person

## Example Things You Can Say

- *"Deploy all the ENT site fixes to GitHub now"*
- *"What do you remember about me?"*
- *"How do I add a new blog post to my site?"*
- *"Update the address on my contact page"*
- *"What sites do you know about?"*

## Security

- Your API keys are saved only in **your browser's localStorage**
- Keys are never stored in this file or sent anywhere except OpenAI and GitHub directly
- Always delete your GitHub token after a deploy session and generate a fresh one next time

## Live Site

👉 [https://Fadjumah.github.io/my-agent](https://Fadjumah.github.io/my-agent)

## Built With

- OpenAI GPT-4o-mini
- GitHub Contents API
- Pure HTML, CSS and JavaScript — zero dependencies
