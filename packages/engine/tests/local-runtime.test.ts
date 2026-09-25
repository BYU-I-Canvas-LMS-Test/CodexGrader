// The local-runtime seams that replaced the hosted infrastructure:
//   - LocalProgressStore: change-driven persistence of LIVE runs only
//     (heartbeats never touch disk; terminal + adopted records never persist)
//   - engine.adopt: opening a run this process never started (course-scoped)
//   - the approval capability on POST /runs/:id/approve (fail closed)
//   - StaticCredentialProvider: host routing + friendly not-configured errors

import { describe, expect, it } from 'vitest';
import express from 'express';
import type { RunProgressDoc } from '@aigrader/shared';
import { LocalProgressStore } from '../src/progress/progress-writer.js';
import { createRunRouter, APPROVAL_CAPABILITY_HEADER } from '../src/run-routes.js';
import {
  CredentialError,
  StaticCredentialProvider,
  tokenSha256,
} from '../src/credentials.js';
import {
  TEST_COURSE_KEY,
  buildEngine,
  makeGrade,
  makeProgressDoc,
  makeRunDoc,
} from './engine-helpers.js';
import { postJson, withServer } from './helpers.js';

function record(overrides: Partial<RunProgressDoc> = {}): RunProgressDoc {
  return makeProgressDoc(overrides);
}

describe('LocalProgressStore', () => {
  it('persists the live set when it changes, and not on heartbeat-only writes', async () => {
    const persisted: RunProgressDoc[][] = [];
    const store = new LocalProgressStore({ persist: (live) => void persisted.push(live) });

    await store.set('run1', record({ runId: 'run1', status: 'RUNNING' }));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.map((d) => d.runId)).toEqual(['run1']);

    // Heartbeat / counts only — same live signature ⇒ no disk write.
    await store.set(
      'run1',
      record({ runId: 'run1', status: 'RUNNING', worker: { owner: 'x', heartbeatAt: '2026-06-10T16:00:15.000Z', resumeCount: 0 } }),
    );
    expect(persisted).toHaveLength(1);

    // Status change ⇒ persisted again.
    await store.set('run1', record({ runId: 'run1', status: 'REVIEWING' }));
    expect(persisted).toHaveLength(2);

    // Terminal ⇒ dropped from the persisted live set.
    await store.set('run1', record({ runId: 'run1', status: 'COMPLETED' }));
    expect(persisted).toHaveLength(3);
    expect(persisted[2]).toEqual([]);
    // …but still readable in memory for the review page.
    expect((await store.get('run1'))?.status).toBe('COMPLETED');
  });

  it('never lists or persists ADOPTED records', async () => {
    const persisted: RunProgressDoc[][] = [];
    const store = new LocalProgressStore({ persist: (live) => void persisted.push(live) });

    await store.set('other', record({ runId: 'other', status: 'REVIEWING', adopted: true }));
    expect(await store.listLive()).toEqual([]);
    expect(persisted).toHaveLength(0);
    expect(await store.get('other')).not.toBeNull();
  });

  it('restores initial records and persists a cancel request', async () => {
    const persisted: RunProgressDoc[][] = [];
    const store = new LocalProgressStore({
      initial: [record({ runId: 'run1', status: 'RUNNING' })],
      persist: (live) => void persisted.push(live),
    });
    expect((await store.listLive()).map((d) => d.runId)).toEqual(['run1']);

    await store.requestCancel('run1');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]![0]!.cancelRequested).toBe(true);
  });
});

