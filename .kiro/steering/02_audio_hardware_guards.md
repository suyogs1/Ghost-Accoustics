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
- Do not insert voice-oriented filters (compressors, gates, high-pass) in the receive chain.

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
