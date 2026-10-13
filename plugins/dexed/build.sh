#!/bin/sh
# Builds the Dexed engine to WebAssembly: public/wam/dexed/dexed.wasm
# Needs clang/wasm-ld with the wasm32-wasi libc and libc++ (Ubuntu 24.04:
#   apt install clang lld wasi-libc libc++-18-dev-wasm32 libc++abi-18-dev-wasm32 libclang-rt-18-dev-wasm32)
set -e
cd "$(dirname "$0")"
OUT=../../public/wam/dexed
mkdir -p "$OUT"
CXX=${CXX:-clang++}
SRC="dexed_wasm.cpp tuning_std.cc upstream/PluginFx.cpp upstream/engine/EngineMkI.cpp upstream/engine/EngineOpl.cpp \
  upstream/msfa/dx7note.cc upstream/msfa/env.cc upstream/msfa/exp2.cc upstream/msfa/fm_core.cc upstream/msfa/fm_op_kernel.cc \
  upstream/msfa/freqlut.cc upstream/msfa/lfo.cc upstream/msfa/pitchenv.cc upstream/msfa/porta.cpp upstream/msfa/sin.cc"
$CXX --target=wasm32-wasi -std=c++17 -O3 -fno-exceptions -fvisibility=hidden \
  -Iupstream -Iupstream/msfa -Ishim -DNDEBUG -Wno-everything \
  -mexec-model=reactor \
  -Wl,--export=dexed_program -Wl,--export=dexed_scratch -Wl,--export=dexed_output -Wl,--export=dexed_unpack -Wl,--export=dexed_init -Wl,--export=dexed_set_engine -Wl,--export=dexed_set_filter -Wl,--export=dexed_program_changed -Wl,--export=dexed_panic -Wl,--export=dexed_note_off -Wl,--export=dexed_note_on -Wl,--export=dexed_cc -Wl,--export=dexed_pitchbend -Wl,--export=dexed_render -Wl,--export=dexed_active_voices -Wl,--strip-all -Wl,-z,stack-size=262144 \
  $SRC -o "$OUT/dexed.wasm"
echo "built $OUT/dexed.wasm ($(wc -c < "$OUT/dexed.wasm") bytes)"
