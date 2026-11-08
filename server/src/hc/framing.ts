/** hc generation 1 framing; unrelated to legacy Herdr/bincode framing. */
export const MAX_PAYLOAD = 16 * 1024 * 1024;
export const INITIAL_CREDIT = 256 * 1024;
export const Kind = { DATA: 0, CREDIT: 1, CLOSE: 2, RESIZE: 3, FOCUS: 4, FACTS: 5, AUTOMATIC_INPUT: 6 } as const;

export function encodeFrame(channel: number, kind: number, payload: Uint8Array): Buffer {
  if (!Number.isInteger(channel) || channel < 0 || channel > 0xffffffff || payload.length > MAX_PAYLOAD) {
    throw new Error('Invalid hc frame');
  }
  const result = Buffer.allocUnsafe(9 + payload.length);
  result.writeUInt32LE(channel, 0);
  result[4] = kind;
  result.writeUInt32LE(payload.length, 5);
  result.set(payload, 9);
  return result;
}

/** At most one bounded payload is retained, regardless of transport chunk size. */
export class FrameDecoder {
  private header = Buffer.alloc(9);
  private headerBytes = 0;
  private payload: Buffer | undefined;
  private payloadBytes = 0;
  private channel = 0;
  private kind = 0;

  constructor(private readonly receive: (channel: number, kind: number, payload: Buffer) => void) {}

  push(chunk: Uint8Array): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.payload) {
        const count = Math.min(9 - this.headerBytes, chunk.length - offset);
        this.header.set(chunk.subarray(offset, offset + count), this.headerBytes);
        offset += count;
        this.headerBytes += count;
        if (this.headerBytes !== 9) continue;
        this.channel = this.header.readUInt32LE(0);
        this.kind = this.header[4];
        const size = this.header.readUInt32LE(5);
        if (size > MAX_PAYLOAD || (this.channel === 0 && size > 64 * 1024)) throw new Error('Oversized hc frame');
        if (this.kind > Kind.AUTOMATIC_INPUT) throw new Error('Unknown hc frame kind');
        if ((this.kind === Kind.CREDIT || this.kind === Kind.RESIZE) && size !== 4) throw new Error('Invalid hc frame shape');
        if (this.kind === Kind.FOCUS && size !== 1) throw new Error('Invalid hc focus frame');
        this.payload = Buffer.allocUnsafe(size);
      }
      const count = Math.min(this.payload.length - this.payloadBytes, chunk.length - offset);
      this.payload.set(chunk.subarray(offset, offset + count), this.payloadBytes);
      this.payloadBytes += count;
      offset += count;
      if (this.payloadBytes !== this.payload.length) continue;
      const payload = this.payload;
      this.payload = undefined;
      this.payloadBytes = 0;
      this.headerBytes = 0;
      this.receive(this.channel, this.kind, payload);
    }
  }

  end(): void {
    if (this.headerBytes || this.payload) throw new Error('Truncated hc frame');
  }
}
