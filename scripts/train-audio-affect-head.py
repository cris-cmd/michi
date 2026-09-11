#!/usr/bin/env python3
"""Reproducible audio-affect model build without manual labeling or a GPU.

Run through scripts/export-audio-affect-model.sh. The build combines a frozen
Apache-2.0 wav2vec2 encoder with a small head trained on public labeled data.

Recipe
  encoder   facebook/wav2vec2-base (Apache-2.0), FROZEN — one forward per
            clip with output_hidden_states=True gives all 13 layers at once
  data      CREMA-D (ODbL) via myleslinder/crema-d — 7.4k clips, 91 actors,
            6 classes (ANG DIS FEA HAP NEU SAD); labels parsed from filenames
  split     actor-disjoint: fixture actors (1001, 1076) fully EXCLUDED,
            8 more actors held out for eval, rest train
  head      multinomial logistic regression on mean-pooled hidden states;
            the layer is picked by held-out accuracy (automated sweep)
  package   head folded into a stock Wav2Vec2ForSequenceClassification
            (one-hot use_weighted_layer_sum picks the layer; projector=I;
            classifier=LR weights — mean-pool commutes with linear maps,
            so ONNX output == sklearn logits) → optimum ONNX export →
            MatMul-only int8 → models/affect/michi-audio-affect/

Every artifact lands under .cache/ except the final model directory.
"""

import json
import sys
import tarfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache" / "affect-train"
OUT = ROOT / "models" / "affect" / "michi-audio-affect"
ENCODER = "facebook/wav2vec2-base"
ENCODER_REVISION = "0b5b8e868dd84f03fd87d01f9c4ff0f080fecfe8"
DATASET_REPO = "myleslinder/crema-d"
DATASET_REVISION = "8a11ae8cb89df0d49a85ab0a64410a9f354c11e4"
FIXTURE_ACTORS = {"1001", "1076"}  # harness/affect.ts tests on these — never train on them
N_EVAL_ACTORS = 8
LABELS = ["ang", "dis", "fea", "hap", "neu", "sad"]
SEED = 7


def log(msg: str) -> None:
    print(f"[train] {msg}", flush=True)


def fetch_clips() -> list[tuple[Path, str, str]]:
    """Download + extract CREMA-D; return (path, label, actor) per clip."""
    from huggingface_hub import hf_hub_download

    wav_root = CACHE / "wavs"
    if not wav_root.exists():
        log(f"downloading {DATASET_REPO} …")
        tar = hf_hub_download(
            DATASET_REPO,
            "data/crema_d.tar.gz",
            repo_type="dataset",
            revision=DATASET_REVISION,
            cache_dir=str(CACHE / "hub"),
        )
        wav_root.mkdir(parents=True)
        with tarfile.open(tar) as tf:
            tf.extractall(wav_root, filter="data")
    clips = []
    for p in sorted(wav_root.rglob("*.wav")):
        parts = p.stem.split("_")  # 1001_DFA_ANG_XX
        if len(parts) != 4:
            continue
        actor, _, emo, _ = parts
        if emo.lower()[:3] in {l[:3] for l in LABELS}:
            clips.append((p, emo.lower()[:3], actor))
    if len(clips) < 5000:
        sys.exit(f"expected ~7.4k CREMA-D clips, found {len(clips)} — download broken?")
    log(f"{len(clips)} labeled clips, {len({a for _, _, a in clips})} actors")
    return clips


