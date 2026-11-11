export type SoundState = 'off' | 'ready' | 'blocked' | 'unsupported' | 'system' | 'error';

/** One context per window. Only gestures may resume it; arrivals never queue audio. */
export function createNotificationAudio(update: (state: SoundState) => void) {
  let context: AudioContext | null = null;
  let disposed = false;
  const voices = new Set<{ oscillator: OscillatorNode; gain: GainNode }>();
  function ready() { return !disposed && context?.state === 'running'; }
  async function unlock() {
    if (disposed) return false;
    if (typeof window.AudioContext !== 'function') { update('unsupported'); return false; }
    try {
      context ??= new window.AudioContext();
      context.onstatechange = () => { if (!disposed) update(ready() ? 'ready' : 'blocked'); };
      // resume() can remain pending indefinitely without activation; never await it on arrivals.
      const resumed = context.resume();
      resumed.catch(() => { if (!disposed) update('blocked'); });
      update(context.state === 'running' ? 'ready' : 'blocked');
      return ready();
    } catch { update('blocked'); return false; }
  }
  function play() {
    if (!ready() || !context) return false;
    try {
      const start = context.currentTime;
      for (const [offset, frequency] of [[0, 660], [0.12, 880]]) {
        const oscillator = context.createOscillator(), gain = context.createGain();
        const voice = { oscillator, gain }; voices.add(voice);
        oscillator.type = 'sine'; oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, start + offset);
        gain.gain.linearRampToValueAtTime(0.09, start + offset + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.001, start + offset + 0.18);
        oscillator.connect(gain); gain.connect(context.destination);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); voices.delete(voice); };
        oscillator.start(start + offset); oscillator.stop(start + offset + 0.2);
      }
      update('ready'); return true;
    } catch { update('error'); return false; }
  }
  function stop() {
    for (const { oscillator, gain } of voices) {
      oscillator.onended = null;
      try { oscillator.stop(); } catch { /* Already ended. */ }
      oscillator.disconnect(); gain.disconnect();
    }
    voices.clear();
  }
  return { ready, unlock, play, stop, dispose() {
    disposed = true; stop();
    if (context) { context.onstatechange = null; void context.close().catch(() => {}); }
    context = null;
  } };
}
