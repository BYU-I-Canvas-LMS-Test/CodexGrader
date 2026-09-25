// CanvasFilesClient behavior: hidden+locked folder creation, by_path
// resolution with the TOCTOU fallback, exact-filename matching, the 2-step
// upload with its bearer-host guard, signed-URL downloads, and idempotent
// delete.
// Behaviors ported from:
// C:\Devs\AIGrader-C#\src\AiGrader\Services\Canvas\CanvasFilesClient.cs

import { describe, expect, it } from 'vitest';
import { createCanvasFilesClient } from '../src/files.js';
import { jsonResponse, makeFetch, redirectResponse, textResponse } from './helpers.js';

const BASE = 'https://school.instructure.com';

function filesClient(fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>) {
  return createCanvasFilesClient({
    baseUrl: BASE,
    token: 'sekrit-token',
    fetch: fetchImpl,
    maxRetries: 0,
  });
}

describe('ensureFolder', () => {
  it('resolves an existing chain via by_path without creating anything', async () => {
    const { fetchImpl, calls } = makeFetch([
      jsonResponse([
        { id: 1, name: 'course files' },
        { id: 10, name: 'AI Grader' },
      ]),
    ]);

    const id = await filesClient(fetchImpl).ensureFolder(9, 'AI Grader');
    expect(id).toBe(10);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/api/v1/courses/9/folders/by_path/AI%20Grader`);
  });

  it('creates missing segments hidden:true AND locked:true, chaining parent ids', async () => {
    const { fetchImpl, calls } = makeFetch([
      textResponse('{"errors":[{"message":"not found"}]}', { status: 404 }), // by_path
      jsonResponse({ id: 10, name: 'AI Grader' }), // create segment 1
      jsonResponse({ id: 11, name: 'runs' }), // create segment 2
    ]);

    const id = await filesClient(fetchImpl).ensureFolder(9, 'AI Grader/runs');
    expect(id).toBe(11);

    const first = new URLSearchParams(String(calls[1].body));
    expect(first.get('name')).toBe('AI Grader');
    expect(first.get('hidden')).toBe('true');
    expect(first.get('locked')).toBe('true');
    expect(first.get('parent_folder_path')).toBe('');

    const second = new URLSearchParams(String(calls[2].body));
    expect(second.get('name')).toBe('runs');
    expect(second.get('hidden')).toBe('true');
    expect(second.get('locked')).toBe('true');
    expect(second.get('parent_folder_id')).toBe('10');
  });

  it('falls back to a requery when the create races a concurrent caller (TOCTOU)', async () => {
    const { fetchImpl } = makeFetch([
      textResponse('not found', { status: 404 }), // by_path
      textResponse('conflict', { status: 409 }), // create loses the race
      jsonResponse([
        { id: 1, name: 'course files', parent_folder_id: null },
        { id: 33, name: 'AI Grader', parent_folder_id: 1 },
      ]), // requery finds it
    ]);

    const id = await filesClient(fetchImpl).ensureFolder(9, 'AI Grader');
    expect(id).toBe(33);
  });

  it('the requery follows every page and skips a same-named folder nested elsewhere (bug #16)', async () => {
    const { fetchImpl, calls } = makeFetch([
      textResponse('not found', { status: 404 }), // by_path
      textResponse('conflict', { status: 409 }), // create loses the race
      jsonResponse(
        [
          { id: 1, name: 'course files', parent_folder_id: null },
          { id: 5, name: 'Week 1', parent_folder_id: 1 },
          { id: 6, name: 'AI Grader', parent_folder_id: 5 }, // decoy: not top-level
        ],
        { headers: { link: `<${BASE}/api/v1/courses/9/folders?page=2&per_page=100>; rel="next"` } },
      ),
      jsonResponse([{ id: 44, name: 'AI Grader', parent_folder_id: 1 }]), // page 2
    ]);

    const id = await filesClient(fetchImpl).ensureFolder(9, 'AI Grader');
    expect(id).toBe(44);
    expect(calls[3].url).toContain('page=2');
  });
});

describe('findFolderByPath', () => {
  it('resolves the deepest folder of an existing chain WITHOUT creating anything', async () => {
    const { fetchImpl, calls } = makeFetch([
      jsonResponse([
        { id: 1, name: 'course files' },
        { id: 10, name: 'AI Grader' },
        { id: 11, name: 'runs' },
      ]),
    ]);

    const id = await filesClient(fetchImpl).findFolderByPath(9, 'AI Grader/runs');
    expect(id).toBe(11);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe(`${BASE}/api/v1/courses/9/folders/by_path/AI%20Grader/runs`);
  });

  it('returns null on 404 (missing segment) but THROWS on real API failures', async () => {
    const { fetchImpl } = makeFetch([
      textResponse('not found', { status: 404 }),
      textResponse('server error', { status: 503 }),
    ]);

    const client = filesClient(fetchImpl);
    expect(await client.findFolderByPath(9, 'AI Grader')).toBeNull();
    // A Canvas outage must not masquerade as "no folder".
    await expect(client.findFolderByPath(9, 'AI Grader')).rejects.toThrow();
  });
});

describe('findFileInFolder', () => {
  it('matches the EXACT filename only (never substrings) and prefers the newest', async () => {
    const listing = [
      { id: 1, filename: 'AIGrader.json.bak', display_name: 'AIGrader.json.bak', size: 5, updated_at: '2026-01-05T00:00:00Z' },
      { id: 2, filename: 'AIGrader.json', display_name: 'AIGrader.json', size: 5, updated_at: '2026-01-01T00:00:00Z' },
      { id: 3, filename: 'AIGrader.json', display_name: 'AIGrader.json', size: 5, updated_at: '2026-01-03T00:00:00Z' },
    ];
    const { fetchImpl } = makeFetch([jsonResponse(listing), jsonResponse(listing)]);

    const client = filesClient(fetchImpl);
    const found = await client.findFileInFolder(5, 'AIGrader.json');
    expect(found?.id).toBe(3);

    const missing = await client.findFileInFolder(5, 'nope.json');
    expect(missing).toBeNull();
  });
});

describe('2-step upload bearer-host guard', () => {
  const uploadInit = {
    upload_url: 'https://inst-fs.example.com/upload',
    upload_params: { key: 'abc', policy: 'xyz' },
  };
  const fileJson = {
    id: 42,
    filename: 'AIGrader.json',
    display_name: 'AIGrader.json',
    size: 10,
    'content-type': 'application/json',
    updated_at: '2026-01-01T00:00:00Z',
    url: `${BASE}/files/42/download`,
  };

  it('withholds the bearer from the upload host and follows a Canvas-host redirect WITH it', async () => {
    const { fetchImpl, calls } = makeFetch([
      jsonResponse(uploadInit), // step 1 preflight (Canvas)
      redirectResponse(`${BASE}/api/v1/files/42?confirm=1`), // step 2 (storage host)
      jsonResponse(fileJson), // step 3 confirmation (Canvas)
    ]);

    const info = await filesClient(fetchImpl).uploadFile(
      9,
      77,
      'AIGrader.json',
      'application/json',
      new TextEncoder().encode('{"schemaVersion":1}'),
    );

    expect(info.id).toBe(42);
    // Step 1 is Canvas: bearer attached.
    expect(calls[0].headers.get('authorization')).toBe('Bearer sekrit-token');
    // Step 2 is the storage host: bearer MUST be absent, redirect handled manually.
    expect(calls[1].url).toBe('https://inst-fs.example.com/upload');
    expect(calls[1].headers.get('authorization')).toBeNull();
    expect(calls[1].redirect).toBe('manual');
    // Step 3 is back on Canvas: bearer attached.
    expect(calls[2].url).toBe(`${BASE}/api/v1/files/42?confirm=1`);
    expect(calls[2].headers.get('authorization')).toBe('Bearer sekrit-token');
  });

  it('REFUSES a confirmation redirect that points off the Canvas host', async () => {
    const { fetchImpl, calls } = makeFetch([
      jsonResponse(uploadInit),
      redirectResponse('https://evil.example.com/steal-token'),
    ]);

    await expect(
      filesClient(fetchImpl).uploadFile(9, 77, 'a.txt', 'text/plain', new Uint8Array([1])),
    ).rejects.toThrow(/refusing to send the API token/i);
    // No third request was ever issued — the token never left the cluster.
    expect(calls).toHaveLength(2);
  });

  it('accepts a direct 201-with-JSON upload response (no redirect)', async () => {
    const { fetchImpl, calls } = makeFetch([
      jsonResponse(uploadInit),
      jsonResponse(fileJson, { status: 201 }),
    ]);

    const info = await filesClient(fetchImpl).uploadFile(
      9,
      77,
      'AIGrader.json',
      'application/json',
      new Uint8Array([1, 2, 3]),
    );
    expect(info.filename).toBe('AIGrader.json');
    expect(calls[1].headers.get('authorization')).toBeNull();
  });
});

describe('downloadFile', () => {
  it('re-fetches metadata for a fresh signed URL and follows redirects without leaking the bearer', async () => {
    const { fetchImpl, calls } = makeFetch([
      jsonResponse({
        id: 42,
        filename: 'AIGrader.json',
        size: 5,
        url: `${BASE}/files/42/download?verifier=fresh`,
      }), // metadata (Canvas)
      redirectResponse('https://s3.example.com/blob?sig=abc'), // Canvas → storage
      textResponse('hello'), // storage host
    ]);

    const bytes = await filesClient(fetchImpl).downloadFile(42);
    expect(bytes?.toString('utf8')).toBe('hello');
    expect(calls[0].headers.get('authorization')).toBe('Bearer sekrit-token');
    expect(calls[1].headers.get('authorization')).toBe('Bearer sekrit-token');
    // The storage hop must NOT carry the bearer.
    expect(calls[2].headers.get('authorization')).toBeNull();
  });

  it('returns null when the file id no longer exists (overwrite reassigned it)', async () => {
    const { fetchImpl } = makeFetch([textResponse('not found', { status: 404 })]);
    expect(await filesClient(fetchImpl).downloadFile(42)).toBeNull();
  });
});

describe('deleteFile', () => {
  it('treats 404 as success (idempotent delete) and reports other failures', async () => {
    const { fetchImpl } = makeFetch([
      textResponse('gone', { status: 404 }),
      textResponse('nope', { status: 401 }),
    ]);

    const client = filesClient(fetchImpl);
    expect(await client.deleteFile(1)).toBe(true);
    expect(await client.deleteFile(2)).toBe(false);
  });
});

describe('forDomain (Files twin)', () => {
  it('shares the gate with the parent and refuses untrusted hosts', () => {
    const { fetchImpl } = makeFetch([]);
    const client = filesClient(fetchImpl);

    const sibling = client.forDomain('byupw.instructure.com');
    expect(sibling.baseUrl).toBe('https://byupw.instructure.com');
    expect(sibling.gate).toBe(client.gate);

    expect(() => client.forDomain('evil.example.com')).toThrow(/Refusing/);
    expect(client.forDomain(null)).toBe(client);
  });
});
