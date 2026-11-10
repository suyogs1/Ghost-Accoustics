import { useEffect, useState } from 'react';

/** Returns performance.now() refreshed every animation frame while `running`. */
export function useFrameClock(running: boolean): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!running) return;
    let raf = 0;
    const tick = (): void => {
      setNow(performance.now());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running]);
  return now;
}
