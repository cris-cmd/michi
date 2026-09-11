#!/usr/bin/env bash
# Fetch a handful of CREMA-D clips as AUDIO BENCHMARK FIXTURES for
# harness/affect.ts (tone-only test cases: same words, different vocal
# emotion). Downloaded on demand, never committed — CREMA-D is ODbL-licensed
# research data (github.com/CheyneyComputerScience/CREMA-D); we use 8 clips
# strictly as a local test fixture, not as a distributed asset or training data.
#
# Files: <actor>_<sentence>_<EMOTION>_<level>.wav, 16 kHz mono PCM.
#   IEO = "It's eleven o'clock" · DFA = "Don't forget a jacket"
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="harness/fixtures/affect"
mkdir -p "$OUT"

BASE="https://media.githubusercontent.com/media/CheyneyComputerScience/CREMA-D/master/AudioWAV"
# IEO ("It's eleven o'clock") carries intensity levels — use HI for the
# emotional clips; neutral has no level (XX). DFA clips are all XX.
CLIPS=(
  1001_DFA_SAD_XX 1001_DFA_HAP_XX 1001_DFA_ANG_XX 1001_DFA_NEU_XX
  1076_IEO_SAD_HI 1076_IEO_HAP_HI 1076_IEO_ANG_HI 1076_IEO_NEU_XX
)

for c in "${CLIPS[@]}"; do
  f="$OUT/$c.wav"
  if [ -s "$f" ] && head -c4 "$f" | grep -q RIFF; then continue; fi
  echo "fetching $c.wav"
  curl -sfL -o "$f" "$BASE/$c.wav"
  head -c4 "$f" | grep -q RIFF || { echo "ERROR: $c.wav is not a RIFF wav (LFS pointer?)"; exit 1; }
done
echo "fixtures ready: $OUT"; ls -l "$OUT"
