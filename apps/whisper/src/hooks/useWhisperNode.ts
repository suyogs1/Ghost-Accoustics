import { useCallback, useEffect, useRef, useState } from 'react';
import { AcousticSocket, LoopbackChannel, WebAudioChannel } from '@ghost-acoustics/core';
import type { LinkState, LoopbackBus } from '@ghost-acoustics/core';
import { Opcode } from '@ghost-acoustics/schema-compiler/generated/opcodes';
import {
  WHISPER_MSG_PAYLOAD_BYTES,
  packWhisperMsg,
  unpackWhisperMsg,
} from '@ghost-acoustics/schema-compiler/generated/serializers';
import { loadGgwave } from '../link/ggwaveLoader';
import type { SimulatedSpectrum } from '../components/spectrum';
import { clampToBytes, decodeText, encodeText, wireCost } from '../whisper/text';

export type DeliveryStatus = 'QUEUED' | 'TRANSMITTING' | 'DELIVERED' | 'FAILED';

export interface ChatMessage {
  readonly id: string;
  readonly direction: 'out' | 'in';
  /** Target node for outgoing messages, sender node for incoming ones. */
  readonly peer: number;
  readonly msgId: number;
  readonly text: string;
  readonly textBytes: number;
  readonly frameBytes: number;
  readonly estimatedSeconds: number;
  readonly at: number;
  // Outgoing delivery state.
  readonly status?: DeliveryStatus;
  /** While TRANSMITTING: speaker on the air, or waiting for the ACK to come back. */
  readonly phase?: 'airtime' | 'awaiting-ack';
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly txStartedAt?: number;
  readonly rttMs?: number | null;
  // Incoming receive details.
  readonly snrDb?: number | null;
  readonly measuredAirtime?: number | null;
}

export interface ArqMetrics {
  readonly sent: number;
  readonly delivered: number;
  readonly failed: number;
  /** Extra transmissions beyond the first, summed over all messages. */
  readonly retransmissions: number;
  readonly lastRttMs: number | null;
  readonly avgRttMs: number | null;
  /** SNR of the most recent frame (data or ACK) heard; null where the channel cannot tell. */
  readonly snrDb: number | null;
  readonly lastAirtime: { readonly kind: 'data' | 'ack'; readonly estimated: number; readonly measured: number } | null;
  /** Frames rejected for corruption (bad CRC, length or sync). */
  readonly corrupt: number;
}

const INITIAL_METRICS: ArqMetrics = {
  sent: 0,
  delivered: 0,
  failed: 0,
  retransmissions: 0,
  lastRttMs: null,
  avgRttMs: null,
  snrDb: null,
  lastAirtime: null,
  corrupt: 0,
};

export type NodeStatus = 'off' | 'starting' | 'ready' | 'error';

export interface NodeOptions {
  /** Unique label, used to key this node's simulated transmissions. */
  readonly name: string;
  /** When false the node stays inert (no socket is created). */
  readonly enabled: boolean;
  readonly nodeId: number;
  readonly targetId: number;
  readonly kind: 'live' | 'loopback';
  readonly bus: LoopbackBus;
  readonly spectrum: SimulatedSpectrum;
  /** Loopback only: percent (0..100) of received frames to drop. */
  readonly lossPercent: number;
  /** Live only: transmit volume 0..100. */
  readonly volume: number;
}

export interface WhisperNode {
  readonly status: NodeStatus;
  readonly linkState: LinkState;
  readonly messages: readonly ChatMessage[];
  readonly metrics: ArqMetrics;
  /** Spectrum tap, available once a live node is ready. */
  readonly analyser: AnalyserNode | null;
  readonly error: string | null;
  readonly warning: string | null;
  /** Opens the speaker and microphone (live). Call from a tap. */
  start(): Promise<void>;
  send(text: string): void;
}

function describeError(err: unknown): string {
  if (err instanceof DOMException && err.name === 'NotAllowedError') {
    return 'Microphone permission was denied. Allow it in the browser settings and try again.';
  }
  if (err instanceof DOMException && err.name === 'NotFoundError') return 'No microphone was found on this device.';
  if (!window.isSecureContext) return 'The microphone needs a secure (https) connection.';
  return err instanceof Error ? err.message : String(err);
}

