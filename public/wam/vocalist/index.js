// Vocalist: a singing synthesizer for coprod, packaged as a Web Audio Module.
// Type lyrics; they're split into syllables and put on the channel's notes
// (one syllable per note), and the synth sings each note's syllable. Voice
// knobs: pitch, formant, breathiness, lightness, tension, mouth opening,
// vibrato, glide, scoop, roughness and how strong the consonants are.
//
// Lyrics reach the synth as a SysEx message just before each note-on (see
// lyrics.js), so they also work from exports and from any host that sends it.

import { ParamNode, sampleModule, descriptor } from '../kit/node.js';
import { TABLE, VOICES } from './params.js';
import { parseLyricSysex, lyricSysex, noteLyric } from './lyrics.js';

const MAX_TEXT = 4000;
const PREVIEW_MELODY = [60, 62, 64, 67, 64, 62, 64, 60, 62, 64, 65, 67, 69, 67, 65, 64];

class VocalNode extends ParamNode {
  constructor(module) {
    super(module, 'coprod-vocalist', TABLE);
    this.text = ''; // the lyrics box, shared with collaborators
    this.fill = 'split'; // more syllables than notes: 'split' long notes, or 'add' notes after
  }

  translateEvent(e, time) {
    if (e.type !== 'wam-sysex') return null;
    const lyric = parseLyricSysex(e.data?.bytes);
    return lyric ? { kind: 'lyric', time, note: lyric.note, text: lyric.text } : null;
  }

  /** Sing one note now with a lyric ({ ly, ph } or text). */
  singNote(lyric, pitch = 60, seconds = 0.45, at = this.context.currentTime + 0.12) {
    const text = typeof lyric === 'string' ? lyric : noteLyric(lyric);
    const events = [];
    if (text) events.push({ type: 'wam-sysex', time: at, data: { bytes: lyricSysex(text, pitch) } });
    events.push({ type: 'wam-midi', time: at, data: { bytes: [0x90, pitch, 100] } }, { type: 'wam-midi', time: at + seconds, data: { bytes: [0x80, pitch, 0] } });
    this.scheduleEvents(...events);
  }

  /** Preview: sing syllables on a little tune. Returns how long it takes (s). */
  sing(syllables, beat = 0.34) {
    this.stopSinging();
    const t0 = this.context.currentTime + 0.12;
    syllables.forEach((s, i) => this.singNote(s, PREVIEW_MELODY[i % PREVIEW_MELODY.length], beat, t0 + i * beat));
    return syllables.length * beat;
  }

  stopSinging() {
    this.clearEvents();
    this.scheduleEvents({ type: 'wam-midi', time: this.context.currentTime, data: { bytes: [0xb0, 123, 0] } });
  }

  applyVoice(i) {
    const voice = VOICES[i];
    if (!voice) return;
    for (const [k, p] of this.table.PARAMS.entries()) {
      const v = voice.set[p.id];
      this.set(p.id, v === undefined ? this.table.DEFAULTS[k] : p.unmap(v));
    }
    this.emit('all');
  }

  async getState() {
    return { v: 1, text: this.text, fill: this.fill, params: this.paramState() };
  }

  async setState(s) {
    if (!s || typeof s !== 'object') return;
    this.applyParamState(s.params);
    this.text = typeof s.text === 'string' ? s.text.slice(0, MAX_TEXT) : '';
    this.fill = s.fill === 'add' ? 'add' : 'split';
    this.emit('all');
  }
}

const DESCRIPTOR = descriptor({
  identifier: 'com.coprod.vocalist',
  name: 'Vocalist',
  description: 'Singing synthesizer: type lyrics, it sings them on your notes.',
  keywords: ['vocal', 'voice', 'singing', 'lyrics', 'formant'],
  hasSysexInput: true,
  lyrics: true, // coprod: show lyric editing in the piano roll for this plugin
});

export default sampleModule(DESCRIPTOR, new URL('processor.js', import.meta.url).href, VocalNode, () => import('./gui.js'));
