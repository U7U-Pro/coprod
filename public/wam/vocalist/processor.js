// Vocalist on the audio thread.
import { registerEngine } from '../kit/processor.js';
import { VocalEngine } from './engine.js';

registerEngine('coprod-vocalist', class extends VocalEngine {
  constructor(sr) {
    super(sr, (Math.random() * 2 ** 32) >>> 0);
  }
});
