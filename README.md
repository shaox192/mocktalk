# MockTalk: Real-time AI-powered presentation practice app without real-time models <img src="frontend/src/app/favicon-96x96.png" width="35"> 


This is a web app for practicing academic presentations with an AI advisor that: watches your slides, listens in real time, then interrupts you mid-sentence, just like a PhD advisor would. Except this one has infinite patience and is available at 2 AM.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Deploy](https://img.shields.io/badge/Try_it_live-MockTalk-blue)](<!-- TODO: your Render URL -->)

<!-- TODO: add a demo gif/screenshot here -->
<!-- ![MockTalk Demo](assets/demo.gif) -->

## The motivation

As a PhD student and now a postdoc, I've given millions of talks over the past few years. It's one thing to make the slides or plan a narrative, but another to say it out loud and find out in real time that it doesn't make sense. I've been fortunate to have very supportive advisors who make themselves available as much as possible, but it's obviously unrealistic to have them on standby 24/7 for the 5 rough slides I just threw together.

MockTalk gives you an AI advisor with infinite patience. Share your screen with even half-done slides, start talking, and it will interrupt you to tell you your figure is unreadable or that what you just said makes zero sense (just like the real thing). When you finish, it grills you with questions about your contribution, your methodology, whatever it thinks was weak.

I've actually been using a crude version for my own talks for a while. But now with the help of AI coding tools, I could improve the frontend enough to deploy it as a full-stack web app and share it with fellow trainees who might find it useful.

> **Backstory blog:** If you are interested, here is a [blog](<!-- TODO: link to blog post -->) on why and how I built MockTalk, and my experience with AI coding as an academic researcher.

## What this is (and isn't)

Real-time voice AI exists (Gemini Live, OpenAI Realtime API), but it's expensive and overkill for this. Slide-making tools and public speaking coaches are also out there, but that's a different problem. There's been HCI work on how to get optimal AI feedback on presentations that entails multi-modal data. However, what I'm going for isn't always the *best* feedback — it's the most *realistic experience*.

MockTalk creates a **real-time _feeling_** using regular turn-taking models and some infrastructure work:

- The browser captures your screen and microphone and streams frames + audio (with client-side VAD) to the backend over WebSocket
- The backend transcribes your speech, detects slide changes, and periodically asks the LLMs something like: _"Given everything so far, the slides, the transcript, the flow etc., should you interrupt?"_
- If the LLM says yes, the interruption streams back to the browser to simulate a raised hand from the advisor. If not, it stays quiet and lets you keep talking

The result: a rehearsal that feels live, powered by models that cost pennies per session. A 15-minute run-through of my VSS talk with GPT-4o + OpenAI Whisper cost so little I barely noticed it on my balance. Important when you're on a phd stipend/postdoc salary that requires penny-level budgeting, as we all know (kidding... mostly).

> **CAVEAT:** I want to emphasize that the contribution of this tool is the real-time experience, i.e., the interruptions that force you to think deeply about what you just said, the discussion dynamics, the flow. The quality of the AI's actual feedback depends entirely on which model you use (see my notes below) and the prompts.

### Architecture

Here's a visual summary for anyone interested or with potential ideas on improving latency (tried my best with ascii diagrams):

```
┌──────────────────────────────────────┐
│  Browser (Next.js)                   │
│  ├── Screen capture (getDisplayMedia)│
│  ├── Microphone + VAD                │
│  └── Feedback sidebar  ◄─────────┐   │
└──────────┬───────────────────────│───┘
           │ frames + audio        │ interruptions
           │ (WebSocket)           │
           ▼                       │
┌──────────────────────────────────┤
│  FastAPI Backend                 │
│  ├── PresentSession (orchestrator)
│  │   ├── Slide detection (OpenCV frame diff)
│  │   ├── Transcription (Whisper via Groq/OpenAI)
│  │   ├── Eval loop (LLM) ───► interrupt / stay quiet
│  │   └── Turn-taking state machine
│  │
│  ├──► Groq / OpenAI ········ transcription
│  └──► OpenAI / Anthropic / Google ·· AI advisor
└──────────────────────────────────┘
```

### On the AI models

The quality of feedback depends entirely on your model choice. BTW, multi-modal capability also matters a lot. Some models don't really *see* the slides well. Here's my experience:

- **GPT-4o** — this is the floor. Anything below this can't even follow the instructions. But 4o's comments tend to be general, broad-picture questions like _"Why is the alignment between humans and AI models important?"_. Actually similar to the kind you occasionally get from someone who knows little about your field. I actually use this a lot in later stages of prep because it's cheap, keeps the flow going, and prompts me to think about those general audience questions.
- **GPT-5.2 / 5.4** — this is noticeably better. Asks specific questions, engages with your actual content. Worth the cost if you have budget.
- **Gemini family** — For these, I keep getting "model overloaded" errors from the API :(, so I haven't tested extensively. The few times I did get through, gemini 3.1 pro does feel like it had the best multi-modal capabilities, like it genuinely *sees* the slides. Maybe upgrading the API tier would help, but you'll have to find out.
- **Claude family** — my favorites for early-stage prep when I need specific, technical pushbacks. Great feedback, but expensive, so budget wisely.

On transcription: OpenAI Whisper-1 and Groq are both very cheap. If you don't want to pay at all, host this whole app locally and choose the "Local" option to run Whisper on your own machine for free. I'm on an ancient M1 Mac and the speed of the small model feels fine.

### On the prompts

Beyond the model, the prompt matters a lot. There's a text box on the landing page to give context about your presentation, which helps. But if you want to tune the advisor's personality, say, to become more supportive instead of the current harsh-by-default setup (I like blunt feedback), then you can edit the prompt files in [`/backend/prompts/`](/backend/prompts/). Just make sure you keep the output format constraints intact, or check the response processor in the code if you need to change those. More details on prompt files are listed below.


## Try it

### Online (no install)

**[https://mocktalk.onrender.com](<!-- TODO: Render URL -->)**

Just bring your API keys. I host this on Render's free tier (I might upgrade if people are actually interested), so the service sleeps after inactivity, and the first load takes ~30–50 seconds and you'll actually see the Render information page as well as the "waking-up" process. Be patient.

> **On API key safety:** This is BYOK app. You provide your own keys and the app calls the APIs directly. There is no intermediate relays and thus no platform fee. Keys are held in React state (in-memory JavaScript variables, not browser storage), so they vanish the moment you reload or close the tab. Nothing is stored anywhere. The connection between frontend and backend is encrypted. You can verify all of this yourself in the source, or ask your clawbot to check this. If you're still concerned, install this locally.

As for browser compatibility: chrome and firefox both work well. I've done some testing with safari, but not thoroughly, so just let me know if there are issues.

BTW, you can also explore without API keys: leave everything as is and MockTalk will run in **fake session mode** with randomly generated interruptions so you can poke around the UI first.

### Local install

Needs Node.js 20+, Python 3.12+.

```bash
# Clone
git clone https://github.com/shaox192/mocktalk.git
cd mocktalk

# Backend
cd backend
python3 -m venv venv_mocktalk
source venv_mocktalk/bin/activate
pip install -r requirements-local.txt
cd ..

# Frontend
cd frontend
npm install
cd ..

# Run (two terminals)
cd backend && uvicorn server:app --reload --host 0.0.0.0 --port 8000
cd frontend && npm run dev
```

This app then opens at `http://localhost:3000`.

> `requirements-local.txt` includes [`faster-whisper`](https://github.com/SYSTRAN/faster-whisper) for local CPU transcription. The cloud deployment uses `requirements.txt` which skips it since transcription goes through APIs. Use either depending on your setup.

### How a session works

Everything on-screen should be straightforward (I've added info buttons throughout), but here's a preview:

1. **Landing page** — Pick your AI model, transcriber, and enter API keys. Optionally describe your talk for better context, and explore additional settings.
2. **A/V check** — Verify screen share and mic are working.
3. **Present** — Click "Start Presentation" to share your slides. Once the advisor joins, start talking. The app transcribes, watches for slide changes, and periodically sends everything to the AI for evaluation.
4. **Interruptions** — When the advisor has something to say, it appears on the sidebar. Respond by voice (record like a voice message) or text. This conversation could go for multiple rounds until the advisor is satisfied to let you continue. You can also close a thread if the question doesn't make sense.
5. **Discussion** — Click "Stop Presentation" when you're done. A post-talk Q&A opens immediately. Click "Close Discussion" to end the session.

> **TIP:** MockTalk works best with an external monitor — slides on one screen, feedback panel on the other, like presenting with a projector. Single-screen works but involves annoying window-switching.

### Customizing prompts

All system prompts live in [`backend/prompts/`](backend/prompts/):

| File | When does it fire | What does this do |
|------|---------------|-------------|
| `prompt_mid_pre.txt` | Periodically during the talk | Evaluates delivery, decides whether to interrupt |
| `prompt_qa.txt` | After an interruption | Evaluates your response to a question |
| `prompt_discussion_beginning.txt` | Post-talk | Opens the discussion |
| `prompt_discussion_middle.txt` | Post-talk | Handles follow-up exchanges |

Edit these to change personality, focus, or strictness when hosting locally. Keep the output format constraints intact. If you need to change those, check the response processor in the code to make sure everything still parses correctly.

### Adding models

Edit [`frontend/src/app/models.ts`](frontend/src/app/models.ts). The UI dropdowns and backend routing derive from this file. Also double-check that the backend handles the new model or provider correctly.


## A few more details under the hood

A few engineering decisions worth noting:

- **Client-side VAD** (`@ricky0123/vad-web` with ONNX Runtime WASM) — speech detection runs in the browser so only actual speech segments are sent to the backend, not a continuous audio stream.
- **WebSocket instead of REST** — a single persistent connection handles frames, audio, and feedback, keeping latency low. This is also why I can't deploy on Vercel (no persistent WebSocket support) and use Render instead.
- **Pixel-level frame differencing for slide detection** — rather than OCR or embedding-based comparison, simple OpenCV frame differencing is fast enough to detect slide transitions in real time. One note: I currently only send the latest frame per evaluation cycle, which works well for static slides but might miss things if your slides have a lot of animations. I may add multi-frame support in the future.

Built with Next.js 16 + React 19 (frontend), FastAPI + Uvicorn (backend), Tailwind CSS 4 (styling), deployed on Render.

## Roadmap

- [ ] **Screen compatibility** — Better single-screen handling.
- [ ] **Labmate agents** — Right now it's just you and your advisor and let's just pretend the labmates have fallen asleep. I want to explore adding multiple personas (a methods person, a big-picture thinker, a skeptic) for a simulated lab meeting where everyone's actually awake (Ha!).

## Acknowledgement

The frontend UI was built in close collaboration with [Claude Code](https://docs.anthropic.com/en/docs/claude-code),
using the [ui-ux-pro-max](https://github.com/anthropics/claude-code-skills) skill for design and implementation.


## License

MIT — see [LICENSE](LICENSE).