<p align="center">
<a>
<img alt="Vision Logo" src="client/assets/logo/Vision.png" width="132">
</a>
</p>

<p align="center">
<a href="https://discord.com/users/thearijiiiitttt_"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
<a href="#-setup"><img alt="Node" src="https://img.shields.io/badge/node-18%2B-339933?style=flat-square&logo=node.js&logoColor=white" /></a>
<a href="#-setup"><img alt="Bun" src="https://img.shields.io/badge/bun-supported-f9f1e1?style=flat-square&logo=bun&logoColor=black" /></a>
</p>

<p align="center">
<b>Vision's Auto Simulation</b>: A voice driven conversational front end for Vision's 3D robot rig
</p>

> **Note:** This package is the **live loop** sibling of the Vision Script compiler. There is no compiler and no fixed program, you talk (or type), an LLM replies, and Vision moves + speaks in real time. Commands from the model are always validated against a fixed safelist before they ever reach the 3D rig.

---

## Table of Contents
1. [What it does](#-what-it-does)
2. [Setup](#-setup)
3. [Run the Simulation](#-run-the-simulation)
4. [Try it](#-try-it)
5. [Notes & Technical Details](#-notes--technical-details)

<br/>

## What it does

- **Mic-first interface** — no persistent chat log. What you say and what Vision replies appear as a caption over the 3D view, then fade.
- **Wake-word fast path** — short phrases like *"Vision, dance"* are matched on the server with a regex and never touch the LLM.
- **Everything else goes to your configured LLM** — the model may embed tags like `[[CMD:DANCE 2500]]`; the server strips, validates, and clamps them before the rig runs them.
- **Speaks and moves at the same time** — browser TTS while the command sequence plays on the robot.

<br/>

## Setup

```bash
# Install dependencies
npm install

# or: bun install

# Configure the LLM
cp .env.example .env # For WSL or Linux
copy .env.example .env # For Windows
```

Edit `.env`:

```env
LLM_PROVIDER=openai
LLM_API_KEY=sk-or-v1-your-key
LLM_API_URL=https://openrouter.ai/api/v1/chat/completions
LLM_MODEL=openrouter/free
```

| Variable        | Description |
|-----------------|-------------|
| `LLM_PROVIDER`  | `openai` (OpenAI-compatible) or `anthropic` |
| `LLM_API_KEY`   | Your API key |
| `LLM_API_URL`   | Optional override (OpenRouter, Ollama, LM Studio, etc.) |
| `LLM_MODEL`     | Model id (e.g. `openrouter/free`, `gpt-4o-mini`) |

You can skip the key entirely: wake-word commands still work, and open-ended questions get a friendly “no brain plugged in yet” reply.

<br/>

## Run the Simulation

```bash
npm start
# or: bun start
```

Then open **http://localhost:8787** in **Chrome or Edge** (best Web Speech API support).

> ⚠️ **Important:** Do **not** open `client/index.html` as a file. Every fetch (`/api/chat`, `/api/health`, the `.obj` model) uses an absolute path that only resolves against the Node server. Opened as `file://`, the model won’t load and the app shows a banner telling you so.

| Operating System | Open in browser              |
| :--------------- | :--------------------------- |
| **macOS**        | `open http://localhost:8787` |
| **Linux**        | `xdg-open http://localhost:8787` |
| **Windows**      | `start http://localhost:8787` |

Optional scripts:

```bash
npm run dev          # auto-restart on save
npm run build        # type-check + compile server to dist/
npm run start:built  # run the compiled dist/ build
```

<br/>

## Try it

| You say | What happens |
| :------ | :----------- |
| *"Vision, dance"* | Instant reaction — no LLM call |
| *"Vision, turn left"* / *"turn right"* | Body turns on the rig |
| *"Vision, walk forward"* | Walking bob animation |
| *"Vision, emergency stop"* | Immediate stop |
| *"What's your favorite color?"* | Goes to the LLM; may embed movement tags in the reply |
| *"Can you wave hello?"* | LLM reply + optional gestures |

There’s also a keyboard icon (bottom-right) for typed input if speech recognition isn’t available.

<br/>


## Music (play a song)

Say or type any of:

| You say | What happens |
| :------ | :----------- |
| *"play never gonna give you up"* | Searches YouTube, downloads MP3, plays it |
| *"Vision, play despacito"* | Same, with wake word |
| *"play shape of you and dance"* | Plays the song **and** starts the dance animation |
| *"stop"* / *"Vision, stop"* | Stops music + movement |

Requirements on the machine running the server:

- `yt-dlp` on `PATH` (or set `YT_DLP_PATH`)
- `ffmpeg` / `ffprobe` (or set `FFMPEG_PATH` to their directory)

Downloaded files are cached under `downloads/` and served at `/downloads/...`.

If YouTube returns 403 from your network, update yt-dlp (`yt-dlp -U`) or pass cookies via yt-dlp config.


## Notes & Technical Details

* **Safety first:** Nothing from the LLM (or a spoken phrase) reaches the animation layer without passing through a fixed safelist and numeric clamps. See `server/src/commands.ts` for wake-word patterns and `extractCommands()` validation. Only names in `COMMAND_TYPES` (`server/src/types.ts`) are recognized.
* **Command tags:** The model may embed `[[CMD:NAME]]`, `[[CMD:NAME arg]]`, or `[[WAIT:ms]]` in its reply. Tags are stripped before speech; only validated instructions are sent to the browser.
* **Eye parameters:** `EYE_SET` takes an absolute angle `0–180` (`90` = center). `EYE_LEFT` / `EYE_RIGHT` take an optional relative step (default `15°`).
* **Durational moves:** `TURN_*`, `WALK_*`, and `DANCE` accept a duration in ms (clamped). Defaults live in `client/js/client.js`.
* **Visual approximation:** This is a browser demo, not a hardware controller. Animations are expressive, not physically accurate.
* **LLM errors:** Failures (timeout, 429, bad model id, etc.) are logged in the server terminal as `[LLM]` / `[chat]` lines and shown to the user as a spoken/caption fallback reply.
* **Providers:** Point `LLM_API_URL` at any OpenAI-compatible server (OpenRouter, Ollama, LM Studio, vLLM, etc.), or set `LLM_PROVIDER=anthropic` for Anthropic’s Messages API.

<br/>

