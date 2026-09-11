#!/usr/bin/env sh
set -eu

MODEL_REPO="cris-cmd/michi-audio-affect"
MODEL_REVISION="92a14bcf2f909c30721d11bed8ec1705d1345023"
MODEL_SHA256="9875a67b9ae7fecad7151551b688d5224b42ec3095876973a3f18b7b60e83519"
DESTINATION="models/affect/michi-audio-affect"
BASE_URL="https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}"
DOWNLOAD_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$DOWNLOAD_DIR"
}
trap cleanup EXIT INT TERM

mkdir -p "$DOWNLOAD_DIR/onnx"

download() {
  curl --fail --location --retry 3 --show-error \
    --output "$DOWNLOAD_DIR/$1" "$BASE_URL/$1"
}

echo "Downloading ${MODEL_REPO}..."
download config.json
download preprocessor_config.json
download TRAINING_REPORT.json
download onnx/model_quantized.onnx

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA256="$(sha256sum "$DOWNLOAD_DIR/onnx/model_quantized.onnx" | cut -d ' ' -f 1)"
else
  ACTUAL_SHA256="$(shasum -a 256 "$DOWNLOAD_DIR/onnx/model_quantized.onnx" | cut -d ' ' -f 1)"
fi

if [ "$ACTUAL_SHA256" != "$MODEL_SHA256" ]; then
  echo "Checksum mismatch for model_quantized.onnx" >&2
  exit 1
fi

mkdir -p "$DESTINATION/onnx"
mv "$DOWNLOAD_DIR/config.json" "$DESTINATION/config.json"
mv "$DOWNLOAD_DIR/preprocessor_config.json" "$DESTINATION/preprocessor_config.json"
mv "$DOWNLOAD_DIR/TRAINING_REPORT.json" "$DESTINATION/TRAINING_REPORT.json"
mv "$DOWNLOAD_DIR/onnx/model_quantized.onnx" "$DESTINATION/onnx/model_quantized.onnx"

echo "Installed audio-affect model at ${DESTINATION}"
