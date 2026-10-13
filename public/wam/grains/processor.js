// Grains on the audio thread.
import { registerEngine } from '../kit/processor.js';
import { GrainsEngine } from './engine.js';

registerEngine('coprod-grains', class extends GrainsEngine {
  constructor(sr) {
    super(sr, (Math.random() * 2 ** 32) >>> 0);
  }
});
