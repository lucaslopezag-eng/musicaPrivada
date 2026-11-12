#!/usr/bin/env python3
# ─── TRANSCRIPCIÓN LOCAL CON faster-whisper ──────────────────────────────────
# Uso: transcribe.py <audio>
# Escribe en stdout UNA línea JSON:
#   { language, language_probability, duration, model, text, segments: [{start, end, text}] }
# Configuración por entorno:
#   WHISPER_MODEL (small), WHISPER_COMPUTE_TYPE (int8), WHISPER_THREADS (3),
#   WHISPER_VAD (0: en música el VAD descarta la voz cantada), WHISPER_MODEL_DIR (whisper/models junto a este script).
# Lo lanza src/services/transcriber.js con nice; los errores van a stderr.

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def load_audio(path):
    # Se decodifica con el ffmpeg del sistema (16 kHz mono float32) en vez de
    # PyAV: evita incompatibilidades de versión y acepta cualquier formato.
    import numpy as np
    raw = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", path, "-f", "f32le",
         "-ac", "1", "-ar", "16000", "-"],
        check=True, stdout=subprocess.PIPE).stdout
    return np.frombuffer(raw, dtype=np.float32)


def main():
    if len(sys.argv) != 2:
        print("Uso: transcribe.py <audio>", file=sys.stderr)
        return 2
    audio = sys.argv[1]
    if not os.path.isfile(audio):
        print(f"No existe el archivo: {audio}", file=sys.stderr)
        return 2

    from faster_whisper import WhisperModel

    model_name = os.environ.get("WHISPER_MODEL", "small")
    compute_type = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
    threads = int(os.environ.get("WHISPER_THREADS", "3"))
    vad = os.environ.get("WHISPER_VAD", "0") == "1"
    model_dir = os.environ.get("WHISPER_MODEL_DIR", os.path.join(HERE, "models"))

    model = WhisperModel(model_name, device="cpu", compute_type=compute_type,
                         cpu_threads=threads, download_root=model_dir)
    # condition_on_previous_text=False evita los bucles de repetición típicos
    # con estribillos; el idioma se autodetecta.
    segments, info = model.transcribe(load_audio(audio), beam_size=5, vad_filter=vad,
                                      condition_on_previous_text=False)
    out = []
    for s in segments:
        text = s.text.strip()
        if text:
            out.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": text})

    json.dump({
        "language": info.language,
        "language_probability": round(info.language_probability, 3),
        "duration": round(info.duration, 2),
        "model": model_name,
        "text": "\n".join(s["text"] for s in out),
        "segments": out,
    }, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
