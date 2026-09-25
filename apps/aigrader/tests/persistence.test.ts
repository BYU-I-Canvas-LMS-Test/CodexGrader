// ~/.aigrader persistence: atomic state files, the active-runs list, the
// fsynced post ledger (survives a restart; ids only), and the audit JSONL.

import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunProgressDoc } from '@aigrader/shared';
import { createJsonlAuditSink, pruneAudit } from '../src/audit-sink.js';
import { FilePostLedger } from '../src/ledger.js';
import {
  activeRunsWriter,
  readActiveRuns,
  readServerInfo,
  removeServerInfo,
  writeJsonAtomic,
  writeServerInfo,
} from '../src/state.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aigrader-state-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const record = (runId: string): RunProgressDoc =>
  ({
    runId,
    canvasCourseId: 77,
    canvasAssignmentId: 501,
    apiDomain: 'byui.instructure.com',
    courseKey: 'byui.instructure.com#77',
    status: 'RUNNING',
    counts: {},
    cancelRequested: false,
    worker: { owner: 'x', heartbeatAt: null, resumeCount: 0 },
    checkpoint: { lastSavedAt: null },
    createdAt: '2026-06-10T00:00:00Z',
    updatedAt: '2026-06-10T00:00:00Z',
  }) as unknown as RunProgressDoc;

describe('state files', () => {
  it('writes atomically (no temp files left) and round-trips the active-runs list', () => {
    const file = join(dir, 'state', 'active-runs.json');
    activeRunsWriter(file)([record('r1'), record('r2')]);
    expect(readActiveRuns(file).map((r) => r.runId)).toEqual(['r1', 'r2']);
    expect(readdirSync(join(dir, 'state')).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    activeRunsWriter(file)([]);
    expect(readActiveRuns(file)).toEqual([]);
  });

  it('a corrupt or foreign active-runs file means "nothing to resume", never a crash', () => {
    const file = join(dir, 'active-runs.json');
    writeFileSync(file, '{ not json');
    expect(readActiveRuns(file)).toEqual([]);
    writeFileSync(file, JSON.stringify({ runs: [{ nope: 1 }, record('ok')] }));
    expect(readActiveRuns(file).map((r) => r.runId)).toEqual(['ok']);
  });

  it('server.json is removed only by the process it describes', () => {
    const file = join(dir, 'server.json');
    writeServerInfo(file, { port: 1, pid: 4242, version: 'v', origin: 'o', startedAt: 's' });
    removeServerInfo(file, 1111);
    expect(readServerInfo(file)?.pid).toBe(4242);
    removeServerInfo(file, 4242);
    expect(readServerInfo(file)).toBeNull();
  });

  it('writeJsonAtomic replaces an existing file', () => {
    const file = join(dir, 'x.json');
    writeJsonAtomic(file, { a: 1 });
    writeJsonAtomic(file, { a: 2 });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 2 });
  });
});

describe('FilePostLedger', () => {
  it('remembers posts across a restart and tolerates a torn final line', async () => {
    const ledgerDir = join(dir, 'ledger');
    const first = new FilePostLedger(ledgerDir);
    expect(await first.has('run1', 'u1')).toBe(false);
    await first.record({ runId: 'run1', key: 'u1', postedAt: '2026-06-10T00:00:00Z' });
    expect(await first.has('run1', 'u1')).toBe(true);

    // A crash mid-append leaves half a line.
    writeFileSync(join(ledgerDir, 'run1.jsonl'), `${readFileSync(join(ledgerDir, 'run1.jsonl'), 'utf8')}{"key":"u2`);
    const restarted = new FilePostLedger(ledgerDir);
    expect(await restarted.has('run1', 'u1')).toBe(true);
    expect(await restarted.has('run1', 'u2')).toBe(false);
    expect(await restarted.has('run2', 'u1')).toBe(false);
  });

  it('stores ids only, keeps run ids from escaping the folder, and prunes old files', async () => {
    const ledgerDir = join(dir, 'ledger');
    const ledger = new FilePostLedger(ledgerDir);
    await ledger.record({ runId: '../evil', key: 'q9', postedAt: 't' });
    expect(readdirSync(ledgerDir)).toEqual(['___evil.jsonl']);
    expect(JSON.parse(readFileSync(join(ledgerDir, '___evil.jsonl'), 'utf8'))).toEqual({ key: 'q9', postedAt: 't' });

    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    utimesSync(join(ledgerDir, '___evil.jsonl'), old, old);
    expect(ledger.prune()).toBe(1);
    expect(readdirSync(ledgerDir)).toEqual([]);
  });
});

describe('audit JSONL sink', () => {
  it('appends each line to the month file and prunes files past retention', () => {
    const auditDir = join(dir, 'audit');
    const sink = createJsonlAuditSink(auditDir, () => new Date('2026-09-24T12:00:00Z'));
    sink('{"a":1}\n');
    sink('{"a":2}\n');
    expect(readFileSync(join(auditDir, 'audit-2026-09.jsonl'), 'utf8')).toBe('{"a":1}\n{"a":2}\n');

    const ancient = new Date(Date.now() - 500 * 24 * 60 * 60 * 1000);
    utimesSync(join(auditDir, 'audit-2026-09.jsonl'), ancient, ancient);
    pruneAudit(auditDir);
    expect(readdirSync(auditDir)).toEqual([]);
  });
});
