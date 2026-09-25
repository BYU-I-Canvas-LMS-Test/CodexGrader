// The per-token concurrency gate: bounded parallelism, idempotent release,
// and per-token registry isolation.
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Canvas\CanvasRequestGate.cs
// (SemaphoreSlim semantics).

import { describe, expect, it } from 'vitest';
import { CanvasGate, CanvasGateRegistry, DEFAULT_MAX_CONCURRENT_REQUESTS } from '../src/gate.js';

const tick = () => new Promise<void>((r) => setTimeout(r, 2));

describe('CanvasGate', () => {
  it('never allows more in-flight work than the limit', async () => {
    const gate = new CanvasGate(3);
    let inFlight = 0;
    let maxInFlight = 0;

    await Promise.all(
      Array.from({ length: 20 }, () =>
        gate.run(async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await tick();
          inFlight--;
        }),
      ),
    );

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBe(3); // it saturates the window, not just under it
    expect(gate.active).toBe(0);
    expect(gate.pending).toBe(0);
  });

  it('defaults to 6 concurrent requests and floors misconfigured limits at 1', () => {
    expect(new CanvasGate().limit).toBe(DEFAULT_MAX_CONCURRENT_REQUESTS);
    expect(new CanvasGate().limit).toBe(6);
    expect(new CanvasGate(0).limit).toBe(1);
    expect(new CanvasGate(-4).limit).toBe(1);
    expect(new CanvasGate(Number.NaN).limit).toBe(1);
  });

  it('release is idempotent — double release never over-frees the semaphore', async () => {
    const gate = new CanvasGate(1);
    const release = await gate.acquire();
    release();
    release(); // no-op
    expect(gate.active).toBe(0);

    // Still strictly serialized after the double release.
    let inFlight = 0;
    let maxInFlight = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        gate.run(async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await tick();
          inFlight--;
        }),
      ),
    );
    expect(maxInFlight).toBe(1);
  });

  it('releases the slot when the gated function throws', async () => {
    const gate = new CanvasGate(1);
    await expect(gate.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(gate.active).toBe(0);
    await expect(gate.run(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('CanvasGateRegistry', () => {
  it('returns the same gate for the same token hash and distinct gates per token', () => {
    const registry = new CanvasGateRegistry(4);
    const a1 = registry.gateFor('hash-a');
    const a2 = registry.gateFor('hash-a');
    const b = registry.gateFor('hash-b');

    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1.limit).toBe(4);
    expect(registry.size).toBe(2);
  });
});
