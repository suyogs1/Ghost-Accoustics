import { useEffect } from 'react';

interface WakeLockSentinelLike {
  release(): Promise<void>;
}
type WakeLockNavigator = Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } };

/** Keeps the screen on while `active`, so a listening phone does not sleep mid-show. */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    const nav = navigator as WakeLockNavigator;
    if (!active || !nav.wakeLock) return;

    let sentinel: WakeLockSentinelLike | null = null;
    let cancelled = false;

    const acquire = async (): Promise<void> => {
      try {
        const next = await nav.wakeLock!.request('screen');
        if (cancelled) await next.release();
        else sentinel = next;
      } catch {
        // Denied (battery saver, hidden tab): listening still works.
      }
    };
    // The lock is released when the tab is hidden; take it again on return.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel?.release();
    };
  }, [active]);
}
