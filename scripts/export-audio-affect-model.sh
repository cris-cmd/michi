#!/usr/bin/env bash
# Build the audio affect model for in-process Node inference
# (src/server/affect.ts, loaded via @huggingface/transformers). Python/torch
# are BUILD-time only — the runtime never needs them.
#
#   Default (no args): run scripts/train-audio-affect-head.py — frozen
#     facebook/wav2vec2-base (Apache-2.0) + a small trained head on CREMA-D
#     (ODbL), fully automated, no manual labeling. Output:
#     models/affect/michi-audio-affect/ (+ TRAINING_REPORT.json).
#     This reproducible build keeps the runtime model and its training data
#     outside the repository.
#
#   With a HF model id argument: plain optimum ONNX export of that model
#     (used to benchmark pretrained candidates):
#     scripts/export-audio-affect-model.sh superb/wav2vec2-base-superb-er
#
# Reruns are idempotent. ~2.5 GB of build-time downloads (torch cpu, encoder
# weights, CREMA-D) cached under .cache/.
set -euo pipefail
cd "$(dirname "$0")/.."

VENV=".cache/affect-export-venv"
mkdir -p .cache models/affect
if [ ! -x "$VENV/bin/python" ]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --upgrade pip
  # CPU-only torch keeps the build venv ~5x smaller than the default wheel.
  "$VENV/bin/pip" install --quiet "torch==2.13.0" --index-url https://download.pytorch.org/whl/cpu
  "$VENV/bin/pip" install --quiet -r scripts/requirements-audio-model.txt
fi

if [ $# -eq 0 ]; then
  exec "$VENV/bin/python" scripts/train-audio-affect-head.py
fi

MODEL_ID="$1"
OUT="models/affect/$(basename "$MODEL_ID")"
if [ -f "$OUT/onnx/model_quantized.onnx" ]; then
  echo "already exported: $OUT"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

"$VENV/bin/optimum-cli" export onnx \
  --model "$MODEL_ID" --task audio-classification "$TMP/export"

"$VENV/bin/python" - "$TMP/export" <<'PY'
import sys
from pathlib import Path
from onnxruntime.quantization import QuantType, quantize_dynamic

export = Path(sys.argv[1])
# MatMul-only: ORT's dynamic quantizer cannot handle wav2vec2's positional
# conv (weight-norm Mul feeding Conv). The transformer MatMuls are where the
# parameters live, so the size/speed win is nearly identical.
quantize_dynamic(
    export / "model.onnx",
    export / "model_quantized.onnx",
    weight_type=QuantType.QUInt8,
    op_types_to_quantize=["MatMul"],
)
print("quantized:", (export / "model_quantized.onnx").stat().st_size // 1_000_000, "MB")
PY

# transformers.js layout: configs at the root, weights under onnx/.
mkdir -p "$OUT/onnx"
mv "$TMP/export/model.onnx" "$TMP/export/model_quantized.onnx" "$OUT/onnx/"
mv "$TMP/export"/*.json "$OUT/"
echo "exported: $OUT"
ls -lh "$OUT" "$OUT/onnx"
