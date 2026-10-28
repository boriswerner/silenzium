/** Minimaler Vorhör-Player: immer nur eine Wiedergabe gleichzeitig. */
let ctx = null;
let current = null;

export function play(channels, sampleRate, onEnded) {
  stop();
  const length = channels[0]?.length ?? 0;
  if (!length) return;
  ctx ??= new AudioContext();
  const buffer = ctx.createBuffer(channels.length, length, sampleRate);
  channels.forEach((data, c) => buffer.copyToChannel(data, c));
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.onended = () => {
    if (current === src) current = null;
    onEnded?.();
  };
  src.start();
  current = src;
}

export function stop() {
  if (!current) return;
  const src = current;
  current = null;
  try { src.stop(); } catch { /* bereits beendet */ }
}

export function isPlaying() {
  return current !== null;
}
