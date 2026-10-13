// coprod: a small C interface to the Dexed engine for WebAssembly.
//
// This replaces Dexed's JUCE AudioProcessor (PluginProcessor.cpp). The voice
// allocation, rendering and filter steps below follow DexedAudioProcessor's
// keydown(), keyup() and processBlock(), simplified for one MIDI channel and
// no MPE, microtuning or mono mode.
//
// Copyright (c) 2013-2025 Pascal Gauthier (Dexed) and contributors.
// Modifications for coprod. Licensed under the GNU GPL v3 or later, like Dexed.

#include <cstdint>
#include <cstring>
#include <memory>

#include "PluginFx.h"
#include "engine/EngineMkI.h"
#include "engine/EngineOpl.h"
#include "msfa/aligned_buf.h"
#include "msfa/controllers.h"
#include "msfa/dx7note.h"
#include "msfa/env.h"
#include "msfa/exp2.h"
#include "msfa/fm_core.h"
#include "msfa/freqlut.h"
#include "msfa/lfo.h"
#include "msfa/pitchenv.h"
#include "msfa/porta.h"
#include "msfa/sin.h"
#include "msfa/synth.h"
#include "msfa/tuning.h"

#define EXPORT extern "C" __attribute__((visibility("default")))

namespace {

constexpr int MAX_VOICES = 16;
constexpr int MAX_BLOCK = 128 * 8;
constexpr int PROGRAM_BYTES = 156;  // 155 voice parameters + operator on/off mask

struct Voice {
  int midi_note = -1;
  int velocity = 0;
  bool keydown = false;
  bool sustained = false;
  bool live = false;
  int32_t seq = -1;
  Dx7Note *note = nullptr;
};

Voice voices[MAX_VOICES];
int currentNote = 0;
int32_t nextSeq = 0;
bool sustain = false;
Lfo lfo;
Controllers controllers;
FmCore engineModern;
EngineMkI engineMkI;
EngineOpl engineOpl;
PluginFx fx;
uint8_t program[PROGRAM_BYTES];
uint8_t scratch[4104];  // JS writes packed voices / sysex here
float out[MAX_BLOCK];
bool ready = false;

uint8_t normparm(uint8_t value, char max) { return value <= max ? value : (uint8_t)((float)value / 255 * max); }

}  // namespace

EXPORT uint8_t *dexed_program() { return program; }
EXPORT uint8_t *dexed_scratch() { return scratch; }
EXPORT float *dexed_output() { return out; }

/** Unpack one 128-byte packed voice (DX7 32-voice bulk format) from scratch+offset into program. */
EXPORT void dexed_unpack(int offset) {
  // Same mapping as Dexed's Cartridge::unpackProgram().
  const uint8_t *bulk = scratch + offset;
  uint8_t *ret = program;
  for (int op = 0; op < 6; op++) {
    for (int i = 0; i < 11; i++) ret[op * 21 + i] = normparm(bulk[op * 17 + i] & 0x7F, 99);
    memcpy(ret + op * 21, bulk + op * 17, 11);
    char lrc = bulk[op * 17 + 11] & 0xF;
    ret[op * 21 + 11] = lrc & 3;
    ret[op * 21 + 12] = (lrc >> 2) & 3;
    char detune_rs = bulk[op * 17 + 12] & 0x7F;
    ret[op * 21 + 13] = detune_rs & 7;
    char kvs_ams = bulk[op * 17 + 13] & 0x1F;
    ret[op * 21 + 14] = kvs_ams & 3;
    ret[op * 21 + 15] = (kvs_ams >> 2) & 7;
    ret[op * 21 + 16] = bulk[op * 17 + 14] & 0x7F;
    char fcoarse_mode = bulk[op * 17 + 15] & 0x3F;
    ret[op * 21 + 17] = fcoarse_mode & 1;
    ret[op * 21 + 18] = (fcoarse_mode >> 1) & 0x1F;
    ret[op * 21 + 19] = bulk[op * 17 + 16] & 0x7F;
    ret[op * 21 + 20] = (detune_rs >> 3) & 0x7F;
  }
  for (int i = 0; i < 8; i++) ret[126 + i] = normparm(bulk[102 + i] & 0x7F, 99);
  ret[134] = normparm(bulk[110] & 0x1F, 31);
  char oks_fb = bulk[111] & 0xF;
  ret[135] = oks_fb & 7;
  ret[136] = oks_fb >> 3;
  ret[137] = bulk[112] & 0x7F;
  ret[138] = bulk[113] & 0x7F;
  ret[139] = bulk[114] & 0x7F;
  ret[140] = bulk[115] & 0x7F;
  char lpms_lfw_lks = bulk[116] & 0x7F;
  ret[141] = lpms_lfw_lks & 1;
  ret[142] = (lpms_lfw_lks >> 1) & 7;
  ret[143] = lpms_lfw_lks >> 4;
  ret[144] = bulk[117] & 0x7F;
  for (int i = 0; i < 10; i++) ret[145 + i] = bulk[118 + i] & 0x7F;
  ret[155] = 0x3F;  // all six operators on
}

