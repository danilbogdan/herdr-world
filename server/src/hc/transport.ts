import { spawn as spawnProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

/** Minimal process seam; fake duplex streams need no real hc or user state. */
export interface HcProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  on(event: 'error' | 'exit', callback: (...args: any[]) => void): this;
  kill(): unknown;
}

export interface HcTransportOptions {
  /** Complete argv, e.g. ['hc', 'connect', '--session', 'example']. No shell. */
  command?: readonly string[];
  env?: NodeJS.ProcessEnv;
  spawn?: (command: readonly string[], env: NodeJS.ProcessEnv) => HcProcess;
  /** Subscribe on one dedicated connection by default; false disables events. */
  events?: false | Record<string, unknown>;
  timeoutMs?: number;
  maxPending?: number;
  maxLineBytes?: number;
}

export interface HcHello {
  generation: number;
  framed: boolean;
  version: string;
  core: { id: string; name: string };
  methods: string[];
  features: string[];
}

export class HcRpcError extends Error {
  constructor(
    public readonly code: number,
    public readonly kind?: string,
  ) {
    // Remote messages/data can include user payloads. Keep only stable error metadata.
    super(`hc RPC failed (${code})`);
    this.name = 'HcRpcError';
  }
}

type Pending = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type Channel = {
  process: HcProcess;
  pending: Map<number, Pending>;
  buffer: Buffer;
  closed: boolean;
};

/** Generation-1 JSON control only. No reconnection or automatic mutation retries. */
export class HcTransport {
  private readonly options: Required<Pick<HcTransportOptions, 'timeoutMs' | 'maxPending' | 'maxLineBytes'>> & HcTransportOptions;
  private readonly listeners = new Map<string, Set<(params: any) => void>>();
  private channels = new Set<Channel>();
  private control?: Channel;
  private ready = false;
  private connecting?: Promise<void>;
  private nextId = 1;
  private metadata?: HcHello;

  constructor(options: HcTransportOptions = {}) {
    this.options = { timeoutMs: 10_000, maxPending: 128, maxLineBytes: 8 * 1024 * 1024, ...options };
    for (const n of [this.options.timeoutMs, this.options.maxPending, this.options.maxLineBytes]) {
      if (!Number.isSafeInteger(n) || n < 1) throw new Error('Invalid hc transport limit');
    }
    if (options.command && (!options.command.length || options.command.some((s) => !s))) {
      throw new Error('Invalid hc command argv');
    }
  }

  get connected(): boolean { return this.ready; }
  /** Handshake metadata from the current control connection only. */
  get hello(): HcHello | undefined { return this.metadata; }

  connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.ready) return Promise.resolve();
    const attempt = this.open();
    this.connecting = attempt;
    void attempt.finally(() => {
      if (this.connecting === attempt) this.connecting = undefined;
    }).catch(() => {});
    return attempt;
  }

  private async open(): Promise<void> {
    try {
      const control = this.createChannel();
      this.control = control;
      const hello = await this.handshake(control);
      if (this.options.events !== false) {
        if (!hello.methods.includes('events.subscribe')) throw new Error('hc events unsupported');
        const events = this.createChannel();
        const eventHello = await this.handshake(events);
        if (eventHello.core.id !== hello.core.id) throw new Error('hc event core identity mismatch');
        await this.request(events, 'events.subscribe', this.options.events ?? {});
      }
      if (control.closed) throw new Error('hc disconnected during handshake');
      this.metadata = hello;
      this.ready = true;
    } catch (error) {
      this.stop(new Error('hc connection failed'));
      throw error;
    }
  }

  private async handshake(channel: Channel): Promise<HcHello> {
    const hello = await this.request(channel, 'hello', { generation: 1, framed: false }) as HcHello;
    if (!hello || hello.generation !== 1 || hello.framed !== false ||
      typeof hello.core?.id !== 'string' || !Array.isArray(hello.methods) ||
      !hello.methods.every((m) => typeof m === 'string')) {
      throw new Error('Unsupported hc handshake');
    }
    return hello;
  }

  async call<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = this.options.timeoutMs): Promise<T> {
    // hello could switch framing; subscribe consumes a plain connection permanently.
    if (['terminal.attach', 'hello', 'events.subscribe'].includes(method)) {
      throw new Error('hc method requires a dedicated stream/handshake seam');
    }
    if (!this.ready || !this.control) throw new Error('hc not connected');
    return this.request(this.control, method, params, timeoutMs);
  }

  on(event: string, callback: (params: any) => void): this {
    let callbacks = this.listeners.get(event);
    if (!callbacks) this.listeners.set(event, callbacks = new Set());
    callbacks.add(callback);
    return this;
  }

  off(event: string, callback: (params: any) => void): this {
    this.listeners.get(event)?.delete(callback);
    return this;
  }

  disconnect(): void { this.stop(new Error('hc disconnected')); }

  private emit(event: string, params: unknown): void {
    for (const callback of [...(this.listeners.get(event) ?? [])]) {
      // A consumer must not kill the reader or strand pending requests.
      try { callback(params); } catch { /* consumer owns its exception reporting */ }
    }
  }

  private createChannel(): Channel {
    const env = { ...process.env, ...this.options.env };
    delete env.HC_TERMINAL_ID;
    const command = this.options.command ?? ['hc', 'connect'];
    const child = this.options.spawn
      ? this.options.spawn(command, env)
      : spawnProcess(command[0]!, command.slice(1), { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const channel: Channel = { process: child, pending: new Map(), buffer: Buffer.alloc(0), closed: false };
    this.channels.add(channel);
    const failed = () => { if (!channel.closed) this.stop(new Error('hc connection lost')); };
    child.on('error', failed);
    child.on('exit', failed);
    child.stdin.on('error', failed);
    child.stdout.on('error', failed);
    child.stdout.on('end', failed);
    child.stdout.on('close', failed);
    child.stderr.on('error', failed);
    // Drain without retaining or logging diagnostics (which may contain private data).
    child.stderr.on('data', () => {});
    child.stdout.on('data', (data: Buffer) => {
      if (channel.closed) return;
      try { this.receive(channel, Buffer.from(data)); } catch { this.stop(new Error('Invalid hc protocol')); }
    });
    return channel;
  }

  private request(channel: Channel, method: string, params: Record<string, unknown>, timeoutMs = this.options.timeoutMs): Promise<any> {
    if (channel.closed) return Promise.reject(new Error('hc disconnected'));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return Promise.reject(new Error('Invalid hc timeout'));
    if (channel.pending.size >= this.options.maxPending) return Promise.reject(new Error('hc pending limit reached'));
    const id = this.nextId++;
    let line: string;
    try {
      line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      if (Buffer.byteLength(line) - 1 > this.options.maxLineBytes) throw new Error();
    } catch { return Promise.reject(new Error('Invalid or oversized hc request')); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        channel.pending.delete(id);
        reject(new Error('hc request timed out; outcome unknown, not retried'));
      }, timeoutMs);
      channel.pending.set(id, { resolve, reject, timer });
      // Never buffer more writes while the child is backpressured: fail closed.
      try {
        if (!channel.process.stdin.write(line)) this.stop(new Error('hc write backpressure; outcome unknown'));
      } catch { this.stop(new Error('hc write failed; outcome unknown')); }
    });
  }

  private receive(channel: Channel, data: Buffer): void {
    // Split before concatenation: a chunk can contain many individually bounded lines.
    let start = 0;
    while (start < data.length) {
      const newline = data.indexOf(10, start);
      const end = newline < 0 ? data.length : newline;
      const piece = data.subarray(start, end);
      if (channel.buffer.length + piece.length > this.options.maxLineBytes) throw new Error();
      channel.buffer = Buffer.concat([channel.buffer, piece]);
      if (newline < 0) return;
      const line = channel.buffer;
      channel.buffer = Buffer.alloc(0);
      if (line.length) this.message(channel, JSON.parse(line.toString('utf8')));
      if (channel.closed) return;
      start = newline + 1;
    }
  }

  private message(channel: Channel, message: any): void {
    if (!message || message.jsonrpc !== '2.0') throw new Error();
    if (Object.hasOwn(message, 'id')) {
      const pending = channel.pending.get(message.id);
      // Late or foreign ids can never settle another request.
      if (!pending) return;
      if (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')) throw new Error();
      channel.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (Object.hasOwn(message, 'error')) {
        const code = message.error?.code;
        const kind = message.error?.data?.kind;
        pending.reject(new HcRpcError(
          Number.isInteger(code) ? code : -32603,
          typeof kind === 'string' && /^[a-z_]{1,64}$/.test(kind) ? kind : undefined,
        ));
      } else pending.resolve(message.result);
    } else if (typeof message.method === 'string') {
      this.emit(message.method, message.params);
    } else throw new Error();
  }

  private stop(error: Error): void {
    const hadChannels = this.channels.size > 0;
    this.ready = false;
    this.metadata = undefined;
    this.control = undefined;
    const channels = [...this.channels];
    this.channels.clear();
    for (const channel of channels) {
      channel.closed = true;
      channel.buffer = Buffer.alloc(0);
      for (const pending of channel.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      channel.pending.clear();
      try { channel.process.stdin.destroy(); } catch { /* already closed */ }
      try { channel.process.kill(); } catch { /* already exited */ }
    }
    if (hadChannels) this.emit('disconnect', { reason: error.message });
  }
}
