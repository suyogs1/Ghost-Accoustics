import { useCallback, useEffect, useRef, useState } from 'react';
import type { AcousticSocket } from '@ghost-acoustics/core';
import { createAudienceLink } from '../link/links';
import { decodeVenueFrame } from '../venue/decode';
import type { ReceivedEvent } from '../venue/decode';

export type AudienceStatus = 'off' | 'joining' | 'listening' | 'error';

export interface AudienceStats {
  readonly accepted: number;
  /** Frames rejected by the decoder (bad CRC, length or sync). */
  readonly rejected: number;
  /** Frames heard while transmitting/draining (should stay 0 on a listener). */
  readonly selfInterference: number;
}

const NO_STATS: AudienceStats = { accepted: 0, rejected: 0, selfInterference: 0 };
const HISTORY_LIMIT = 8;

export interface AudienceControls {
  readonly status: AudienceStatus;
  readonly event: ReceivedEvent | null;
  /** Increments on every accepted frame so effects can retrigger even for repeated cues. */
  readonly eventCount: number;
  readonly history: readonly ReceivedEvent[];
  readonly stats: AudienceStats;
  readonly error: string | null;
  readonly warning: string | null;
  /** Opens the microphone (live) or attaches to the in-memory bus (loopback). Call from a tap. */
  join(): Promise<void>;
  leave(): Promise<void>;
  dismiss(): void;
}

export function useAudienceLink(loopback: boolean): AudienceControls {
  const socketRef = useRef<AcousticSocket | null>(null);
  const offRef = useRef<(() => void)[]>([]);
  const joiningRef = useRef<Promise<void> | null>(null);
  const loopbackRef = useRef(loopback);

  const [status, setStatus] = useState<AudienceStatus>('off');
  const [event, setEvent] = useState<ReceivedEvent | null>(null);
  const [eventCount, setEventCount] = useState(0);
  const [history, setHistory] = useState<readonly ReceivedEvent[]>([]);
  const [stats, setStats] = useState<AudienceStats>(NO_STATS);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const teardown = useCallback(async () => {
    const socket = socketRef.current;
    socketRef.current = null;
    offRef.current.forEach((unsubscribe) => unsubscribe());
    offRef.current = [];
    const pending = joiningRef.current;
    joiningRef.current = null;
    await pending?.catch(() => undefined);
    await socket?.stop();
  }, []);

  const leave = useCallback(async () => {
    await teardown();
    setStatus('off');
  }, [teardown]);

  const join = useCallback(async () => {
    if (socketRef.current) return;
    setStatus('joining');
    setError(null);
    setStats(NO_STATS);
    const socket = createAudienceLink({ loopback: loopbackRef.current, onWarning: setWarning });
    socketRef.current = socket;
    offRef.current = [
      socket.on('packet', (frame) => {
        const decoded = decodeVenueFrame(frame);
        if (!decoded) return;
        setEvent(decoded);
        setEventCount((n) => n + 1);
        setHistory((prev) => [decoded, ...prev].slice(0, HISTORY_LIMIT));
        setStats((s) => ({ ...s, accepted: s.accepted + 1 }));
        if (decoded.kind === 'emergency') navigator.vibrate?.([300, 120, 300, 120, 600]);
      }),
      socket.on('drop', ({ reason }) => {
        if (reason === 'BadCrc' || reason === 'BadLength' || reason === 'BadSync') {
          setStats((s) => ({ ...s, rejected: s.rejected + 1 }));
        } else if (reason === 'half-duplex') {
          setStats((s) => ({ ...s, selfInterference: s.selfInterference + 1 }));
        }
      }),
    ];
    const joining = socket.start();
    joiningRef.current = joining;
    try {
      await joining;
      if (socketRef.current === socket) setStatus('listening');
    } catch (err) {
      if (socketRef.current === socket) {
        socketRef.current = null;
        offRef.current.forEach((unsubscribe) => unsubscribe());
        offRef.current = [];
        setError(describeMicError(err));
        setStatus('error');
      }
    }
  }, []);

  // Switching transport drops the current session; the user rejoins explicitly.
  useEffect(() => {
    loopbackRef.current = loopback;
    return () => {
      // Reset status synchronously: an async reset could land after a rejoin and mask it.
      void teardown();
      setStatus('off');
    };
  }, [loopback, teardown]);

  return {
    status,
    event,
    eventCount,
    history,
    stats,
    error,
    warning,
    join,
    leave,
    dismiss: () => setEvent(null),
  };
}

function describeMicError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') return 'Microphone permission was denied. Allow it in the browser settings and tap Join again.';
    if (err.name === 'NotFoundError') return 'No microphone was found on this device.';
  }
  if (!window.isSecureContext) return 'The microphone needs a secure (https) connection.';
  return err instanceof Error ? err.message : String(err);
}