EXPORT void dexed_init(int sampleRate) {
  Exp2::init();
  Tanh::init();
  Sin::init();
  Freqlut::init(sampleRate);
  Lfo::init(sampleRate);
  PitchEnv::init(sampleRate);
  Env::init_sr(sampleRate);
  Porta::init_sr(sampleRate);
  fx.init(sampleRate);
  fx.uiCutoff = 1;
  fx.uiReso = 0;
  fx.uiGain = 1;

  auto tuning = createStandardTuning();
  for (auto &v : voices) {
    if (!v.note) v.note = new Dx7Note(tuning, nullptr);
    v = Voice{-1, 0, false, false, false, -1, v.note};
  }
  controllers.core = &engineMkI;  // Dexed's default "Mark I" engine
  controllers.pitch_range_up = 3;
  controllers.pitch_range_dn = 3;
  controllers.pitch_step = 0;
  controllers.masterTune = 0;
  controllers.pitch_cc = 0x2000;
  controllers.modwheel_cc = 0;
  controllers.foot_cc = 0;
  controllers.breath_cc = 0;
  controllers.aftertouch_cc = 0;
  controllers.portamento_enable_cc = false;
  controllers.portamento_cc = 0;
  controllers.portamento_gliss_cc = false;
  controllers.mpeEnabled = false;
  controllers.wheel.range = 50;  // mod wheel adds LFO pitch modulation
  controllers.wheel.pitch = true;
  controllers.refresh();
  memset(program, 0, sizeof program);
  program[155] = 0x3F;
  lfo.reset(program + 137);
  ready = true;
}

/** 0 = modern (msfa), 1 = Mark I (default), 2 = OPL. */
EXPORT void dexed_set_engine(int type) {
  controllers.core = type == 0 ? (FmCore *)&engineModern : type == 2 ? (FmCore *)&engineOpl : (FmCore *)&engineMkI;
}

EXPORT void dexed_set_filter(float cutoff, float reso, float gain) {
  fx.uiCutoff = cutoff;
  fx.uiReso = reso;
  fx.uiGain = gain;
}

/** The program bytes changed (new patch or an edited parameter): update sounding voices. */
EXPORT void dexed_program_changed() {
  for (auto &v : voices)
    if (v.live) v.note->update(program, v.midi_note, v.velocity, 0);
  lfo.reset(program + 137);
}

EXPORT void dexed_panic() {
  for (auto &v : voices) {
    v.midi_note = -1;
    v.keydown = false;
    v.live = false;
    v.note->oscSync();
  }
}

EXPORT void dexed_note_off(int pitch) {
  for (auto &v : voices) {
    if (v.midi_note == pitch && v.keydown) {
      v.keydown = false;
      if (sustain) v.sustained = true;
      else v.note->keyup();
      return;
    }
  }
}