describe('engine.adopt', () => {
  it('loads a foreign run for ITS course and records an adopted progress record', async () => {
    const harness = buildEngine({});
    harness.runStore.docs.set(
      'foreign',
      makeRunDoc({
        runId: 'foreign',
        status: 'REVIEWING',
        grades: [makeGrade({ canvasUserId: 1, status: 'DRAFT' })],
        lock: { owner: 'other-laptop:abc', ownerName: 'Jane Roe', heartbeatUtc: '2026-06-10T15:00:00.000Z' },
      }),
    );

    const progress = await harness.engine.adopt('foreign', TEST_COURSE_KEY);
    expect(progress).toMatchObject({
      runId: 'foreign',
      courseKey: TEST_COURSE_KEY,
      status: 'REVIEWING',
      adopted: true,
      worker: { owner: 'other-laptop:abc' },
    });
    expect(progress.counts).toMatchObject({ total: 1, drafted: 1 });
    // Snapshot now works through the adopted record.
    expect((await harness.engine.getSnapshot('foreign')).runId).toBe('foreign');
    // Adopted ≠ live: the resume sweep leaves it alone.
    expect(await harness.progressStore.listLive()).toHaveLength(0);
  });

  it('refuses a runId from a different course', async () => {
    const harness = buildEngine({});
    harness.runStore.docs.set('foreign', makeRunDoc({ runId: 'foreign' }));
    await expect(
      harness.engine.adopt('foreign', 'school.instructure.com#999'),
    ).rejects.toMatchObject({ code: 'unknown_run' });
  });
});

describe('approval capability (POST /runs/:id/approve)', () => {
  function appWith(approvalCapability?: string) {
    const harness = buildEngine({});
    const app = express();
    app.use(express.json());
    app.use('/runs', createRunRouter({ engine: harness.engine, approvalCapability }));
    return app;
  }

  it('is DISABLED when no capability is configured (the MCP-facing app)', async () => {
    await withServer(appWith(undefined), async (base) => {
      const res = await postJson(base, '/runs/run1/approve', { all: true });
      expect(res.status).toBe(403);
      expect((res.body as { error: string }).error).toBe('approval_requires_browser');
    });
  });

  it('refuses a request without (or with the wrong) capability header', async () => {
    await withServer(appWith('s3cret-capability'), async (base) => {
      const missing = await postJson(base, '/runs/run1/approve', { all: true });
      expect(missing.status).toBe(403);

      const wrong = await fetch(`${base}/runs/run1/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [APPROVAL_CAPABILITY_HEADER]: 'guess' },
        body: JSON.stringify({ all: true }),
      });
      expect(wrong.status).toBe(403);
    });
  });

  it('passes the capability check when the exact capability is presented', async () => {
    await withServer(appWith('s3cret-capability'), async (base) => {
      const res = await fetch(`${base}/runs/run1/approve`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [APPROVAL_CAPABILITY_HEADER]: 's3cret-capability',
        },
        body: JSON.stringify({ all: true, approver: { canvasUserId: 9, name: 'Jane' } }),
      });
      // Past the gate — the (unknown) run then 404s from the engine itself.
      expect(res.status).toBe(404);
    });
  });
});

describe('StaticCredentialProvider', () => {
  it('routes by host, defaults to the primary, and normalizes base URLs', () => {
    const provider = new StaticCredentialProvider([
      { baseUrl: 'https://byui.instructure.com/', token: ' pat-1 ' },
      { baseUrl: 'byupw.instructure.com', token: 'pat-2' },
    ]);
    expect(provider.forHost(null)).toMatchObject({
      host: 'byui.instructure.com',
      baseUrl: 'https://byui.instructure.com',
      token: 'pat-1',
      tokenSha256: tokenSha256('pat-1'),
    });
    expect(provider.forHost('BYUPW.instructure.com').token).toBe('pat-2');
  });

  it('explains how to fix a missing token or an unconfigured instance', () => {
    expect(() => new StaticCredentialProvider([]).forHost(null)).toThrow(CredentialError);
    try {
      new StaticCredentialProvider([{ baseUrl: 'https://byui.instructure.com', token: 'x' }]).forHost(
        'other.instructure.com',
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialError);
      expect((err as CredentialError).code).toBe('unknown_host');
      expect((err as Error).message).toContain('CANVAS_BASE_URL_2');
    }
  });

  it('replace() swaps credentials atomically (token rotation without restart)', () => {
    const provider = new StaticCredentialProvider([{ baseUrl: 'https://byui.instructure.com', token: 'old' }]);
    provider.replace([{ baseUrl: 'https://byui.instructure.com', token: 'new' }]);
    expect(provider.forHost(null).token).toBe('new');
  });
});
