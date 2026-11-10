import { useCallback, useEffect, useRef, useState } from 'react';
import type { LinkState } from '@ghost-acoustics/core';
import { Opcode, OPCODE_REGISTRY } from '@ghost-acoustics/schema-compiler/generated/opcodes';
import {
  EMERGENCY_BEACON_PAYLOAD_BYTES,
  VENUE_CUE_PAYLOAD_BYTES,
  packEmergencyBeacon,
  packVenueCue,
} from '@ghost-acoustics/schema-compiler/generated/serializers';
import type { EmergencyBeacon, VenueCue } from '@ghost-acoustics/schema-compiler/generated/types';
import { createStageLink } from '../link/links';
import type { StageLink } from '../link/links';
import { emergencyBeacon } from '../venue/cues';

export interface TxProgress {
  readonly phase: 'idle' | 'transmitting' | 'draining';
  /** performance.now() when the speaker started. */
  readonly startedAt: number;
  readonly estimatedSeconds: number;
}

export interface LastTransmission {
  readonly label: string;
  readonly opcode: number;
  readonly frameBytes: number;
  readonly estimated: number;
  readonly measured: number;
  readonly at: number;
}

export interface AudioDevice {
  readonly id: string;
  readonly label: string;
}

const IDLE_TX: TxProgress = { phase: 'idle', startedAt: 0, estimatedSeconds: 0 };

export function airtimeFor(opcode: number): number {
  return OPCODE_REGISTRY.find((info) => info.opcode === opcode)?.airtimeSeconds ?? 0;
}

async function readBatteryPct(): Promise<number> {
  const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number }> };
  try {
    return nav.getBattery ? Math.round((await nav.getBattery()).level * 100) : 100;
  } catch {
    return 100;
  }
}

export interface StageControls {
  readonly armed: boolean;
  readonly busy: boolean;
  readonly linkState: LinkState;
  readonly tx: TxProgress;
  readonly last: LastTransmission | null;
  readonly error: string | null;
  readonly warning: string | null;
  readonly devices: readonly AudioDevice[];
  readonly canSelectOutput: boolean;
  /** Starts the speaker. In live mode this must run inside a click/tap. */
  arm(): Promise<void>;
  sendCue(label: string, cue: VenueCue): Promise<void>;
  sendEmergency(label: string): Promise<void>;
  playTestTone(): Promise<void>;
  clearError(): void;
}

