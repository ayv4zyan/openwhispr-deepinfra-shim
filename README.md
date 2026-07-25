# OpenWhispr → DeepInfra Voxtral shim

Local middleware that lets [OpenWhispr](https://openwhispr.com) use **DeepInfra’s `mistralai/Voxtral-Mini-3B-2507`** for speech-to-text.

## Why this exists

OpenWhispr always uploads **WebM** audio. DeepInfra Voxtral returns HTTP 500 (`inference error`) on WebM. WAV/MP3 work.

This shim:

1. Speaks OpenAI’s `POST /audio/transcriptions` (what OpenWhispr expects)
2. Converts the recording to WAV with `ffmpeg`
3. Forwards to DeepInfra with your API token
4. Returns `{"text": "..."}`

```
You open "OpenWhispr + DeepInfra"
   → shim starts on localhost:8765
   → OpenWhispr opens
You quit OpenWhispr
   → shim stops
```

## Recommended stack

| Stage | Model | Via |
| --- | --- | --- |
| Speech-to-text | `mistralai/Voxtral-Mini-3B-2507` | This shim → DeepInfra |
| Dictation cleanup | `google/gemma-3-4b-it` | OpenWhispr → **this shim** → DeepInfra |

Both STT and cleanup go through the local shim so your DeepInfra token stays in this project’s `.env` (OpenWhispr drops plaintext secrets from its own `.env` on save).

**OpenWhispr cleanup settings (once):**

| Field | Value |
| --- | --- |
| Enable cleanup | on |
| Provider | Custom |
| Base URL | `http://localhost:8765` |
| Model | `google/gemma-3-4b-it` |
| API key | any non-empty value (e.g. `local-shim`) — the shim uses project `.env` |

OpenWhispr turns that base into `http://localhost:8765/v1/chat/completions`, which the shim proxies to DeepInfra.

## Lifecycle (no always-on daemon)

The shim does **not** run at login. It only runs while OpenWhispr is open, via a wrapper:

| Platform | Install | What you open day-to-day |
| --- | --- | --- |
| **macOS** | `./install-macos.sh` | `~/Applications/OpenWhispr + DeepInfra.app` |
| **Linux** | `./install-linux.sh` | App menu entry *OpenWhispr + DeepInfra* |
| **Either** | — | `./openwhispr-with-shim.sh` from a terminal |

Stock OpenWhispr (Dock / `/Applications`) does **not** start the shim. Use the launcher above (put it in the Dock instead of stock OpenWhispr).

### Why not LaunchAgent / systemd “always on”?

Easy to forget and leave a process running forever. Lifecycle binding is better: when you stop using OpenWhispr, nothing is left behind.

### Apple Shortcuts?

Possible (automations “When OpenWhispr opens/closes”), but fragile (permissions, “Run without asking”, and Shortcuts can miss close events). The wrapper script is the reliable cross-platform approach.

## Requirements

- **Node.js 18+** (zero npm dependencies)
- `ffmpeg` on `PATH` (`brew install ffmpeg` / distro package)
- DeepInfra API token: https://deepinfra.com/dash/api_keys
- OpenWhispr installed

## Setup

```bash
cd ~/Sync/Projects/openwhispr-deepinfra-shim   # or your clone path
cp .env.example .env
# edit .env → DEEPINFRA_TOKEN=...

# macOS
./install-macos.sh

# Linux
./install-linux.sh
```

### OpenWhispr settings (once)

**Settings → Speech-to-text → Custom endpoint / Self-hosted:**

| Field | Value |
| --- | --- |
| Server / base URL | `http://localhost:8765` |
| Model | `mistralai/Voxtral-Mini-3B-2507` |
| API key | optional (token is in this project’s `.env`) |

## Manual / debug

```bash
# Run shim alone (stays up until Ctrl+C)
npm start

# Full lifecycle from terminal
./openwhispr-with-shim.sh

# Logs
tail -f logs/launcher.log   # wrapper (Finder launches write here)
tail -f logs/shim.log       # Node STT server

# Uninstall launcher + any leftover LaunchAgent
./uninstall-macos.sh      # macOS
rm -f ~/.local/share/applications/openwhispr-deepinfra.desktop   # Linux
```

### “Nothing happens” when opening the launcher (macOS)

Finder apps get a minimal `PATH`, so Homebrew `node`/`ffmpeg` used to be invisible and the script exited with no window. The wrapper now:

- prepends `/opt/homebrew/bin` and `/usr/local/bin`
- shows a **macOS alert** on hard failures
- logs to `logs/launcher.log`

Re-run `./install-macos.sh` after updating, then open **OpenWhispr + DeepInfra** again.

## Security

- Listens on `127.0.0.1` only
- `.env` is gitignored — never commit tokens
- Token from: `DEEPINFRA_TOKEN` env → project `.env` → legacy `~/.openwhispr/deepinfra.env`

## License

MIT
