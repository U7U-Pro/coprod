// Grains: a granular synth for coprod, packaged as a Web Audio Module. Load
// any sound (or use the demo texture) and play it from the piano roll: each
// note turns the sound into a cloud of tiny pitched grains.

import { SampleNode, sampleModule, descriptor } from '../kit/node.js';
import { demoTexture } from '../kit/dsp.js';
import { TABLE } from './params.js';

class GrainsNode extends SampleNode {
  constructor(module) {
    super(module, 'coprod-grains', TABLE, demoTexture);
  }

  async getState() {
    return { v: 1, sample: this.sample, params: this.paramState() };
  }

  async setState(s) {
    if (!s || typeof s !== 'object') return;
    this.applyParamState(s.params);
    await this.setSample(s.sample ?? null);
    this.emit('all');
  }
}

const DESCRIPTOR = descriptor({
  identifier: 'com.coprod.grains',
  name: 'Grains',
  description: 'Granular synth: plays any sound as a cloud of pitched grains.',
  keywords: ['granular', 'sampler', 'texture', 'pad'],
});

export default sampleModule(DESCRIPTOR, new URL('processor.js', import.meta.url).href, GrainsNode, () => import('./gui.js'));
