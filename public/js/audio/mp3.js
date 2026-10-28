/**
 * Liest die Samplerate aus dem ersten MPEG-Audio-Frame-Header.
 * Wird benötigt, damit decodeAudioData nicht auf die Samplerate des AudioContext resampelt.
 * @returns {number|null}
 */
export function sniffMp3SampleRate(buffer) {
  const b = new Uint8Array(buffer);
  let i = 0;

  // ID3v2-Tags überspringen ("ID3" + Version + Flags + syncsafe Größe)
  while (i + 10 <= b.length && b[i] === 0x49 && b[i + 1] === 0x44 && b[i + 2] === 0x33) {
    const size = ((b[i + 6] & 0x7f) << 21) | ((b[i + 7] & 0x7f) << 14) | ((b[i + 8] & 0x7f) << 7) | (b[i + 9] & 0x7f);
    const footer = b[i + 5] & 0x10 ? 10 : 0;
    i += 10 + size + footer;
  }

  const limit = Math.min(b.length - 4, i + 64 * 1024);
  for (; i < limit; i++) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
    const version = (b[i + 1] >> 3) & 3; // 0 = MPEG 2.5, 1 = reserviert, 2 = MPEG 2, 3 = MPEG 1
    const layer = (b[i + 1] >> 1) & 3;   // 0 = reserviert
    const bitrateIndex = b[i + 2] >> 4;
    const rateIndex = (b[i + 2] >> 2) & 3;
    if (version === 1 || layer === 0 || rateIndex === 3 || bitrateIndex === 0 || bitrateIndex === 15) continue;
    const base = [44100, 48000, 32000][rateIndex];
    return version === 3 ? base : version === 2 ? base / 2 : base / 4;
  }
  return null;
}
