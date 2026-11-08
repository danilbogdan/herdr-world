import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { HcRpcError, HcTransport, type HcProcess, type HcTransportOptions } from './transport';

const hello = {
  generation: 1, framed: false, version: '0.1.18', core: { id: 'synthetic-core', name: 'example' },
  methods: ['hello', 'terminal.list', 'events.subscribe'], features: ['events'],
};

class Fake extends EventEmitter implements HcProcess {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  helloResult = hello;
  requests: any[] = [];
  handler?: (request: any) => void;
  stdin = new Writable({ write: (chunk, _encoding, done) => {
    const request = JSON.parse(chunk.toString());
    this.requests.push(request);
    if (request.method === 'hello') this.reply(request.id, this.helloResult);
    else if (request.method === 'events.subscribe') this.reply(request.id, { terminals: [], seq: 0 });
    else this.handler?.(request);
    done();
  } });
  reply(id: number, result: unknown) { this.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
  kill() { this.killed = true; this.stdout.end(); this.stderr.end(); }
}

function setup(options: HcTransportOptions = {}) {
  const children: Fake[] = [];
  const transport = new HcTransport({
    events: false, timeoutMs: 200, ...options,
    spawn: () => { const child = new Fake(); children.push(child); return child; },
  });
  return { transport, children };
}

describe('HcTransport', () => {
  test('fragmented UTF-8 responses, multiple lines, wrong ID and concurrent correlation', async () => {
    const { transport, children } = setup();
    await transport.connect();
    const child = children[0]!;
    const first = transport.call('terminal.list');
    const second = transport.call('terminal.list');
    const [, a, b] = child.requests;
    child.reply(999, 'foreign');
    child.reply(b.id, 'second');
    const line = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: a.id, result: '🐑' }) + '\n');
    const at = line.indexOf(Buffer.from('🐑')) + 1;
    child.stdout.write(line.subarray(0, at));
    child.stdout.write(line.subarray(at));
    expect(await first).toBe('🐑');
    expect(await second).toBe('second');
    expect(transport.connected).toBe(true);
    transport.disconnect();
  });

  test('timeout retires ID, does not retry mutation, late reply cannot settle next request', async () => {
    const { transport, children } = setup();
    await transport.connect();
    const child = children[0]!;
    await expect(transport.call('terminal.send', { text: 'synthetic' }, 5)).rejects.toThrow('outcome unknown');
    const lateId = child.requests[1].id;
    const next = transport.call('terminal.list');
    child.reply(lateId, 'late');
    child.reply(child.requests[2].id, 'fresh');
    expect(await next).toBe('fresh');
    expect(child.requests.filter((r) => r.method === 'terminal.send')).toHaveLength(1);
    transport.disconnect();
  });

  test('disconnect rejects all pending calls and kills only owned transports', async () => {
    const { transport, children } = setup({ events: {} });
    await transport.connect();
    expect(children).toHaveLength(2);
    const first = transport.call('terminal.list');
    const second = transport.call('terminal.list');
    const rejected = Promise.allSettled([first, second]);
    transport.disconnect();
    expect((await rejected).every((r) => r.status === 'rejected' && r.reason.message.includes('disconnected'))).toBe(true);
    expect(transport.connected).toBe(false);
    expect(children.every((c) => c.killed)).toBe(true);
    expect(children.flatMap((c) => c.requests).some((r) => r.method === 'server.stop')).toBe(false);
    transport.disconnect();
  });

  test('events use a dedicated subscribed channel and preserve native notification params', async () => {
    const { transport, children } = setup({ events: { labels: { project: 'example' } } });
    const notifications: any[] = [];
    const handler = (params: any) => notifications.push(params);
    transport.on('event', () => { throw new Error('consumer'); }).on('event', handler);
    await transport.connect();
    const [control, events] = children;
    expect(control!.requests.map((r) => r.method)).toEqual(['hello']);
    expect(events!.requests.map((r) => r.method)).toEqual(['hello', 'events.subscribe']);
    expect(events!.requests[1].params).toEqual({ labels: { project: 'example' } });
    events!.stdout.write('{"jsonrpc":"2.0","method":"event","params":{"seq":9,"kind":"title"}}\n');
    expect(notifications).toEqual([{ seq: 9, kind: 'title' }]);
    transport.off('event', handler);
    events!.stdout.write('{"jsonrpc":"2.0","method":"event","params":{}}\n');
    expect(notifications).toHaveLength(1);
    const pending = transport.call('terminal.list');
    events!.emit('exit', 1);
    await expect(pending).rejects.toThrow('connection lost');
    expect(transport.connected).toBe(false);
    expect(control!.killed).toBe(true);
  });

  test('bounded pending and oversized inbound/outbound lines', async () => {
    const { transport, children } = setup({ maxPending: 1, maxLineBytes: 1024 });
    await transport.connect();
    await expect(transport.call('terminal.send', { text: 'x'.repeat(1100) })).rejects.toThrow('oversized');
    const first = transport.call('terminal.list');
    await expect(transport.call('terminal.list')).rejects.toThrow('pending limit');
    children[0]!.stdout.write('x'.repeat(1025));
    await expect(first).rejects.toThrow('Invalid hc protocol');
    expect(transport.connected).toBe(false);
  });

  test('sanitizes RPC errors and drains stderr without interpreting it', async () => {
    const { transport, children } = setup();
    await transport.connect();
    const child = children[0]!;
    child.stderr.write('synthetic private diagnostic\n');
    const pending = transport.call('ping');
    child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: child.requests[1].id,
      error: { code: -32601, message: 'private payload', data: { kind: 'unknown_method', secret: 'private' } } }) + '\n');
    try { await pending; throw new Error('expected rejection'); } catch (error) {
      expect(error).toBeInstanceOf(HcRpcError);
      expect((error as HcRpcError).kind).toBe('unknown_method');
      expect(String(error)).not.toContain('private');
    }
    transport.disconnect();
  });

  test('removes inherited caller even from explicit env; passes argv unchanged', async () => {
    const child = new Fake();
    let seen: NodeJS.ProcessEnv = {};
    let argv: readonly string[] = [];
    const transport = new HcTransport({ events: false, command: ['hc', 'connect', '--session', 'example'],
      env: { HC_TERMINAL_ID: 'synthetic-parent' },
      spawn: (command, env) => { argv = command; seen = env; return child; },
    });
    await transport.connect();
    expect(seen.HC_TERMINAL_ID).toBeUndefined();
    expect(argv).toEqual(['hc', 'connect', '--session', 'example']);
    for (const method of ['terminal.attach', 'hello', 'events.subscribe']) {
      await expect(transport.call(method)).rejects.toThrow('dedicated');
    }
    expect(child.requests).toHaveLength(1);
    transport.disconnect();
  });

  test('rejects incompatible generation and mismatched event core identity', async () => {
    const incompatible = new Fake();
    incompatible.helloResult = { ...hello, generation: 2 };
    const first = new HcTransport({ events: false, spawn: () => incompatible });
    await expect(first.connect()).rejects.toThrow('Unsupported hc handshake');
    expect(incompatible.killed).toBe(true);
    const children: Fake[] = [];
    const second = new HcTransport({ spawn: () => {
      const child = new Fake();
      if (children.length) child.helloResult = { ...hello, core: { id: 'other-core', name: 'example' } };
      children.push(child);
      return child;
    } });
    await expect(second.connect()).rejects.toThrow('identity mismatch');
    expect(children.every((c) => c.killed)).toBe(true);
    expect(second.connected).toBe(false);
  });

  test('EOF, malformed reply and spawn failure fail closed; reconnect starts fresh IDs', async () => {
    const { transport, children } = setup();
    const connect = transport.connect();
    expect(transport.connect()).toBe(connect);
    await connect;
    const first = transport.call('terminal.list');
    children[0]!.stdout.end();
    await expect(first).rejects.toThrow('connection lost');
    await transport.connect();
    expect(children[1]!.requests[0].id).toBeGreaterThan(children[0]!.requests[1].id);
    const next = transport.call('terminal.list');
    children[1]!.stdout.write('not json\n');
    await expect(next).rejects.toThrow('Invalid hc protocol');
    const broken = new HcTransport({ spawn: () => { throw new Error('spawn unavailable'); } });
    await expect(broken.connect()).rejects.toThrow('spawn unavailable');
    expect(broken.connected).toBe(false);
  });
});
