import { useCallback, useEffect, useRef, useState } from 'react';
import { useRealtime, useRealtimeConnectionState, useRpc, useSettings } from '@get-bb/plugin-sdk/app';
import { type contract, soundChannel, soundEventSchema } from './notification-contract';
import { createNotificationAudio, type SoundState } from './notification-sound';

function systemChannel(): 'web' | 'desktop' | null {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || !window.isSecureContext) return null;
  if ('bbDesktop' in window) return 'desktop';
  if ('bb' in window && typeof window.bb === 'object' && window.bb !== null && 'native' in window.bb) return null;
  return 'web';
}

export function useNotificationSound() {
  const rpc = useRpc<typeof contract>(), settings = useSettings();
  const connection = useRealtimeConnectionState();
  const enabled = settings.values?.soundEnabled === true;
  const enabledRef = useRef(enabled); enabledRef.current = enabled;
  const [state, setState] = useState<SoundState>('off');
  const [busy, setBusy] = useState(false), [played, setPlayed] = useState(0);
  const audio = useRef<ReturnType<typeof createNotificationAudio> | null>(null);
  const epoch = useRef(0);
  const clientId = useRef('');
  const pending = useRef(new Set<ReturnType<typeof setTimeout>>());
  const reportPresence = useCallback(() => {
    clientId.current ||= crypto.randomUUID();
    void rpc.call('notifications.sound.presence', { clientId: clientId.current, systemChannel: systemChannel() }).catch(() => {});
  }, [rpc]);
  useEffect(() => {
    let mounted = true;
    audio.current = createNotificationAudio(next => { if (mounted) setState(next); });
    reportPresence();
    const timer = setInterval(reportPresence, 15000);
    window.addEventListener('focus', reportPresence); document.addEventListener('visibilitychange', reportPresence);
    return () => {
      mounted = false; epoch.current++; clearInterval(timer);
      pending.current.forEach(clearTimeout); pending.current.clear();
      audio.current?.dispose(); audio.current = null;
      void rpc.call('notifications.sound.presence', { clientId: clientId.current, systemChannel: null }).catch(() => {});
      window.removeEventListener('focus', reportPresence); document.removeEventListener('visibilitychange', reportPresence);
    };
  }, [rpc, reportPresence]);
  useEffect(() => {
    epoch.current++;
    if (!enabled) { audio.current?.stop(); setState('off'); return; }
    // Desktop may allow creation immediately. Web browsers stay blocked until a gesture.
    void audio.current?.unlock();
    const unlock = () => { if (enabledRef.current) void audio.current?.unlock(); };
    window.addEventListener('pointerdown', unlock); window.addEventListener('keydown', unlock);
    return () => { window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
  }, [enabled]);
  useEffect(() => { epoch.current++; }, [connection]);
  useRealtime(soundChannel, payload => {
    const event = soundEventSchema.safeParse(payload);
    if (!event.success || !enabledRef.current || !audio.current?.ready()) return;
    const generation = epoch.current;
    // Focused windows get a small head start; an eligible background window can still sound.
    const timer = setTimeout(() => {
      pending.current.delete(timer);
      if (generation !== epoch.current || !enabledRef.current || !audio.current?.ready()) return;
      void rpc.call('notifications.sound.claim', { id: event.data.id }).then(result => {
        if (generation !== epoch.current || !enabledRef.current || !audio.current?.ready()) return;
        if (result.reason === 'system') setState('system');
        if (result.play && audio.current.play()) setPlayed(count => count + 1);
      }).catch(() => { if (generation === epoch.current) setState('error'); });
    }, document.visibilityState === 'visible' && document.hasFocus() ? 0 : 200);
    pending.current.add(timer);
  });
  useEffect(() => {
    const receive = (event: Event) => {
      const id = (event as CustomEvent).detail?.id;
      if (typeof id === 'string' && id.startsWith('derivation:'))
        void rpc.call('notifications.sound.contribute', { id: id.slice(0, 250) }).catch(() => {});
    };
    window.addEventListener('bb:status-popup', receive);
    return () => window.removeEventListener('bb:status-popup', receive);
  }, [rpc]);
  async function toggle() {
    if (busy) return;
    const next = !enabled;
    // This call starts synchronously within the click, before the settings round trip.
    if (next) void audio.current?.unlock();
    else { epoch.current++; audio.current?.stop(); }
    setBusy(true);
    try { await rpc.call('notifications.sound.setEnabled', { enabled: next }); }
    catch { setState('error'); }
    finally { setBusy(false); }
  }
  function preview() {
    void audio.current?.unlock();
    // resume() may finish asynchronously, but no old notification is retried.
    const generation = epoch.current;
    const timer = setTimeout(() => {
      pending.current.delete(timer);
      if (generation === epoch.current && enabledRef.current && audio.current?.play()) setPlayed(count => count + 1);
    }, 0);
    pending.current.add(timer);
  }
  return { enabled, state, busy: busy || settings.isLoading, played, toggle, preview };
}

export function NotificationSoundControls({ sound }: { sound: ReturnType<typeof useNotificationSound> }) {
  const description = !sound.enabled ? '' : sound.state === 'unsupported' ? 'Воспроизведение звука здесь недоступно.' :
    sound.state === 'blocked' ? 'Нажмите «Проверить звук», чтобы разрешить воспроизведение в этом окне.' :
    sound.state === 'error' ? 'Не удалось воспроизвести или сохранить звук. Попробуйте ещё раз.' : '';
  return <section className="kb-notification-sound" aria-label="Звук уведомлений"
    data-notification-sound-state={sound.enabled ? sound.state : 'off'} data-notification-sound-played={sound.played}>
    <div><button type="button" role="switch" aria-checked={sound.enabled} disabled={sound.busy}
      onClick={() => void sound.toggle()}>Звук новых уведомлений: {sound.enabled ? 'включён' : 'выключен'}</button>
    {sound.enabled && <button type="button" onClick={sound.preview}>Проверить звук</button>}</div>
    {description && <p role="status">{description}</p>}
  </section>;
}