def extract_features(clips) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Mean-pooled hidden states per layer: X[n_clips, n_layers, 768]."""
    import torch
    import soundfile as sf
    from transformers import AutoFeatureExtractor, Wav2Vec2Model

    feats_file = CACHE / "features.npz"
    if feats_file.exists():
        z = np.load(feats_file, allow_pickle=True)
        return z["X"], z["y"], z["actors"]

    fe = AutoFeatureExtractor.from_pretrained(ENCODER, revision=ENCODER_REVISION)
    model = Wav2Vec2Model.from_pretrained(ENCODER, revision=ENCODER_REVISION)
    model.eval()
    torch.set_num_threads(max(4, (torch.get_num_threads() or 4)))

    X, y, actors = [], [], []
    with torch.no_grad():
        for i, (path, label, actor) in enumerate(clips):
            pcm, sr = sf.read(path, dtype="float32")
            if sr != 16000:
                continue
            inputs = fe(pcm, sampling_rate=sr, return_tensors="pt")
            hs = model(inputs.input_values, output_hidden_states=True).hidden_states
            X.append(np.stack([h[0].mean(dim=0).numpy() for h in hs]))  # [13, 768]
            y.append(LABELS.index(label))
            actors.append(actor)
            if (i + 1) % 500 == 0:
                log(f"features {i + 1}/{len(clips)}")
    X, y, actors = np.stack(X), np.array(y), np.array(actors)
    np.savez_compressed(feats_file, X=X, y=y, actors=actors)
    return X, y, actors


def train_head(X, y, actors):
    """Layer sweep + LR fit; returns (best_layer, weights, bias, report)."""
    from sklearn.linear_model import LogisticRegression

    rng = np.random.default_rng(SEED)
    others = sorted(set(actors) - FIXTURE_ACTORS)
    eval_actors = set(rng.choice(others, N_EVAL_ACTORS, replace=False))
    train_mask = np.array([a not in eval_actors and a not in FIXTURE_ACTORS for a in actors])
    eval_mask = np.array([a in eval_actors for a in actors])
    log(f"train {train_mask.sum()} clips / eval {eval_mask.sum()} clips (actors {sorted(eval_actors)})")

    best = None
    for layer in range(X.shape[1]):
        lr = LogisticRegression(max_iter=2000, C=1.0)
        lr.fit(X[train_mask, layer], y[train_mask])
        acc = lr.score(X[eval_mask, layer], y[eval_mask])
        log(f"layer {layer:2d}: eval acc {acc:.3f}")
        if best is None or acc > best[1]:
            best = (layer, acc, lr)
    layer, acc, lr = best

    from sklearn.metrics import classification_report, confusion_matrix, recall_score

    pred = lr.predict(X[eval_mask, layer])
    report = {
        "encoder": ENCODER,
        "encoder_revision": ENCODER_REVISION,
        "dataset": f"{DATASET_REPO} (CREMA-D, ODbL)",
        "dataset_revision": DATASET_REVISION,
        "layer": int(layer),
        "evaluation_scope": "held-out actor validation; this split also selected the encoder layer",
        "eval_actors": sorted(eval_actors),
        "eval_accuracy": round(float(acc), 4),
        "eval_recall_per_class": {
            LABELS[i]: round(float(r), 4)
            for i, r in enumerate(recall_score(y[eval_mask], pred, average=None))
        },
        "confusion_matrix_rows_true": confusion_matrix(y[eval_mask], pred).tolist(),
        "labels": LABELS,
        "chance": round(1 / len(LABELS), 4),
        "human_voice_only_crema_d": 0.409,  # Cao et al. 2014, audio-only rater accuracy
    }
    log(classification_report(y[eval_mask], pred, target_names=LABELS))
    return layer, lr.coef_, lr.intercept_, report


def package(layer: int, W: np.ndarray, b: np.ndarray, report: dict) -> None:
    """Fold the head into a stock HF model, export ONNX, quantize."""
    import torch
    from transformers import AutoFeatureExtractor, Wav2Vec2ForSequenceClassification

    hf_dir = CACHE / "hf-model"
    model = Wav2Vec2ForSequenceClassification.from_pretrained(
        ENCODER,
        revision=ENCODER_REVISION,
        num_labels=len(LABELS),
        classifier_proj_size=768,
        use_weighted_layer_sum=True,
        id2label={i: l for i, l in enumerate(LABELS)},
        label2id={l: i for i, l in enumerate(LABELS)},
    )
    with torch.no_grad():
        one_hot = torch.full((model.config.num_hidden_layers + 1,), -1e4)
        one_hot[layer] = 1e4  # softmaxed layer weights → effectively one-hot
        model.layer_weights.copy_(one_hot)
        model.projector.weight.copy_(torch.eye(768))
        model.projector.bias.zero_()
        model.classifier.weight.copy_(torch.tensor(W, dtype=torch.float32))
        model.classifier.bias.copy_(torch.tensor(b, dtype=torch.float32))
    model.save_pretrained(hf_dir)
    AutoFeatureExtractor.from_pretrained(ENCODER, revision=ENCODER_REVISION).save_pretrained(hf_dir)

    from optimum.exporters.onnx import main_export
    from onnxruntime.quantization import QuantType, quantize_dynamic

    export_dir = CACHE / "onnx-export"
    main_export(str(hf_dir), output=str(export_dir), task="audio-classification")
    # per_channel QInt8, NOT per-tensor QUInt8: under onnxruntime >= 1.29
    # per-tensor asymmetric weights collapse the wav2vec2 encoder to a
    # near-constant output (verified: fp32 parity holds, per-tensor int8
    # returns the same distribution for every clip).
    quantize_dynamic(
        export_dir / "model.onnx",
        export_dir / "model_quantized.onnx",
        weight_type=QuantType.QInt8,
        per_channel=True,
        op_types_to_quantize=["MatMul"],
    )

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "onnx").mkdir(exist_ok=True)
    for f in export_dir.glob("*.onnx"):
        f.rename(OUT / "onnx" / f.name)
    for f in export_dir.glob("*.json"):
        f.rename(OUT / f.name)
    (OUT / "TRAINING_REPORT.json").write_text(json.dumps(report, indent=2))
    log(f"packaged → {OUT}")


def main() -> None:
    CACHE.mkdir(parents=True, exist_ok=True)
    if (OUT / "onnx" / "model_quantized.onnx").exists():
        log(f"already built: {OUT} (delete to rebuild)")
        return
    clips = fetch_clips()
    X, y, actors = extract_features(clips)
    layer, W, b, report = train_head(X, y, actors)
    package(layer, W, b, report)
    log(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
