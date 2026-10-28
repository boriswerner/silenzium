/**
 * WAV lesen/schreiben ohne Web-Audio-Resampling – Samples und Samplerate bleiben exakt erhalten.
 * Nur DataView/TypedArrays, daher auch in Node nutzbar.
 */

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

export const SAMPLE_FORMATS = Object.freeze({
  pcm16: { label: '16 Bit PCM', bits: 16, float: false },
  pcm24: { label: '24 Bit PCM', bits: 24, float: false },
  float32: { label: '32 Bit Float', bits: 32, float: true },
});

export function isWav(buffer) {
  if (buffer.byteLength < 12) return false;
  const v = new DataView(buffer);
  return v.getUint32(0) === 0x52494646 /* RIFF */ && v.getUint32(8) === 0x57415645 /* WAVE */;
}

/**
 * @returns {{ sampleRate, channels: Float32Array[], length, sampleFormat }}
 */
export function parseWav(buffer) {
  if (!isWav(buffer)) throw new Error('Keine gültige WAV-Datei (RIFF/WAVE-Header fehlt).');
  const view = new DataView(buffer);
  let fmt = null;
  let dataOffset = -1;
  let dataSize = 0;

  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
    let size = view.getUint32(offset + 4, true);
    const body = offset + 8;

    if (id === 'fmt ') {
      let format = view.getUint16(body, true);
      if (format === FORMAT_EXTENSIBLE && size >= 26) format = view.getUint16(body + 24, true);
      fmt = {
        format,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        blockAlign: view.getUint16(body + 12, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      // Größe 0 / 0xFFFFFFFF kommt bei gestreamten Dateien vor → Rest der Datei verwenden
      const remaining = buffer.byteLength - body;
      if (size === 0 || size > remaining) size = remaining;
      dataOffset = body;
      dataSize = size;
    }
    offset = body + size + (size & 1);
  }

  if (!fmt) throw new Error('WAV-Datei ohne fmt-Chunk.');
  if (dataOffset < 0) throw new Error('WAV-Datei ohne data-Chunk.');
  if (!fmt.channels || !fmt.blockAlign) throw new Error('Ungültiger fmt-Chunk.');

  const bytesPerSample = fmt.blockAlign / fmt.channels;
  const read = sampleReader(view, fmt.format, bytesPerSample);
  if (!read) {
    throw new Error(`WAV-Format nicht unterstützt (Format ${fmt.format}, ${fmt.bitsPerSample} Bit).`);
  }

  const length = Math.floor(dataSize / fmt.blockAlign);
  const channels = Array.from({ length: fmt.channels }, () => new Float32Array(length));
  for (let i = 0; i < length; i++) {
    const frame = dataOffset + i * fmt.blockAlign;
    for (let c = 0; c < fmt.channels; c++) channels[c][i] = read(frame + c * bytesPerSample);
  }

  let sampleFormat = 'pcm16';
  if (fmt.format === FORMAT_FLOAT || bytesPerSample === 4) sampleFormat = 'float32';
  else if (bytesPerSample === 3) sampleFormat = 'pcm24';

  return { sampleRate: fmt.sampleRate, channels, length, sampleFormat };
}

function sampleReader(view, format, bytes) {
  if (format === FORMAT_PCM) {
    switch (bytes) {
      case 1: return (o) => (view.getUint8(o) - 128) / 128;
      case 2: return (o) => view.getInt16(o, true) / 32768;
      case 3: return (o) => {
        const v = view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getInt8(o + 2) << 16);
        return v / 8388608;
      };
      case 4: return (o) => view.getInt32(o, true) / 2147483648;
    }
  } else if (format === FORMAT_FLOAT) {
    if (bytes === 4) return (o) => view.getFloat32(o, true);
    if (bytes === 8) return (o) => view.getFloat64(o, true);
  }
  return null;
}

/**
 * Kodiert Kanäle als WAV. Ganzzahl-Formate skalieren mit 2^(bits-1) – damit sind
 * 16/24-Bit-Quellen nach parseWav → encodeWav bitgenau identisch.
 * @param {'pcm16'|'pcm24'|'float32'} sampleFormat
 * @returns {ArrayBuffer}
 */
export function encodeWav(channels, sampleRate, sampleFormat = 'pcm16') {
  const spec = SAMPLE_FORMATS[sampleFormat];
  if (!spec) throw new Error(`Unbekanntes Exportformat: ${sampleFormat}`);
  const numChannels = channels.length;
  const length = channels[0]?.length ?? 0;
  const bytes = spec.bits / 8;
  const blockAlign = numChannels * bytes;
  const dataSize = length * blockAlign;

  const buffer = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buffer);
  writeAscii(v, 0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  writeAscii(v, 8, 'WAVE');
  writeAscii(v, 12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, spec.float ? FORMAT_FLOAT : FORMAT_PCM, true);
  v.setUint16(22, numChannels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, spec.bits, true);
  writeAscii(v, 36, 'data');
  v.setUint32(40, dataSize, true);

  const scale = 2 ** (spec.bits - 1);
  let o = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numChannels; c++) {
      const x = channels[c][i];
      if (spec.float) {
        v.setFloat32(o, x, true);
      } else {
        const s = Math.max(-scale, Math.min(scale - 1, Math.round(x * scale)));
        if (spec.bits === 16) {
          v.setInt16(o, s, true);
        } else {
          v.setUint8(o, s & 0xff);
          v.setUint8(o + 1, (s >> 8) & 0xff);
          v.setUint8(o + 2, (s >> 16) & 0xff);
        }
      }
      o += bytes;
    }
  }
  return buffer;
}

/** 'auto' → Format der Quelle (falls WAV), sonst 16 Bit. */
export function resolveSampleFormat(exportFormat, sourceFormat) {
  if (exportFormat && exportFormat !== 'auto') return exportFormat;
  return SAMPLE_FORMATS[sourceFormat] ? sourceFormat : 'pcm16';
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}
