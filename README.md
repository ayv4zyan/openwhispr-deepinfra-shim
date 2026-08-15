# OpenWhispr → DeepInfra shim

Local middleware so [OpenWhispr](https://openwhispr.com) can use DeepInfra for:

| Stage | Model | Path |
| --- | --- | --- |
| Speech-to-text | `mistralai/Voxtral-Mini-3B-2507` | OpenWhispr → **this shim** → DeepInfra |
| Dictation cleanup | `google/gemma-4-E4B-it` | OpenWhispr → **this shim** → DeepInfra |

OpenWhispr records **WebM**; DeepInfra Voxtral returns HTTP 500 on WebM. The shim converts to WAV, trims **leading/trailing silence** (not mid-phrase pauses), and holds your API token so OpenWhispr does not need to store it long-term.

### Cleanup prompt

By default the shim **replaces** OpenWhispr’s long system prompt with `cleanup-prompt-short.txt` (`CLEANUP_PROMPT_MODE=short`). Set `CLEANUP_PROMPT_MODE=stock` to pass through OpenWhispr’s prompt unchanged.

Optional stock-vs-short A/B bench exists in code but is **off** (`CLEANUP_BENCH=0`).

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

## Linux (Arch / KDE Plasma 6 — this machine)

Replay path after a reinstall or a new clone. Three things are **not** in git:

1. **OpenWhispr** (`openwhispr` on PATH, typically `/opt/openwhispr` from `openwhispr-bin`)
2. **Node.js 18+** and **ffmpeg** (nvm Node is fine; launcher prepends `~/.local/share/nvm/v*/bin`)
3. **DeepInfra token** — https://deepinfra.com/dash/api_keys

### Token

```bash
cp .env.example .env
chmod 600 .env
# edit .env → DEEPINFRA_TOKEN=...
```

| File | What |
| --- | --- |
| **This project `.env`** | `DEEPINFRA_TOKEN` — the real key. Never commit. |
| `~/.openwhispr/deepinfra.env` | Optional second place the shim also reads. |
| `~/.config/open-whispr/.env` | OpenWhispr’s own file. Apply script writes `CUSTOM_CLEANUP_API_KEY=local-shim` only. |

Day-to-day you only edit **this project `.env`**.

### Shim + OpenWhispr settings

```bash
./install-linux.sh
# First time only: launch stock OpenWhispr once, quit fully, then:
./apply-openwhispr-settings.sh
```

Day-to-day: open **OpenWhispr + DeepInfra** from the app menu (or `./openwhispr-with-shim.sh`). Do **not** use stock OpenWhispr — that skips the shim (`localhost:8765` connection refused).

If OpenWhispr is already open without the shim: `./start-shim.sh`.

### Wayland auto-paste (ydotool)

OpenWhispr on Wayland pastes via **ydotool**. Until this is done it shows “Wayland Paste Setup”.

```bash
./install-linux-ydotool.sh   # pacman ydotool, input group, udev, user service
```

Then **log out and back in** so `groups` includes `input` (the app checks that, not `/etc/group`). Restart OpenWhispr + DeepInfra.

Manual equivalent (Arch):

```bash
sudo pacman -S --needed ydotool
sudo usermod -aG input "$USER"
# package already ships /usr/lib/udev/rules.d/80-uinput.rules
systemctl --user enable --now ydotool.service
```

### Caps Lock = start/stop dictation (KDE only)

OpenWhispr’s KDE backend **cannot** register `CapsLock` (no Qt key in `kdeShortcut.js`). The launcher installs a Plasma helper and **binds Caps Lock only while OpenWhispr is running**:

```
Open "OpenWhispr + DeepInfra"
  → shim starts
  → Caps Lock → dictate
  → OpenWhispr opens
Quit OpenWhispr
  → Caps Lock released
  → shim stops
```

```bash
./install-linux-capslock.sh   # once: install helper, leave Caps Lock free
```

| Path | Role |
| --- | --- |
| `scripts/kde-caps-dictate.sh` | `on` / `off` — live KGlobalAccel grab |
| `scripts/toggle-openwhispr-dictation.sh` | `qdbus6` → OpenWhispr `dictation` action |
| `~/.local/share/applications/openwhispr-caps-dictate.desktop` | Hidden helper app |

Tap **Caps Lock** to start dictation, tap again to stop. Stock OpenWhispr does **not** bind Caps Lock or start the shim.

The Caps Lock LED / case-lock may still toggle while the session is open. OpenWhispr **Settings** may still show `Ctrl+Super` — leave it.

---

## Project layout

| Path | Purpose |
| --- | --- |
| `deepinfra-voxtral-shim.js` | STT + chat/completions proxy |
| `openwhispr-with-shim.sh` | Start shim → OpenWhispr → stop shim |
| `setup-macos.sh` | **New machine** one-shot |
| `install-macos.sh` / `install-linux.sh` | Launcher only |
| `install-linux-ydotool.sh` | Wayland paste: ydotool + `input` group + user service |
| `install-linux-capslock.sh` | KDE helper only (Caps Lock stays free until launch) |
| `scripts/kde-caps-dictate.sh` | Bind/release Caps Lock with the OpenWhispr session |
| `scripts/toggle-openwhispr-dictation.sh` | Invokes OpenWhispr’s KDE `dictation` action |
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
| **`~/Applications/OpenWhispr + DeepInfra.app`** | Generated macOS launcher | no |
| **`~/.local/share/applications/openwhispr-deepinfra.desktop`** | Linux launcher | no (from `install-linux.sh`) |
| **`~/.local/share/applications/openwhispr-caps-dictate.desktop`** | Caps Lock binding | no (from `install-linux-capslock.sh`) |
| **OpenWhispr userData** (`~/.config/open-whispr`) | App settings, notes, DB | no (app-owned) |

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
