# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=[],
    datas=[('demucs_nano.onnx', '.'), ('dereverb.onnx', '.'), ('expression_encoder.onnx', '.'), ('model.onnx', '.'), ('model_professional.onnx', '.'), ('model_standard.onnx', '.'), ('sep_main.onnx', '.'), ('vocal_harmony_split.onnx', '.'), ('watermark_embed.onnx', '.'), ('*.py', '.')],
    hiddenimports=['soundfile', 'onnxruntime', 'numpy', 'cryptography', 'torch', 'paths'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='ruanjian-engine',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='ruanjian-engine',
)
