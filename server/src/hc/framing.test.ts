import { describe, expect, test } from "bun:test";
import { encodeFrame, FrameDecoder, Kind, MAX_PAYLOAD } from "./framing";

function decodeAll(frames: Buffer[], chunkSize = 3) {
  const seen: Array<[number, number, string]> = [];
  const decoder = new FrameDecoder((channel, kind, payload) =>
    seen.push([channel, kind, payload.toString("hex")]),
  );
  for (const frame of frames)
    for (let i = 0; i < frame.length; i += chunkSize)
      decoder.push(frame.subarray(i, i + chunkSize));
  decoder.end();
  return seen;
}

describe("hc generation-1 framing", () => {
  test("round-trips channel-0 JSON and raw terminal frames across arbitrary chunk splits", () => {
    const frames = [
      encodeFrame(0, Kind.DATA, Buffer.from('{"id":1}')),
      encodeFrame(7, Kind.DATA, Buffer.from("hi")),
      encodeFrame(7, Kind.RESIZE, Buffer.from([80, 0, 24, 0])),
    ];
    for (const chunkSize of [1, 2, 9, 4096]) {
      expect(decodeAll(frames, chunkSize)).toEqual([
        [0, Kind.DATA, "7b226964223a317d"],
        [7, Kind.DATA, "6869"],
        [7, Kind.RESIZE, "50001800"],
      ]);
    }
  });

  test("uses little-endian headers and rejects truncated or invalid frames", () => {
    const header = encodeFrame(0x01020304, Kind.DATA, Buffer.alloc(0)).subarray(0, 9);
    expect([...header.subarray(0, 4)]).toEqual([4, 3, 2, 1]);
    expect([...header.subarray(5, 9)]).toEqual([0, 0, 0, 0]);
    const truncated = new FrameDecoder(() => {});
    truncated.push(Buffer.from([1, 0, 0, 0, Kind.RESIZE, 4, 0, 0]));
    expect(() => truncated.end()).toThrow();
    expect(() => encodeFrame(0, Kind.DATA, Buffer.alloc(MAX_PAYLOAD + 1))).toThrow();
    expect(
      () => new FrameDecoder(() => {}).push(Buffer.from([0, 0, 0, 0, 99, 0, 0, 0, 0])),
    ).toThrow();
    expect(
      () => new FrameDecoder(() => {}).push(Buffer.from([1, 0, 0, 0, Kind.RESIZE, 2, 0, 0, 0, 1, 2])),
    ).toThrow();
  });
});
