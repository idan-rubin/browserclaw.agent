# browserclaw.agent

<p align="center">
  <a href="https://browserclaw.org"><img src="https://img.shields.io/badge/Live-browserclaw.org-orange" alt="Live" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
</p>

The AI driver for [browserclaw](https://github.com/idan-rubin/browserclaw).

The hard part of browser automation isn't controlling the browser — it's knowing what to do next. [browserclaw](https://github.com/idan-rubin/browserclaw) is a powerful engine: fast snapshots, precise element refs, real browser control. But an engine without a conductor just idles. **browserclaw.agent** is the conductor — the intelligence that reads the page, orchestrates each step, adapts when things go wrong, and improves through learned skills.

Most browser agents rely on vision models and screenshots. browserclaw.agent works with accessibility snapshots instead — structured representations of the page that use 4x fewer tokens per step, while navigating the real browser just like a person would.

## How it works

```
snapshot → agent (LLM) → action → repeat
```

The agent receives an accessibility snapshot from browserclaw, reasons about the next step, and picks an action: click, type, navigate, scroll, press-and-hold, or done. When it encounters known obstacles, skills take over.

## Skill Catalog

Every successful run generates a skill file — steps and tips for that domain — stored in MinIO (S3-compatible). On the next run, the agent loads the skill as a playbook and follows it instead of exploring from scratch. If the new run completes in fewer steps, the skill is replaced with the tighter version. If the existing skill holds up, it's validated. One domain, one skill, always improving.

## Built-in Skills

Learned behaviors for challenges the agent encounters in the wild:

| Skill | What it does |
|-------|-------------|
| `press-and-hold` | Detects and solves anti-bot overlays (press & hold, verify human) |
| `dismiss-popup` | Closes cookie banners, modals, overlays |
| `loop-detection` | Detects and breaks out of repeated action loops |
| `tab-manager` | Manages browser tabs opened during automation |

## Two ways to run

### Docker (full stack, like browserclaw.org)

Runs everything in containers: frontend, browser service (headless Chrome + VNC), MinIO, and Traefik. You interact through the web UI and watch the browser via a live VNC stream.

```bash
git clone https://github.com/idan-rubin/browserclaw.agent.git
cd browserclaw.agent
cp src/Services/Browser/.env.example src/Services/Browser/.env.local
# Edit .env.local with your API key
docker compose up
```

Open [localhost](http://localhost). This is the same setup that runs on [browserclaw.org](https://browserclaw.org).

### Local (dev mode, browser on your desktop)

Runs just the agent service. Chrome opens on your desktop so you can watch it work in real time without VNC. Faster iteration, no containers.

Requires: Node.js 22+, Chrome installed

```bash
cd src/Services/Browser
cp .env.example .env.local
```

```bash
npm install
npm run dev
```

## LLM Providers

Add at least one API key to `.env.local` and set `LLM_PROVIDER`:

| Provider | Env var | `LLM_PROVIDER` | Free tier |
|----------|---------|-----------------|-----------|
| Groq | `GROQ_API_KEY` | `groq` | Yes |
| Google Gemini | `GEMINI_API_KEY` | `gemini` | Yes |
| OpenAI | `OPENAI_API_KEY` | `openai` | No |
| OpenAI (ChatGPT subscription) | `OPENAI_OAUTH_TOKEN` | `openai-oauth` | No (subscription) |
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic` | No |

Optionally set `LLM_MODEL` to override the provider's default model.

For OpenAI OAuth, run `npx tsx scripts/openai-login.ts` to get your token.

## Read more

- [The Intelligence Gap](https://mrrubin.substack.com/p/the-knowledge-gap-why-ai-browser) — why AI browser agents keep failing, and what we're doing about it

## Built with

- [BrowserClaw](https://github.com/idan-rubin/browserclaw) — the engine
- [OpenClaw](https://github.com/openclaw/openclaw) — the community behind it
