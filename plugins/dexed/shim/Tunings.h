// coprod: stand-in for surge-synthesizer/tuning-library. Only standard 12-TET
// tuning is used in the browser build, so these types are never populated.
#pragma once
namespace Tunings {
struct Scale { int count = 12; };
struct KeyboardMapping {};
struct Tuning {
  Scale scale;
  double logScaledFrequencyForMidiNote(int) const { return 0; }
};
}  // namespace Tunings
