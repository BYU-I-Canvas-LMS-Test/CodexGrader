// The control channel: a named pipe (Windows) or Unix socket (macOS/Linux)
// speaking newline-delimited JSON. It is also the SINGLE-INSTANCE LOCK —
// only one process can listen on the endpoint, so a second `aigrader serve`
// finds the first instead of starting a rival engine (two engines could
// post the same grade twice).
//
// Every connection must open with {op:"hello", key} where key is the
// per-start secret in ~/.aigrader/state/control.key (readable only by the
// teacher's account). That keeps other accounts on a shared computer out
// even where the OS pipe permissions are looser than a private file.
//
// Ops (Phase 2): hello, status, open {path?}, stop. The MCP shim (Phase 5)
// rides the same channel.

import { chmodSync, readFileSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { timingSafeEqual } from 'node:crypto';

export interface ControlRequest {
  id?: number;
  op: string;
  [field: string]: unknown;
}

export interface ControlResponse {
  ok: boolean;
  error?: string;
  message?: string;
  [field: string]: unknown;
}

export type ControlHandler = (request: ControlRequest) => Promise<ControlResponse> | ControlResponse;

export class AlreadyRunningError extends Error {
  constructor(readonly endpoint: string) {
    super('The AI Grader server is already running.');
    this.name = 'AlreadyRunningError';
  }
}

export interface ControlServer {
  readonly endpoint: string;
  /** Authenticated connections currently open (MCP shims, CLI calls). */
  readonly connections: number;
  close(): Promise<void>;
}

const MAX_LINE_BYTES = 1024 * 1024;

export async function listenControl(opts: {
  endpoint: string;
  key: () => string;
  handler: ControlHandler;
  onConnectionsChange?: (count: number) => void;
}): Promise<ControlServer> {
  let connections = 0;
  const sockets = new Set<Socket>();

  const server = createServer((socket) => {
    sockets.add(socket);
    let authed = false;
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    const send = (msg: ControlResponse) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(msg)}\n`);
    };
    socket.on('error', () => undefined);
    socket.on('close', () => {
      sockets.delete(socket);
      if (authed) {
        connections--;
        opts.onConnectionsChange?.(connections);
      }
    });
    lines.on('line', (line) => {
      if (line.length > MAX_LINE_BYTES) {
        socket.destroy();
        return;
      }
      let request: ControlRequest;
      try {
        request = JSON.parse(line) as ControlRequest;
      } catch {
        send({ ok: false, error: 'bad_request' });
        return;
      }
      if (!authed) {
        if (request.op !== 'hello' || typeof request.key !== 'string' || !sameSecret(request.key, opts.key())) {
          send({ id: request.id, ok: false, error: 'unauthorized' });
          socket.end();
          return;
        }
        authed = true;
        connections++;
        opts.onConnectionsChange?.(connections);
      }
      void Promise.resolve()
        .then(() => opts.handler(request))
        .then(
          (response) => send({ ...response, id: request.id }),
          (err: unknown) =>
            send({
              id: request.id,
              ok: false,
              error: 'failed',
              message: err instanceof Error ? err.message : String(err),
            }),
        );
    });
  });

  await bind(server, opts.endpoint);
  if (process.platform !== 'win32') {
    try {
      chmodSync(opts.endpoint, 0o600);
    } catch {
      // the private state dir already fences it
    }
  }

  return {
    endpoint: opts.endpoint,
    get connections() {
      return connections;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          if (process.platform !== 'win32') rmSync(opts.endpoint, { force: true });
          resolve();
        });
      }),
  };
}

async function bind(server: Server, endpoint: string): Promise<void> {
  try {
    await listenOnce(server, endpoint);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
  }
  // Windows named pipes vanish with their owner: in use ⇒ a live server.
  if (process.platform === 'win32' || (await isAlive(endpoint))) {
    throw new AlreadyRunningError(endpoint);
  }
  // A Unix socket file left by a crashed server: remove it and retry once.
  rmSync(endpoint, { force: true });
  await listenOnce(server, endpoint);
}

function listenOnce(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(endpoint);
  });
}

function isAlive(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(endpoint);
    const done = (alive: boolean) => {
      socket.destroy();
      resolve(alive);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// --------------------------------------------------------------- client --

export interface ControlClient {
  request(op: string, fields?: Record<string, unknown>): Promise<ControlResponse>;
  close(): void;
}

export class ControlUnavailableError extends Error {
  constructor(message = 'The AI Grader server is not running.') {
    super(message);
    this.name = 'ControlUnavailableError';
  }
}

/** Connects and authenticates (hello). Throws ControlUnavailableError when
 * no server is listening or the key is unreadable. */
export async function connectControl(opts: {
  endpoint: string;
  keyFile: string;
  timeoutMs?: number;
}): Promise<ControlClient & { hello: ControlResponse }> {
  let key: string;
  try {
    key = readFileSync(opts.keyFile, 'utf8').trim();
  } catch {
    throw new ControlUnavailableError();
  }
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = createConnection(opts.endpoint);
    s.once('connect', () => resolve(s));
    s.once('error', () => reject(new ControlUnavailableError()));
  });
  socket.on('error', () => undefined);

  let nextId = 1;
  const pending = new Map<number, (r: ControlResponse) => void>();
  const lines = createInterface({ input: socket, crlfDelay: Infinity });
  lines.on('line', (line) => {
    try {
      const msg = JSON.parse(line) as ControlResponse & { id?: number };
      const resolve = msg.id != null ? pending.get(msg.id) : undefined;
      if (resolve && msg.id != null) {
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch {
      // ignore garbage
    }
  });
  socket.on('close', () => {
    for (const resolve of pending.values()) resolve({ ok: false, error: 'closed' });
    pending.clear();
  });

  const request = (op: string, fields: Record<string, unknown> = {}) =>
    new Promise<ControlResponse>((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, error: 'timeout' });
      }, opts.timeoutMs ?? 15_000);
      timer.unref?.();
      pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      socket.write(`${JSON.stringify({ ...fields, id, op })}\n`);
    });

  const hello = await request('hello', { key });
  if (!hello.ok) {
    socket.destroy();
    throw new ControlUnavailableError(
      hello.error === 'unauthorized'
        ? 'The AI Grader server did not accept this connection.'
        : 'The AI Grader server is not responding.',
    );
  }
  return { hello, request, close: () => socket.end() };
}
