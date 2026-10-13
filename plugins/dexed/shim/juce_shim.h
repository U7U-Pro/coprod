// coprod: the one JUCE symbol the Dexed filter needs.
#pragma once
namespace juce {
template <typename T> struct MathConstants {
  static constexpr T pi = static_cast<T>(3.141592653589793238L);
};
}  // namespace juce
