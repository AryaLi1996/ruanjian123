#!/usr/bin/env python3
"""
Professional mode: LoRA+ rank-8, all linear layers unfrozen, gradient checkpointing.
VRAM budget ≤ 6 GB via activation recomputation.  GPU ≤ 1.5 h with 15 min of vocals.

Usage:
  python train_professional.py --data-dir /path/to/dry_vocals
  python train_professional.py --data-dir vocals/ --output model_pro.onnx --epochs 100
"""
import argparse
import json
import sys
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser(description="Professional LoRA+ fine-tuning")
    ap.add_argument("--data-dir",       type=Path,  required=True,
                    help="Directory containing dry vocal WAV files (≥ 15 min recommended)")
    ap.add_argument("--output",         type=Path,  default=Path("model_professional.onnx"))
    ap.add_argument("--epochs",         type=int,   default=100)
    ap.add_argument("--lr",             type=float, default=5e-5,
                    help="Base learning rate (lora_B gets lr × lora-plus-eta)")
    ap.add_argument("--lora-plus-eta",  type=float, default=16.0,
                    help="LR multiplier for LoRA B matrices (LoRA+ hyperparameter)")
    ap.add_argument("--batch",          type=int,   default=16,
                    help="Batch size — reduce to lower VRAM usage")
    ap.add_argument("--device",         type=str,   default=None)
    args = ap.parse_args()

    try:
        from trainer import train
    except ImportError as exc:
        print(json.dumps({"status": "error", "message": str(exc)}), flush=True)
        sys.exit(1)

    train(
        data_dir      = args.data_dir,
        output_path   = args.output,
        mode          = "professional",
        epochs        = args.epochs,
        batch_size    = args.batch,
        lr            = args.lr,
        lora_plus_eta = args.lora_plus_eta,
        device        = args.device,
        progress_path = args.output.parent / "progress_professional.json",
    )


if __name__ == "__main__":
    main()
