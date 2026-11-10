# Audio Hardware Guards

Browser voice processing destroys data-bearing audio. These rules are mandatory in every code path that touches the microphone or speaker.

## getUserMedia constraints

Every `getUserMedia` call MUST set all three flags explicitly to `false`:

```ts
const constraints: MediaStreamConstraints = {
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  },
  video: false,
};
```

- Never rely on browser defaults. Never omit a flag.
- After acquiring the stream, read `track.getSettings()` and log a warning if any of the three flags is still `true`. Some browsers ignore constraints.
- Do not insert voice-oriented filters (compressors, gates, high-pass) in the audible receive chain.
- The one exception is the ultrasound (`silent-ghost`) profile, which cascades two high-pass `BiquadFilterNode`s at 14 kHz to reject room noise. The cutoff must stay below the lowest data tone (about 15.0 kHz); never raise it into the carrier band.

## Transmission profiles

- Profiles are defined in `packages/core/src/profile.ts`; carrier bands there were measured from the encoder, not assumed.
- Sender and receiver must select the same profile. An ultrasound receiver filters out audible frames.
- The haunted-atmosphere mask must stay below the data tones (300-800 Hz), must start and stop with the data, and must fade out inside the half-duplex drain window so it never outlasts the muted-input period.

## Half-duplex discipline

The device hears its own speaker, so it must never transmit and decode at the same time.

- The transport is a half-duplex state machine: `IDLE -> LISTENING -> TRANSMITTING -> DRAINING -> LISTENING`.
- While `TRANSMITTING`, the decoder input is gated off and its buffers are discarded.
- After the last sample plays, enter `DRAINING` and wait for a guard interval before re-enabling the decoder. Guard = 150 ms clearance (`DRAIN_CLEARANCE_MS`) + output latency (`AudioContext.outputLatency` or `baseLatency`).
- Playback completion is detected from the `ended` event of the source node, never from a timer estimate alone.
- Any frame decoded during `TRANSMITTING` or `DRAINING` is dropped and counted as a self-interference event.

## Other guards

- Audio capture starts only from a user gesture (autoplay policy).
- Match the `AudioContext` sample rate to the ggwave instance (`sampleRateInp` and `sampleRateOut`).
- Keep transmit volume moderate. Clipping adds harmonics that break decoding.