EXPORT void dexed_note_on(int pitch, int velo) {
  if (velo == 0) return dexed_note_off(pitch);
  // Voice stealing, as in Dexed: prefer silent voices, then released ones,
  // then the same pitch; ties go to the least recently pressed key.
  bool triggerLfo = true;
  int best = currentNote, bestScore = -1, n = currentNote;
  for (int i = 0; i < MAX_VOICES; i++) {
    const Voice &v = voices[n];
    if (v.keydown) triggerLfo = false;
    int score = (!v.note->isPlaying() ? 4 : 0) + (!v.keydown ? 2 : 0) + (v.midi_note == pitch ? 1 : 0);
    if (score > bestScore || (score == bestScore && v.seq < voices[best].seq)) {
      best = n;
      bestScore = score;
    }
    n = (n + 1) % MAX_VOICES;
  }
  if (triggerLfo) lfo.keydown();
  Voice &v = voices[best];
  currentNote = (best + 1) % MAX_VOICES;
  v.midi_note = pitch;
  v.velocity = velo;
  v.sustained = sustain;
  v.keydown = true;
  v.seq = nextSeq++;
  bool steal = v.note->isPlaying();
  v.note->init(program, pitch, velo, 0, &controllers);
  if (program[136] && !steal) v.note->oscSync();  // oscillator key sync
  if (!program[136]) {
    for (int i = 0; i < MAX_VOICES; i++) {
      if (&voices[i] != &v && voices[i].note->isPlaying() && voices[i].midi_note == pitch) {
        v.note->transferPhase(*voices[i].note);
        break;
      }
    }
  }
  v.live = true;
}

EXPORT void dexed_cc(int cc, int value) {
  switch (cc) {
    case 1:
      controllers.modwheel_cc = value;
      controllers.refresh();
      break;
    case 64:
      sustain = value > 63;
      if (!sustain) {
        for (auto &v : voices) {
          if (v.sustained && !v.keydown) {
            v.note->keyup();
            v.sustained = false;
          }
        }
      }
      break;
    case 120:
    case 123:
      for (auto &v : voices) {
        if (v.keydown || v.sustained) v.note->keyup();
        v.keydown = v.sustained = false;
      }
      break;
  }
}

EXPORT void dexed_pitchbend(int value14) { controllers.pitch_cc = value14; }

/** Render `frames` mono samples (a multiple of 64) into dexed_output(). */
EXPORT int dexed_render(int frames) {
  if (!ready || frames % N || frames > MAX_BLOCK) return 0;
  for (int i = 0; i < frames; i += N) {
    AlignedBuf<int32_t, N> audiobuf;
    float sumbuf[N] = {0};
    for (int j = 0; j < N; ++j) audiobuf.get()[j] = 0;
    int32_t lfovalue = lfo.getsample();
    int32_t lfodelay = lfo.getdelay();
    for (auto &v : voices) {
      if (!v.live) continue;
      v.note->compute(audiobuf.get(), lfovalue, lfodelay, &controllers);
      for (int j = 0; j < N; ++j) {
        int32_t val = audiobuf.get()[j] >> 4;
        int clip = val < -(1 << 24) ? 0x8000 : val >= (1 << 24) ? 0x7fff : val >> 9;
        float f = (float)clip / (float)0x8000;
        sumbuf[j] += f > 1 ? 1 : f < -1 ? -1 : f;
        audiobuf.get()[j] = 0;
      }
    }
    memcpy(out + i, sumbuf, sizeof sumbuf);
  }
  fx.process(out, frames);
  return frames;
}

/** How many voices are sounding (for tests and meters). */
EXPORT int dexed_active_voices() {
  int n = 0;
  for (auto &v : voices) n += v.live && v.note->isPlaying();
  return n;
}

// Built without C++ exceptions: libc++'s operator new would throw bad_alloc
// on out-of-memory. There's nothing to recover in an audio thread, so trap.
extern "C" void *__cxa_allocate_exception(unsigned long) { __builtin_trap(); }
extern "C" void __cxa_throw(void *, void *, void (*)(void *)) { __builtin_trap(); }