export function useWhisperNode(options: NodeOptions): WhisperNode {
  const { name, nodeId, kind, bus, spectrum, enabled } = options;

  const socketRef = useRef<AcousticSocket | null>(null);
  const liveRef = useRef<WebAudioChannel | null>(null);
  const loopRef = useRef<LoopbackChannel | null>(null);
  const targetRef = useRef(options.targetId);
  const nodeIdRef = useRef(nodeId);
  const activeIdRef = useRef<string | null>(null);
  const counterRef = useRef(0);
  const rttStatsRef = useRef({ sum: 0, count: 0 });

  const [status, setStatus] = useState<NodeStatus>('off');
  const [linkState, setLinkState] = useState<LinkState>('IDLE');
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [metrics, setMetrics] = useState<ArqMetrics>(INITIAL_METRICS);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    targetRef.current = options.targetId;
  }, [options.targetId]);

  const patch = useCallback((id: string, changes: Partial<ChatMessage>) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...changes } : m)));
  }, []);

  // Build a fresh socket whenever the transport or this node's address changes.
  useEffect(() => {
    nodeIdRef.current = nodeId;
    activeIdRef.current = null;
    rttStatsRef.current = { sum: 0, count: 0 };
    setMessages([]);
    setMetrics(INITIAL_METRICS);
    setStatus('off');
    setLinkState('IDLE');
    setAnalyser(null);
    setError(null);
    setWarning(null);
    if (!enabled) return;

    let live: WebAudioChannel | null = null;
    let loop: LoopbackChannel | null = null;
    if (kind === 'live') {
      live = new WebAudioChannel({ ggwaveFactory: loadGgwave, onWarning: setWarning });
    } else {
      // simulateAirtime: the packet really takes its airtime, so the countdown and RTT are honest.
      loop = new LoopbackChannel({ bus, simulateAirtime: true });
    }
    liveRef.current = live;
    loopRef.current = loop;

    const socket = new AcousticSocket({
      peerId: `${name}-${nodeId}`,
      peerByte: nodeId,
      mode: kind,
      channel: (live ?? loop)!,
    });
    socketRef.current = socket;

    const off = [
      socket.on('state', (state) => {
        setLinkState(state);
        if (kind === 'loopback') spectrum.setTransmitting(name, state === 'TRANSMITTING');
      }),
      socket.on('airtime', (event) => {
        setMetrics((m) => ({ ...m, lastAirtime: { kind: event.kind, estimated: event.estimated, measured: event.measured } }));
        // The speaker has finished the data frame: now we are waiting for the receipt.
        if (event.kind === 'data' && activeIdRef.current) patch(activeIdRef.current, { phase: 'awaiting-ack' });
      }),
      socket.on('ack', ({ rx }) => {
        if (rx?.snrDb !== undefined) setMetrics((m) => ({ ...m, snrDb: rx.snrDb ?? null }));
      }),
      socket.on('drop', ({ reason }) => {
        if (reason === 'BadCrc' || reason === 'BadLength' || reason === 'BadSync') {
          setMetrics((m) => ({ ...m, corrupt: m.corrupt + 1 }));
        }
      }),
      socket.on('packet', (frame) => {
        if (frame.opcode !== Opcode.WHISPER_MSG) return;
        let decoded;
        try {
          decoded = unpackWhisperMsg(frame.payload, { senderId: 0, msgId: 0, text: new Uint8Array(0) });
        } catch {
          return; // malformed payload length
        }
        const cost = wireCost(decoded.text.length);
        const incoming: ChatMessage = {
          id: `in-${frame.receivedAtMs}-${frame.seq}`,
          direction: 'in',
          peer: decoded.senderId,
          msgId: decoded.msgId,
          text: decodeText(decoded.text),
          textBytes: decoded.text.length,
          frameBytes: cost.frameBytes,
          estimatedSeconds: cost.airtimeSeconds,
          at: frame.receivedAtMs,
          snrDb: frame.rx?.snrDb ?? null,
          measuredAirtime: frame.rx?.measuredAirtimeSeconds ?? null,
        };
        setMessages((prev) => [...prev, incoming]);
        if (frame.rx?.snrDb !== undefined) setMetrics((m) => ({ ...m, snrDb: frame.rx?.snrDb ?? null }));
      }),
    ];

    let disposed = false;
    let ready: Promise<void> | null = null;
    if (kind === 'loopback') {
      ready = socket.start().then(() => {
        if (!disposed) setStatus('ready');
      });
    }

    return () => {
      disposed = true;
      off.forEach((unsubscribe) => unsubscribe());
      spectrum.setTransmitting(name, false);
      socketRef.current = null;
      liveRef.current = null;
      loopRef.current = null;
      // Let an in-flight start() settle before stopping so nothing stays attached to the bus.
      void (ready ?? Promise.resolve()).catch(() => undefined).then(() => socket.stop());
    };
  }, [kind, nodeId, name, bus, spectrum, enabled, patch]);

  useEffect(() => {
    loopRef.current?.setLossRate(options.lossPercent / 100);
  }, [options.lossPercent, kind, nodeId]);

  useEffect(() => {
    liveRef.current?.setVolume(options.volume);
  }, [options.volume, kind, nodeId]);

  const start = useCallback(async () => {
    const socket = socketRef.current;
    if (!socket || socket.state !== 'IDLE') return;
    setStatus('starting');
    setError(null);
    try {
      await socket.start();
      if (socketRef.current !== socket) return;
      setAnalyser(socket.analyser);
      setStatus('ready');
    } catch (err) {
      if (socketRef.current === socket) {
        setError(describeError(err));
        setStatus('error');
      }
    }
  }, []);

  const send = useCallback(
    (raw: string) => {
      const socket = socketRef.current;
      const text = clampToBytes(raw.trim());
      if (!socket || text === '') return;

      const bytes = encodeText(text);
      const buffer = new Uint8Array(WHISPER_MSG_PAYLOAD_BYTES);
      counterRef.current = (counterRef.current + 1) & 0xff;
      const msgId = counterRef.current;
      const written = packWhisperMsg({ senderId: nodeIdRef.current, msgId, text: bytes }, buffer);
      const payload = buffer.slice(0, written);
      const cost = wireCost(bytes.length);
      const target = targetRef.current;
      const id = `out-${nodeIdRef.current}-${Date.now()}-${msgId}`;

      setMessages((prev) => [
        ...prev,
        {
          id,
          direction: 'out',
          peer: target,
          msgId,
          text,
          textBytes: bytes.length,
          frameBytes: cost.frameBytes,
          estimatedSeconds: cost.airtimeSeconds,
          at: Date.now(),
          status: 'QUEUED',
        },
      ]);

      const finish = (changes: Partial<ChatMessage>): void => {
        if (activeIdRef.current === id) activeIdRef.current = null;
        patch(id, { ...changes, phase: undefined });
      };

      socket
        .send(target, Opcode.WHISPER_MSG, payload, {
          onTransmit: (info) => {
            activeIdRef.current = id;
            patch(id, {
              status: 'TRANSMITTING',
              phase: 'airtime',
              attempt: info.attempt,
              maxAttempts: info.maxAttempts,
              txStartedAt: info.startedAt,
              estimatedSeconds: info.estimatedSeconds,
            });
          },
        })
        .then((result) => {
          finish({ status: result.delivered ? 'DELIVERED' : 'FAILED', rttMs: result.rttMs, attempt: result.attempts });
          setMetrics((m) => {
            const stats = rttStatsRef.current;
            if (result.rttMs !== null) {
              stats.sum += result.rttMs;
              stats.count += 1;
            }
            return {
              ...m,
              sent: m.sent + 1,
              delivered: m.delivered + (result.delivered ? 1 : 0),
              failed: m.failed + (result.delivered ? 0 : 1),
              retransmissions: m.retransmissions + (result.attempts - 1),
              lastRttMs: result.rttMs ?? m.lastRttMs,
              avgRttMs: stats.count > 0 ? stats.sum / stats.count : null,
            };
          });
        })
        .catch((err: unknown) => {
          finish({ status: 'FAILED' });
          setError(describeError(err));
        });
    },
    [patch],
  );

  return { status, linkState, messages, metrics, analyser, error, warning, start, send };
}
