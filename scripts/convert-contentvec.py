#!/usr/bin/env python3
"""Convert the ContentVec checkpoint to the ONNX the engine loads.

Run by scripts/fetch-models.sh; not needed at runtime.

The published ONNX conversions of this model are not usable here: the MoeSS
ones are GPL-3.0 and this is a closed-source product, and the Xenova ones
state no license at all. Converting the MIT checkpoint ourselves means the
license of what ships is the license of what was downloaded.

Six of the twelve transformer layers are kept. Measured on four pairs of real
speakers, converting one towards the other's timbre, the depths scored 0.78
(6 layers), 0.77 (9) and 0.79 (12) — indistinguishable against a pair-to-pair
spread of 0.28 to 1.47 — so the 198 MB export ships rather than the 378 MB one.
"""
from __future__ import annotations

import sys
from pathlib import Path

KEEP_LAYERS = 6


def main(src: Path, dst: Path) -> int:
    import torch
    from transformers import HubertModel

    model = HubertModel.from_pretrained(str(src))
    model.eval()
    model.encoder.layers = torch.nn.ModuleList(list(model.encoder.layers)[:KEEP_LAYERS])

    class Encoder(torch.nn.Module):
        """[1, N] waveform at 16 kHz -> [1, T, 768] content."""

        def __init__(self, inner):
            super().__init__()
            self.inner = inner

        def forward(self, waveform):
            return self.inner(waveform).last_hidden_state

    encoder = Encoder(model).eval()
    dummy = torch.randn(1, 16_000 * 2)

    dst.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        encoder, (dummy,), str(dst),
        input_names=["waveform"], output_names=["content"],
        # Dynamic on length: the engine encodes in windows, and their last one
        # is short.
        dynamic_axes={"waveform": {1: "n"}, "content": {1: "t"}},
        opset_version=17, do_constant_folding=True, dynamo=False)

    # Prove the exported graph loads and agrees with the module it came from,
    # here rather than in the packaged app where a bad export is a support
    # ticket.
    import numpy as np
    import onnxruntime as ort

    with torch.no_grad():
        expected = encoder(dummy).numpy()
    session = ort.InferenceSession(str(dst), providers=["CPUExecutionProvider"])
    got = session.run(None, {"waveform": dummy.numpy()})[0]
    error = float(np.max(np.abs(got - expected)))
    if error > 1e-3:
        print(f"[convert-contentvec] export disagrees with torch by {error:.2e}",
              file=sys.stderr)
        return 1

    print(f"[convert-contentvec] wrote {dst} "
          f"({dst.stat().st_size / 1e6:.0f} MB, max error {error:.1e})")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: convert-contentvec.py <checkpoint-dir> <output.onnx>", file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(main(Path(sys.argv[1]), Path(sys.argv[2])))
