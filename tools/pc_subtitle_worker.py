#!/usr/bin/env python3
"""
Worker de subtítulos de referencia (Whisper) para MusicaPrivada.

Protocolo (AUTH-06):
  GET  /api/subtitles/worker/queue            -> {"job": {"id", "downloadUrl", "uploadUrl", ...} | null}
  GET  <downloadUrl>                          -> audio
  POST <uploadUrl>  (cuerpo: texto WebVTT)    -> {"success": true}
Todas las peticiones llevan la cabecera  X-Worker-Token: <SUBTITLE_WORKER_TOKEN>.

Uso:
  pip install openai-whisper requests
  set MP_SERVER=https://tu-servidor   (o export en Linux/macOS)
  set MP_WORKER_TOKEN=<token del .env del servidor>
  python pc_subtitle_worker.py
"""
import os
import sys
import time
import tempfile

import requests

SERVER = os.environ.get("MP_SERVER", "http://127.0.0.1:3001").rstrip("/")
TOKEN = os.environ.get("MP_WORKER_TOKEN", "")
MODEL_NAME = os.environ.get("MP_WHISPER_MODEL", "small")
POLL_SECONDS = int(os.environ.get("MP_POLL_SECONDS", "15"))

if not TOKEN:
    print("Define MP_WORKER_TOKEN con el valor de SUBTITLE_WORKER_TOKEN del servidor.")
    sys.exit(1)

HEADERS = {"X-Worker-Token": TOKEN}


def main():
    import whisper  # importación diferida: el arranque falla rápido si falta el token
    import whisper.utils

    model = whisper.load_model(MODEL_NAME)
    print(f"Worker listo (modelo {MODEL_NAME}). Consultando {SERVER} ...")
    while True:
        try:
            r = requests.get(f"{SERVER}/api/subtitles/worker/queue", headers=HEADERS, timeout=30)
            r.raise_for_status()
            job = r.json().get("job")
            if not job:
                time.sleep(POLL_SECONDS)
                continue
            name = job.get("fileName") or "audio.opus"
            print(f"Procesando {name} ...")
            with tempfile.TemporaryDirectory() as tmp:
                audio_path = os.path.join(tmp, os.path.basename(name))
                with requests.get(f"{SERVER}{job['downloadUrl']}", headers=HEADERS, stream=True, timeout=300) as dl:
                    dl.raise_for_status()
                    with open(audio_path, "wb") as fh:
                        for chunk in dl.iter_content(1024 * 256):
                            fh.write(chunk)
                result = model.transcribe(audio_path, fp16=False, word_timestamps=True)
                writer = whisper.utils.get_writer("vtt", tmp)
                writer(result, audio_path, {"max_line_width": 40, "max_line_count": 2, "highlight_words": False})
                vtt_path = os.path.splitext(audio_path)[0] + ".vtt"
                with open(vtt_path, "r", encoding="utf-8") as fh:
                    vtt = fh.read()
            up = requests.post(f"{SERVER}{job['uploadUrl']}", data=vtt.encode("utf-8"),
                               headers={**HEADERS, "Content-Type": "text/vtt; charset=utf-8"}, timeout=60)
            up.raise_for_status()
            print(f"Subtítulos enviados: {name}")
        except KeyboardInterrupt:
            break
        except Exception as exc:  # noqa: BLE001 - el worker debe sobrevivir a errores puntuales
            print(f"Error: {exc}")
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
