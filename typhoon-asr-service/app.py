"""
Local Thai speech-to-text HTTP service (on-premises).

Two backends, chosen with ASR_BACKEND:
  - "nemo"    → SCB 10X typhoon-asr-realtime (fast, 115M, transliterates English)
  - "whisper" → faster-whisper (bigger, slower on CPU, keeps English terms in
                English — better for Thai/English code-switching)

    POST /transcribe   multipart/form-data, field "file"  -> {"text": "..."}
    GET  /health                                          -> {"ok": true, "ready": bool}

The model loads ONCE at startup and is reused (loading per request is far too
slow). Run:  ./venv/bin/uvicorn app:app --host 127.0.0.1 --port 8020
"""

import logging
import os
import tempfile
import time

from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("asr")

BACKEND = os.getenv("ASR_BACKEND", "nemo").lower()  # "nemo" | "whisper"
THREADS = int(os.getenv("OMP_NUM_THREADS", "4"))
TARGET_SR = 16000

# NeMo (Typhoon) settings
MODEL_ID = os.getenv("TYPHOON_MODEL", "scb10x/typhoon-asr-realtime")
MODEL_FILE = os.getenv("TYPHOON_MODEL_FILE", "typhoon-asr-realtime.nemo")

# Whisper settings (faster-whisper). large-v3 = best quality; medium = faster.
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "large-v3")
WHISPER_COMPUTE = os.getenv("WHISPER_COMPUTE", "int8")

app = FastAPI(title="ASR (local)")

_model = None


# ---------------------------------------------------------------- NeMo backend
def _load_nemo():
    import torch
    import nemo.collections.asr as nemo_asr
    from huggingface_hub import hf_hub_download

    torch.set_num_threads(THREADS)
    path = hf_hub_download(repo_id=MODEL_ID, filename=MODEL_FILE)
    model = nemo_asr.models.ASRModel.restore_from(path, map_location="cpu")
    model.eval()
    return model


def _hyp_to_text(item) -> str:
    if item is None:
        return ""
    if isinstance(item, str):
        return item.strip()
    text = getattr(item, "text", None)
    if isinstance(text, str):
        return text.strip()
    if text is not None:
        return _hyp_to_text(text)
    if isinstance(item, dict):
        return _hyp_to_text(item.get("text"))
    if isinstance(item, (list, tuple)):
        for sub in item:
            got = _hyp_to_text(sub)
            if got:
                return got
    return ""


def _transcribe_nemo(path: str) -> str:
    import librosa
    import soundfile as sf

    audio, _ = librosa.load(path, sr=TARGET_SR, mono=True)
    if audio.size == 0:
        return ""
    tmp_wav = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp:
            tmp_wav = tmp.name
        sf.write(tmp_wav, audio, TARGET_SR)
        result = _model.transcribe([tmp_wav], batch_size=1, verbose=False)
        return _hyp_to_text(result)
    finally:
        if tmp_wav and os.path.exists(tmp_wav):
            try:
                os.unlink(tmp_wav)
            except OSError:
                pass


# ------------------------------------------------------------- Whisper backend
def _load_whisper():
    from faster_whisper import WhisperModel

    return WhisperModel(WHISPER_MODEL, device="cpu", compute_type=WHISPER_COMPUTE, cpu_threads=THREADS)


def _transcribe_whisper(path: str) -> str:
    # language="th" keeps it Thai-primary; Whisper still emits English words in
    # English (e.g. "Spot UV") instead of transliterating them.
    segments, _info = _model.transcribe(
        path,
        language="th",
        beam_size=1,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    return " ".join(s.text.strip() for s in segments).strip()


# ---------------------------------------------------------------------- routes
@app.on_event("startup")
def _startup() -> None:
    global _model
    try:
        started = time.time()
        log.info("loading backend=%s (threads=%d) ...", BACKEND, THREADS)
        _model = _load_whisper() if BACKEND == "whisper" else _load_nemo()
        log.info("model ready in %.1fs", time.time() - started)
    except Exception:
        log.exception("failed to load the model — /transcribe will return errors")


@app.get("/health")
def health():
    return {
        "ok": True,
        "ready": _model is not None,
        "backend": BACKEND,
        "model": WHISPER_MODEL if BACKEND == "whisper" else MODEL_ID,
        "threads": THREADS,
    }


@app.post("/transcribe")
def transcribe_endpoint(file: UploadFile = File(...)):
    if _model is None:
        return JSONResponse({"text": "", "error": "model not loaded"}, status_code=503)

    data = file.file.read()
    if not data:
        return {"text": ""}

    suffix = os.path.splitext(file.filename or "audio.wav")[1] or ".wav"
    tmp_path = None
    started = time.time()
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(data)
            tmp_path = tmp.name
        text = _transcribe_whisper(tmp_path) if BACKEND == "whisper" else _transcribe_nemo(tmp_path)
        log.info("%d bytes -> %d chars in %.2fs", len(data), len(text), time.time() - started)
        return {"text": text}
    except Exception as err:
        log.exception("transcribe failed")
        return JSONResponse({"text": "", "error": str(err)}, status_code=500)
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
