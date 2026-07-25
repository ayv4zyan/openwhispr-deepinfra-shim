#!/usr/bin/env python3
"""OpenWhispr → DeepInfra Voxtral Small bridge.

OpenWhispr records WebM/Opus. DeepInfra Voxtral returns HTTP 500 on WebM.
This shim accepts OpenAI-compatible POST /audio/transcriptions, converts the
audio to WAV with ffmpeg, and forwards it to DeepInfra.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("SHIM_PORT", "8765"))
MAX_BODY_BYTES = 25 * 1024 * 1024
DEFAULT_MODEL = os.environ.get(
    "DEEPINFRA_MODEL", "mistralai/Voxtral-Small-24B-2507"
)
UPSTREAM = "https://api.deepinfra.com/v1/openai/audio/transcriptions"


def _parse_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        out[key.strip()] = value.strip().strip('"').strip("'")
    return out


def load_token() -> str:
    token = os.environ.get("DEEPINFRA_TOKEN", "").strip()
    if token:
        return token

    # Prefer project .env (this repo), then legacy ~/.openwhispr path
    for path in (ROOT / ".env", Path.home() / ".openwhispr" / "deepinfra.env"):
        token = _parse_env_file(path).get("DEEPINFRA_TOKEN", "").strip()
        if token:
            return token

    raise SystemExit(
        "DEEPINFRA_TOKEN not set. Copy .env.example to .env and add your token."
    )


TOKEN = load_token()


def parse_multipart_form(body: bytes, content_type: str):
    m = re.search(r'boundary="?([^";]+)"?', content_type)
    if not m:
        raise ValueError("missing multipart boundary")
    delim = b"--" + m.group(1).strip().encode()
    fields: dict[str, str] = {}
    files: dict[str, tuple[str, bytes]] = {}
    for chunk in body.split(delim):
        if not chunk or chunk.startswith(b"--"):
            continue
        if chunk.startswith(b"\r\n"):
            chunk = chunk[2:]
        if chunk.endswith(b"\r\n"):
            chunk = chunk[:-2]
        if b"\r\n\r\n" not in chunk:
            continue
        raw_headers, content = chunk.split(b"\r\n\r\n", 1)
        disposition = ""
        for line in raw_headers.decode("utf-8", "replace").split("\r\n"):
            if line.lower().startswith("content-disposition:"):
                disposition = line
        name_match = re.search(r'name="([^"]*)"', disposition)
        if not name_match:
            continue
        name = name_match.group(1)
        file_match = re.search(r'filename="([^"]*)"', disposition)
        if file_match is not None:
            files[name] = (file_match.group(1), content)
        else:
            fields[name] = content.decode("utf-8", "replace")
    return fields, files


def convert_to_wav(input_path: str) -> str:
    fd, out_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        subprocess.run(
            [
                "ffmpeg", "-y", "-i", input_path,
                "-ar", "16000", "-ac", "1", "-f", "wav", out_path,
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        try:
            os.remove(out_path)
        except OSError:
            pass
        raise
    return out_path


def deepinfra_transcribe(
    wav_path: str, model: str, language: str | None, prompt: str | None
) -> str:
    boundary = "----OpenWhisprDeepInfraShim"
    with open(wav_path, "rb") as f:
        audio = f.read()

    def part(
        name: str,
        value: bytes,
        filename: str | None = None,
        ctype: str | None = None,
    ) -> bytes:
        disp = f'Content-Disposition: form-data; name="{name}"'
        if filename is not None:
            disp += f'; filename="{filename}"'
        headers = [disp]
        if ctype:
            headers.append(f"Content-Type: {ctype}")
        return (
            f"--{boundary}\r\n".encode()
            + "\r\n".join(headers).encode()
            + b"\r\n\r\n"
            + value
            + b"\r\n"
        )

    body = b"".join(
        [
            part("file", audio, "audio.wav", "audio/wav"),
            part("model", (model or DEFAULT_MODEL).encode()),
            *([part("language", language.encode())] if language else []),
            *([part("prompt", prompt.encode())] if prompt else []),
            f"--{boundary}--\r\n".encode(),
        ]
    )
    req = urllib.request.Request(
        UPSTREAM,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        raise RuntimeError(f"DeepInfra HTTP {e.code}: {detail}") from e
    return data.get("text") or ""


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers", "Authorization, Content-Type"
        )
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") not in (
            "/audio/transcriptions",
            "/v1/audio/transcriptions",
        ):
            self._send_json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(400, {"error": "invalid Content-Length"})
            return
        if length <= 0:
            self._send_json(400, {"error": "empty body"})
            return
        if length > MAX_BODY_BYTES:
            self._send_json(413, {"error": "request body too large"})
            return

        body = self.rfile.read(length)
        content_type = self.headers.get("Content-Type", "")
        try:
            fields, files = parse_multipart_form(body, content_type)
        except ValueError as exc:
            self._send_json(400, {"error": f"bad multipart: {exc}"})
            return
        if "file" not in files:
            self._send_json(400, {"error": "missing 'file' field"})
            return

        filename, file_bytes = files["file"]
        model = fields.get("model") or DEFAULT_MODEL
        language = fields.get("language") or None
        prompt = fields.get("prompt") or None
        if language in ("", "auto"):
            language = None

        suffix = os.path.splitext(filename)[1] or ".webm"
        fd, in_path = tempfile.mkstemp(suffix=suffix)
        wav_path = None
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(file_bytes)
            wav_path = convert_to_wav(in_path)
            text = deepinfra_transcribe(wav_path, model, language, prompt)
            self._send_json(200, {"text": text, "object": "transcription"})
        except FileNotFoundError:
            self._send_json(500, {"error": "ffmpeg not found on PATH"})
        except subprocess.CalledProcessError:
            self._send_json(500, {"error": "ffmpeg failed to transcode audio"})
        except Exception as exc:
            self._send_json(500, {"error": f"transcription failed: {exc}"})
        finally:
            for path in (in_path, wav_path):
                if path and os.path.exists(path):
                    os.remove(path)

    def log_message(self, fmt: str, *args) -> None:
        print(f"[shim] {self.address_string()} - {fmt % args}")


def main() -> None:
    try:
        subprocess.run(
            ["ffmpeg", "-version"],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        raise SystemExit("ffmpeg is required (e.g. brew install ffmpeg)")

    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    print(f"DeepInfra Voxtral shim on http://127.0.0.1:{PORT}")
    print(f"Default model: {DEFAULT_MODEL}")
    print(f"Project root: {ROOT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
