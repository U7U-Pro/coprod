// The audio formats export can write, and their quality choices ([value, label], best first).
// Kept apart from encode.js so the page can list them without loading the encoders.

export const FORMATS = {
  wav: {
    label: 'WAV (lossless)',
    ext: 'wav',
    mime: 'audio/wav',
    qualities: [
      ['16', '16-bit (CD quality)'],
      ['24', '24-bit'],
      ['32', '32-bit float'],
    ],
  },
  mp3: {
    label: 'MP3',
    ext: 'mp3',
    mime: 'audio/mpeg',
    qualities: [
      // Constant bitrates only: the encoder can't write the header that tells
      // players a variable-bitrate file's length, and they'd guess it wrong.
      ['320', '320 kbps (best)'],
      ['256', '256 kbps'],
      ['192', '192 kbps'],
      ['128', '128 kbps (smallest)'],
    ],
  },
  ogg: {
    label: 'OGG Vorbis',
    ext: 'ogg',
    mime: 'audio/ogg',
    qualities: [
      ['8', 'q8 (≈256 kbps, best)'],
      ['6', 'q6 (≈192 kbps)'],
      ['4', 'q4 (≈128 kbps, smallest)'],
    ],
  },
};
