# Spec 01: Binary Frame Packing

Requirements use EARS syntax. "The framer" is the frame encode/decode module in `packages/core` (`src/frame.ts`). Constants live in `packages/core/src/constants.ts`.

## Frame layout (MTU = 64 bytes)

All multi-byte fields are big-endian.

| Offset | Size | Field    | Notes                                  |
|-------:|-----:|----------|----------------------------------------|
| 0      | 2    | sync     | Constant `0xAA55`                      |
| 2      | 1    | src      | Sender peer byte, 1-255                |
| 3      | 1    | dst      | Target peer byte, `0x00` = broadcast   |
| 4      | 1    | seq      | Sequence number, wraps at 256          |
| 5      | 1    | flags    | bit0 ACK, bit1 NACK, bit2 BROADCAST, bit3 ENCRYPTED, bit4-7 reserved (0) |
| 6      | 1    | opcode   | 1-byte opcode                          |
| 7      | 1    | length   | Payload length N, 0-52                 |
| 8      | N    | payload  | Bit-packed message body                |
| 8+N    | 4    | crc32    | CRC-32 over bytes `[0, 8+N)`           |

Header is 8 bytes, trailer is 4 bytes, so max payload = 64 - 12 = 52 bytes.

Peer IDs are strings in the API and map to one wire byte (FNV-1a, result in 1..255). Two peers whose IDs collide on the same byte cannot be told apart; the socket refuses to address a peer that collides with itself.

## Requirements

### Framing

1. THE framer SHALL emit frames whose total length is at most 64 bytes.
2. THE framer SHALL write the sync word `0xAA55` as the first two bytes of every frame.
3. WHEN a payload longer than 52 bytes is supplied, THE framer SHALL reject it with a `PayloadTooLarge` error.
4. THE framer SHALL encode the payload length in the `length` field and SHALL NOT pad frames.
5. WHEN a reserved flag bit is set or any header field is not a byte, THE framer SHALL reject the frame with an `InvalidField` error.

### Airtime budget

6. WHEN a frame is intended as a single-frame datagram and its total length exceeds 32 bytes, THE framer SHALL reject it with a `BudgetExceeded` error.
7. WHEN the estimated airtime of a single-frame datagram exceeds 4.0 seconds, THE framer SHALL reject it with a `BudgetExceeded` error.
8. THE airtime estimate SHALL be `frame_bytes * 8 / bitrate_bps` with a baseline of 64 bps (8 bytes/second).

### Opcodes

9. THE framer SHALL represent every opcode as exactly one byte.
10. THE framer SHALL reserve opcodes `0x00-0x0F` for the core protocol (`0x01` ACK, `0x02` NACK, `0x03` PING) and `0x10-0xFF` for applications.
11. IF a decoded opcode is not registered, THEN THE receiver SHALL surface the frame and SHALL NOT silently discard it.

### Decoding and CRC

12. WHEN bytes are received, THE decoder SHALL check that the first two bytes equal `0xAA55` before any other parsing.
13. IF the sync word does not match, THEN THE decoder SHALL drop the frame as `BadSync`.
14. IF the received length is below 12 or above 64, THEN THE decoder SHALL drop the frame as `BadLength`.
15. IF the `length` field does not equal `total - 12`, THEN THE decoder SHALL drop the frame as `BadLength`.
16. THE decoder SHALL compute CRC-32 (IEEE 802.3, reflected polynomial `0xEDB88320`, init `0xFFFFFFFF`, final XOR `0xFFFFFFFF`) over all bytes preceding the trailer.
17. IF the computed CRC-32 differs from the received trailer, THEN THE decoder SHALL drop the frame as `BadCrc` and SHALL NOT deliver the payload.
18. WHEN a frame passes sync, length and CRC checks, THE decoder SHALL deliver `{ src, dst, seq, flags, opcode, payload }`.
19. THE decoder SHALL NOT throw on any input; it SHALL return a typed result.

### Addressing

20. WHEN a frame's `dst` is neither `0x00` nor the local peer byte, THE socket SHALL ignore it.
21. WHEN a frame's `src` equals the local peer byte, THE socket SHALL ignore it.

### ARQ interaction

22. WHEN a unicast data frame is received, THE socket SHALL reply with an ACK (flag ACK, opcode `0x01`, same `seq`, empty payload) after a turnaround delay at least as long as the sender's drain window.
23. WHILE a frame is awaiting ACK, THE socket SHALL NOT send another data frame (Stop-and-Wait).
24. IF no ACK arrives within the ACK window, THEN THE socket SHALL resend the frame with the same `seq`, up to the configured retry limit, and SHALL then report `delivered: false`.
25. WHEN a data frame with the same `src` and `seq` is received again within the dedup window, THE socket SHALL re-ACK it and SHALL NOT deliver it a second time.
26. WHILE the BROADCAST flag is set, THE socket SHALL NOT request or expect an ACK.

## Reference vector

A frame with src `0x01`, dst `0x00`, seq `0x00`, flags `0x04`, opcode `0x10` and the 5-byte payload `"GHOST"` is 8 + 5 + 4 = 17 bytes, or 2.125 s at 64 bps. The `VENUE_CUE` and `EMERGENCY_BEACON` messages (4-byte payloads) are 16 bytes, or 2.0 s.