export function useStageLink(loopback: boolean, volume: number, outputDeviceId: string | undefined): StageControls {
  const linkRef = useRef<StageLink | null>(null);
  const startRef = useRef<Promise<void> | null>(null);
  const estimateRef = useRef(0);
  const labelRef = useRef('');
  const volumeRef = useRef(volume);
  const outputRef = useRef(outputDeviceId);

  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [linkState, setLinkState] = useState<LinkState>('IDLE');
  const [tx, setTx] = useState<TxProgress>(IDLE_TX);
  const [last, setLast] = useState<LastTransmission | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [devices, setDevices] = useState<readonly AudioDevice[]>([]);
  const [canSelectOutput, setCanSelectOutput] = useState(false);

  // (Re)build the socket when the transport (live vs loopback) changes.
  useEffect(() => {
    const link = createStageLink({
      loopback,
      volume: volumeRef.current,
      outputDeviceId: outputRef.current,
      onWarning: setWarning,
    });
    linkRef.current = link;
    startRef.current = null;
    setArmed(false);
    setTx(IDLE_TX);
    setLinkState('IDLE');
    setError(null);

    const off = [
      link.socket.on('state', (state) => {
        setLinkState(state);
        if (state === 'TRANSMITTING') {
          setTx({ phase: 'transmitting', startedAt: performance.now(), estimatedSeconds: estimateRef.current });
        } else if (state === 'DRAINING') {
          setTx((prev) => ({ ...prev, phase: 'draining' }));
        } else {
          setTx(IDLE_TX);
        }
      }),
      link.socket.on('airtime', (event) => {
        setLast({
          label: labelRef.current,
          opcode: event.opcode,
          frameBytes: event.frameBytes,
          estimated: event.estimated,
          measured: event.measured,
          at: Date.now(),
        });
      }),
    ];

    // Loopback needs no user gesture, so arm immediately. Live waits for a tap.
    let startPromise: Promise<void> | null = null;
    if (loopback) {
      startPromise = link.socket.start().then(() => setArmed(true));
      startRef.current = startPromise;
    }

    return () => {
      off.forEach((unsubscribe) => unsubscribe());
      linkRef.current = null;
      // Let any in-flight start() settle before stopping so nothing stays attached to the bus.
      const pending = startRef.current ?? startPromise ?? Promise.resolve();
      void pending.catch(() => undefined).then(() => link.socket.stop());
    };
  }, [loopback]);

  useEffect(() => {
    volumeRef.current = volume;
    linkRef.current?.audio?.setVolume(volume);
  }, [volume]);

  useEffect(() => {
    outputRef.current = outputDeviceId;
    const audio = linkRef.current?.audio;
    if (audio && armed) void audio.setOutputDevice(outputDeviceId);
  }, [outputDeviceId, armed]);

  // Output device list. Labels are only populated once the user has granted some media permission.
  useEffect(() => {
    if (loopback || !navigator.mediaDevices?.enumerateDevices) {
      setDevices([]);
      setCanSelectOutput(false);
      return;
    }
    const refresh = async (): Promise<void> => {
      const all = await navigator.mediaDevices.enumerateDevices();
      const outputs = all.filter((d) => d.kind === 'audiooutput');
      setDevices(outputs.map((d, i) => ({ id: d.deviceId, label: d.label || `Speaker ${i + 1}` })));
      const ctor = (globalThis as { AudioContext?: { prototype: object } }).AudioContext;
      setCanSelectOutput(outputs.length > 0 && !!ctor && 'setSinkId' in ctor.prototype);
    };
    void refresh().catch(() => undefined);
    navigator.mediaDevices.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh);
  }, [loopback, armed]);

  const arm = useCallback(async () => {
    const link = linkRef.current;
    if (!link) return;
    try {
      startRef.current ??= link.socket.start();
      await startRef.current;
      setArmed(true);
      setError(null);
    } catch (err) {
      startRef.current = null;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const transmit = useCallback(
    async (label: string, opcode: number, payload: Uint8Array) => {
      const link = linkRef.current;
      if (!link) return;
      setBusy(true);
      try {
        await arm();
        estimateRef.current = airtimeFor(opcode);
        labelRef.current = label;
        await link.socket.broadcast(opcode, payload);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [arm],
  );

  const sendCue = useCallback(
    (label: string, cue: VenueCue) => {
      const payload = new Uint8Array(VENUE_CUE_PAYLOAD_BYTES);
      packVenueCue(cue, payload);
      return transmit(label, Opcode.VENUE_CUE, payload);
    },
    [transmit],
  );

  const sendEmergency = useCallback(
    async (label: string) => {
      // Start audio first, synchronously inside the tap: iOS only unlocks audio from a user gesture.
      const ready = arm();
      const beacon: EmergencyBeacon = emergencyBeacon(await readBatteryPct());
      await ready;
      const payload = new Uint8Array(EMERGENCY_BEACON_PAYLOAD_BYTES);
      packEmergencyBeacon(beacon, payload);
      await transmit(label, Opcode.EMERGENCY_BEACON, payload);
    },
    [transmit],
  );

  const playTestTone = useCallback(async () => {
    const audio = linkRef.current?.audio;
    if (!audio) return; // loopback has no speaker
    try {
      await arm();
      await audio.playTestTone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [arm]);

  return {
    armed,
    busy,
    linkState,
    tx,
    last,
    error,
    warning,
    devices,
    canSelectOutput,
    arm,
    sendCue,
    sendEmergency,
    playTestTone,
    clearError: () => setError(null),
  };
}
