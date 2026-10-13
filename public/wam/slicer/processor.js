// Slicer on the audio thread.
import { registerEngine } from '../kit/processor.js';
import { SlicerEngine } from './engine.js';

registerEngine('coprod-slicer', SlicerEngine);
