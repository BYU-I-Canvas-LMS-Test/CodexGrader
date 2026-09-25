// Per-token concurrency limiter for Canvas API traffic.
//
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Canvas\CanvasRequestGate.cs
// (SemaphoreSlim gate, app-wide singleton in the C# app). Canvas rate-limits
// PER TOKEN, so there is one gate per token (a teacher with a second Canvas
// instance in their .env has two), resolved through CanvasGateRegistry
// (tokenHash → gate) inside the single local server process.
//
// Why a small window: Canvas implements a leaky-bucket throttle (high-water
// ~700 units) where each in-flight request "reserves" ~50 units that are
// mostly refunded when it completes. Many PARALLEL requests trip the limiter
// even when total volume is modest; serializing down to a small concurrency
// window (default 6) keeps a 100-student grading run safely under the limit.
// The client's reactive backoff (429/5xx retry, X-Rate-Limit-Remaining pause)
// is the belt-and-suspenders half of this strategy.

export const DEFAULT_MAX_CONCURRENT_REQUESTS = 6;

/**
 * Bounds the number of simultaneous Canvas API requests made with one token.
 * Callers may size it from an env var (e.g. CANVAS_MAX_CONCURRENT_REQUESTS) —
 * the gate itself reads no environment.
 */
export class CanvasGate {
  private readonly maxConcurrent: number;
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number = DEFAULT_MAX_CONCURRENT_REQUESTS) {
    // Mirrors the C# Math.Max(1, …) floor: a misconfigured limit degrades to
    // fully-serialized traffic, never to an unbounded gate.
    this.maxConcurrent = Math.max(1, Math.floor(limit) || 1);
  }

  /** The configured concurrency window. */
  get limit(): number {
    return this.maxConcurrent;
  }

  /** Requests currently holding a slot (diagnostics/tests). */
  get active(): number {
    return this.inFlight;
  }

  /** Requests currently waiting for a slot (diagnostics/tests). */
  get pending(): number {
    return this.waiters.length;
  }

  /**
   * Acquires a slot; call the returned function to release it. The release
   * function is idempotent (mirrors the C# Releaser's Interlocked.Exchange —
   * double-dispose never over-releases the semaphore).
   */
  async acquire(): Promise<() => void> {
    await new Promise<void>((resolve) => {
      if (this.inFlight < this.maxConcurrent) {
        this.inFlight++;
        resolve();
      } else {
        this.waiters.push(() => {
          this.inFlight++;
          resolve();
        });
      }
    });

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  /** Runs `fn` while holding a slot, releasing it on completion or throw. */
  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private release(): void {
    this.inFlight--;
    const next = this.waiters.shift();
    if (next) next();
  }
}

/**
 * Maps tokenHash → CanvasGate so one process gates each Canvas token
 * independently (each token has its own leaky bucket on Canvas's side).
 * Register as a singleton in the engine.
 */
export class CanvasGateRegistry {
  private readonly gates = new Map<string, CanvasGate>();
  private readonly limit: number;

  constructor(limit: number = DEFAULT_MAX_CONCURRENT_REQUESTS) {
    this.limit = limit;
  }

  /** The gate for a token (by its hash — never key by the raw token). */
  gateFor(tokenHash: string): CanvasGate {
    let gate = this.gates.get(tokenHash);
    if (!gate) {
      gate = new CanvasGate(this.limit);
      this.gates.set(tokenHash, gate);
    }
    return gate;
  }

  get size(): number {
    return this.gates.size;
  }
}
