# Dexed (web build)

[Dexed](https://github.com/asb2m10/dexed) by Pascal Gauthier and contributors: a
DX7 FM synthesizer emulation. This folder is a WebAssembly build of its sound
engine packaged as a Web Audio Module, made for coprod.

- `dexed.wasm`: the engine (Dexed's `msfa` core, `EngineMkI`/`EngineOpl` and filter)
- `processor.js`: runs the engine on the audio thread
- `index.js`: the WAM wrapper and a DX7-style editor
- `banks/`: the voice banks that ship with Dexed (`builtin_pgm.zip`)

License: **GPL-3.0-or-later** (see `LICENSE`), the same as Dexed. Source code
for this build, including the changes made for the web, is in `plugins/dexed/`
of the coprod repository; `plugins/dexed/build.sh` rebuilds `dexed.wasm`. If you
publish coprod, publish that source with it.
