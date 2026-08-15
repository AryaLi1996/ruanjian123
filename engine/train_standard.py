#!/usr/bin/env python3
"""
Standard mode: LoRA rank-4 fine-tuning of the timbre encoder only.
GPU ≤ 5 min with 5 min of vocals; CPU ≤ 20 min.

Usage:
  python train_standard.py --data-dir /path/to/dry_vocals
  python train_standard.py --data-dir vocals/ --output model_singer.onnx --epochs 50
"""
import argparse
import json
import sys
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser(description="Standard LoRA fine-tuning")
    ap.add_argument("--data-dir", type=Path, required=True,
                    help="Directory containing dry vocal WAV files")
    ap.add_argument("--output",   type=Path,  default=Path("model_standard.onnx"),
                    help="Output ONNX model path")
    ap.add_argument("--epochs",   type=int,   default=50)
    ap.add_argument("--lr",       type=float, default=1e-4)
    ap.add_argument("--batch",    type=int,   default=32)
    ap.add_argument("--device",   type=str,   default=None,
                    help="'cpu', 'cuda', or 'mps' (auto-detected if omitted)")
    args = ap.parse_args()

    try:
        from trainer import train
    except ImportError as exc:
        print(json.dumps({"status": "error", "message": str(exc)}), flush=True)
        sys.exit(1)

    train(
        data_dir    = args.data_dir,
        output_path = args.output,
        mode        = "standard",
        epochs      = args.epochs,
        batch_size  = args.batch,
        lr          = args.lr,
        device      = args.device,
        progress_path = args.output.parent / "progress_standard.json",
    )


if __name__ == "__main__":
    main()
