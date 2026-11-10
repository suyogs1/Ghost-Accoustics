import { encodeFrame } from '@ghost-acoustics/core';
import type { ReceivedFrame } from '@ghost-acoustics/core';
import { CRC_BYTES } from '@ghost-acoustics/core/constants';
import { Opcode, OPCODE_REGISTRY } from '@ghost-acoustics/schema-compiler/generated/opcodes';
import {
  EMERGENCY_BEACON_PAYLOAD_BYTES,
  VENUE_CUE_PAYLOAD_BYTES,
  unpackEmergencyBeacon,
  unpackVenueCue,
} from '@ghost-acoustics/schema-compiler/generated/serializers';
import type { EmergencyBeacon, VenueCue } from '@ghost-acoustics/schema-compiler/generated/types';

export interface RxTelemetry {
  /** Wall-clock arrival time (ms since epoch). */
  readonly arrivedAt: number;
  readonly estimatedAirtime: number;
  /** Receive-side measured airtime (signal onset to decode), when the channel can tell. */
  readonly measuredAirtime: number | null;
  readonly peakLevelDb: number | null;
  readonly frameBytes: number;
  /** CRC-32 carried by the frame. Frames only reach the app after the CRC matched. */
  readonly crc: string;
  readonly crcMatch: boolean;
  readonly src: number;
  readonly seq: number;
}

export type ReceivedEvent =
  | ({ readonly kind: 'cue'; readonly cue: VenueCue } & RxTelemetry)
  | ({ readonly kind: 'emergency'; readonly beacon: EmergencyBeacon } & RxTelemetry);

function telemetryFor(frame: ReceivedFrame, estimatedAirtime: number): RxTelemetry {
  // Re-encoding reproduces the exact wire bytes; the trailer is the CRC-32 that was verified.
  const wire = encodeFrame(frame, { enforceBudget: false });
  const crc = new DataView(wire.buffer).getUint32(wire.length - CRC_BYTES);
  return {
    arrivedAt: frame.receivedAtMs,
    estimatedAirtime,
    measuredAirtime: frame.rx?.measuredAirtimeSeconds ?? null,
    peakLevelDb: frame.rx?.peakLevelDb ?? null,
    frameBytes: wire.length,
    crc: `0x${crc.toString(16).toUpperCase().padStart(8, '0')}`,
    crcMatch: true,
    src: frame.src,
    seq: frame.seq,
  };
}

function estimateFor(opcode: number): number {
  return OPCODE_REGISTRY.find((info) => info.opcode === opcode)?.airtimeSeconds ?? 0;
}

/** Turns a verified frame into an app event; null for opcodes this app does not handle. */
export function decodeVenueFrame(frame: ReceivedFrame): ReceivedEvent | null {
  switch (frame.opcode) {
    case Opcode.VENUE_CUE: {
      if (frame.payload.length < VENUE_CUE_PAYLOAD_BYTES) return null;
      const cue = unpackVenueCue(frame.payload, { cueId: 0, stageState: 0, accentColor: 0 });
      return { kind: 'cue', cue, ...telemetryFor(frame, estimateFor(frame.opcode)) };
    }
    case Opcode.EMERGENCY_BEACON: {
      if (frame.payload.length < EMERGENCY_BEACON_PAYLOAD_BYTES) return null;
      const beacon = unpackEmergencyBeacon(frame.payload, { alertId: 0, severity: 0, batteryPct: 0 });
      return { kind: 'emergency', beacon, ...telemetryFor(frame, estimateFor(frame.opcode)) };
    }
    default:
      return null;
  }
}
