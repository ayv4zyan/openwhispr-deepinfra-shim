# OpenWhispr → DeepInfra Voxtral shim

Local middleware that lets [OpenWhispr](https://openwhispr.com) use **DeepInfra’s `mistralai/Voxtral-Small-24B-2507`** for speech-to-text.

## Why this exists

OpenWhispr always uploads **WebM** audio. DeepInfra Voxtral returns HTTP 500 (`inference error`) on WebM. WAV/MP3 work.

This shim:

1. Speaks OpenAI’s `POST /audio/transcriptions` (what OpenWhispr expects)
2. Converts the recording to WAV with `ffmpeg`
3. Forwards to DeepInfra with your API token
4. Returns `{"text": "..."}`

```
You speak → OpenWhispr (WebM) → localhost:8765 (this shim) → DeepInfra Voxtral → text
```

## Requirements

- macOS (LaunchAgent install script is macOS-only; the Python server works anywhere)
- Python 3.9+
- `ffmpeg` on `PATH` (`brew install ffmpeg`)
- DeepInfra API token: https://deepinfra.com/dash/api_keys

## Setup

```bash
cd ~/Sync/Projects/openwhispr-deepinfra-shim   # or your clone path
cp .env.example .env
# edit .env and set DEEPINFRA_TOKEN=...

./install-macos.sh
```

### OpenWhispr settings

**Settings → Speech-to-text → Custom endpoint / Self-hosted:**

| Field | Value |
| --- | --- |
| Server / base URL | `http://localhost:8765` |
| Model | `mistralai/Voxtral-Small-24B-2507` |
| API key | optional (token lives in this project’s `.env`) |

You do **not** point OpenWhispr at this folder path. OpenWhispr only needs the **HTTP URL** of the running shim.

## Run without LaunchAgent

```bash
python3 deepinfra-voxtral-shim.py
```

## Ops

```bash
# Status
lsof -nP -iTCP:8765 -sTCP:LISTEN
launchctl print "gui/$(id -u)/com.openwhispr.deepinfra-voxtral-shim" | head

# Logs
tail -f logs/shim.log

# Reinstall after moving the repo
./install-macos.sh

# Stop / uninstall
./uninstall-macos.sh
```

## Security

- Listens on `127.0.0.1` only (not exposed to the network)
- `.env` is gitignored — never commit tokens
- Token is read from, in order: `DEEPINFRA_TOKEN` env, project `.env`, then legacy `~/.openwhispr/deepinfra.env`

## License

MIT
