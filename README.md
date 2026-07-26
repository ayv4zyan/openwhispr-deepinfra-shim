# OpenWhispr → DeepInfra shim

Local middleware so [OpenWhispr](https://openwhispr.com) can use DeepInfra for:

| Stage | Model | Path |
| --- | --- | --- |
| Speech-to-text | `mistralai/Voxtral-Mini-3B-2507` | OpenWhispr → **this shim** → DeepInfra |
| Dictation cleanup | `google/gemma-4-E4B-it` | OpenWhispr → **this shim** → DeepInfra |

OpenWhispr records **WebM**; DeepInfra Voxtral returns HTTP 500 on WebM. The shim converts to WAV, trims **leading/trailing silence** (not mid-phrase pauses), and holds your API token so OpenWhispr does not need to store it long-term.

### Cleanup prompt

By default the shim **replaces** OpenWhispr’s long system prompt with `cleanup-prompt-short.txt` (`CLEANUP_PROMPT_MODE=short`). Options: `short` | `minimal` | `stock` (passthrough).

Optional A/B bench (code kept; off by default):

```bash
CLEANUP_BENCH=1
CLEANUP_BENCH_RETURN=stock   # or short
```

Logs to `logs/cleanup-bench.jsonl`. Doubles cleanup API cost while on.

```
Open "OpenWhispr + DeepInfra"
  → shim starts on 127.0.0.1:8765
  → OpenWhispr opens
Quit OpenWhispr
  → shim stops
```

---

## New Mac setup (clone → working)

**You still need three things that are not (and cannot be) inside git:**

1. **OpenWhispr** installed (`/Applications/OpenWhispr.app`)
2. **Node.js 18+** and **ffmpeg** (`brew install node ffmpeg`)
3. A **DeepInfra API token** (https://deepinfra.com/dash/api_keys) — put in `.env`, never commit

Everything else is in this repo.

```bash
git clone https://github.com/ayv4zyan/openwhispr-deepinfra-shim.git
cd openwhispr-deepinfra-shim

# 1) Token (first run creates .env and exits if token missing)
cp .env.example .env
# edit .env → DEEPINFRA_TOKEN=...

# 2) One command: launcher + OpenWhispr settings (when possible)
./setup-macos.sh
```

If OpenWhispr was **never** launched on that Mac, `setup-macos.sh` installs the launcher then tells you to:

1. Open stock OpenWhispr once (create userData / localStorage)
2. Quit OpenWhispr
3. Run `./apply-openwhispr-settings.sh`
4. Day-to-day: open **OpenWhispr + DeepInfra** (not stock OpenWhispr)

### What `setup-macos.sh` does

| Step | Action |
| --- | --- |
| Checks | `node`, `ffmpeg`, OpenWhispr.app, `.env` token |
| `./install-macos.sh` | Builds `~/Applications/OpenWhispr + DeepInfra.app` |
| `./apply-openwhispr-settings.sh` | Writes STT + cleanup into OpenWhispr localStorage from `openwhispr-settings.json` |

### Manual OpenWhispr UI (if apply script fails)

**Speech-to-text**

| Field | Value |
| --- | --- |
| Mode | Custom / self-hosted / BYOK |
| Base URL | `http://localhost:8765` |
| Model | `mistralai/Voxtral-Mini-3B-2507` |
| API key | optional |

**Cleanup (Language models)**

| Field | Value |
| --- | --- |
| Enable cleanup | on |
| Provider | Custom |
| Base URL | `http://localhost:8765` |
| Model | `google/gemma-4-E4B-it` |
| API key | `local-shim` (any non-empty; real token is project `.env`) |

---

## Linux

```bash
cp .env.example .env   # set DEEPINFRA_TOKEN
./install-linux.sh
# Launch OpenWhispr once, quit, then:
./apply-openwhispr-settings.sh
```

Open **OpenWhispr + DeepInfra** from the app menu (or `./openwhispr-with-shim.sh`).

---

## Project layout

| Path | Purpose |
| --- | --- |
| `deepinfra-voxtral-shim.js` | STT + chat/completions proxy |
| `openwhispr-with-shim.sh` | Start shim → OpenWhispr → stop shim |
| `setup-macos.sh` | **New machine** one-shot |
| `install-macos.sh` / `install-linux.sh` | Launcher only |
| `apply-openwhispr-settings.sh` | Write OpenWhispr settings from JSON |
| `openwhispr-settings.json` | Settings recipe (in git) |
| `.env.example` | Token template (in git) |
| `.env` | Your token (**not** in git) |

---

## What lives where

| Location | What | In git? |
| --- | --- | --- |
| **This project** | Code, installers, settings JSON | yes |
| **This project `.env`** | `DEEPINFRA_TOKEN` | **no** |
| **`~/Applications/OpenWhispr + DeepInfra.app`** | Generated launcher | no |
| **OpenWhispr userData** | App settings, notes, DB | no (app-owned) |

OpenWhispr always stores UI settings under its own userData. The repo keeps a **recipe** (`openwhispr-settings.json`) and applies it; it cannot ship your live OpenWhispr database.

---


### Transcription error / connection refused

OpenWhispr is configured for `http://localhost:8765`. If the **shim is not running**, STT fails.

Common causes:

1. Opened **stock** OpenWhispr instead of **OpenWhispr + DeepInfra**
2. Something killed the shim while OpenWhispr stayed open (e.g. an old install script freeing port 8765)

**Fix while OpenWhispr is already open:**

```bash
./start-shim.sh
```

Then dictate again. Or quit OpenWhispr and reopen via **OpenWhispr + DeepInfra**.

## Debug

```bash
npm start                          # shim only
./openwhispr-with-shim.sh          # full lifecycle in terminal
tail -f logs/launcher.log
tail -f logs/shim.log
curl -s http://127.0.0.1:8765/health
./uninstall-macos.sh               # remove launcher + old LaunchAgent
```

### “Nothing happens” when opening the launcher

Finder apps get a tiny `PATH`. The wrapper prepends Homebrew paths and logs to `logs/launcher.log`. Re-run `./install-macos.sh` after moving the clone.

---

## Security

- Shim binds `127.0.0.1` only
- Never commit `.env`
- Token load order: `DEEPINFRA_TOKEN` env → project `.env`

## License

MIT
