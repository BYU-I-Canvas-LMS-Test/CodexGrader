// Low-level Canvas Files API client: the foundation of the app's persistence
// story (student-adjacent grading state lives in a hidden+locked "AI Grader"
// folder inside each course's Files area; the document stores in src/stores
// build on this).
//
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Canvas\CanvasFilesClient.cs
// (folder-by-path resolution, hidden+locked folder creation, exact-filename
// matching, 2-step upload with manual redirect + bearer-host guard, fresh
// signed-URL downloads, idempotent delete) — itself derived from
// C:\Devs\AIgrader\lib\canvas\client.ts:775-895.
//
// Redirects are handled BY HAND here (redirect: 'manual'), deliberately:
// upload step 2 must reach the storage host (inst-fs/S3) WITHOUT our bearer,
// and any redirect it returns must be followed with the bearer ONLY when the
// target is the Canvas host — automatic redirect handling can't make that
// per-hop decision.
//
// Behavioral delta from C# (deliberate): listFolderFiles THROWS on a failed
// page instead of returning partial results — a silent empty listing feeding
// the document stores ("AIGrader.json not found → start a fresh profile")
// would be a data-loss trap. deleteFile keeps the C# no-throw contract but
// returns false so callers can log.

import { z } from 'zod';
import { CanvasError } from './errors.js';
import { DEFAULT_TRUSTED_SUFFIXES, isTrustedHost, normalizeHost } from './domains.js';
import { CanvasHttp, drainResponse, encodeForm, parsed } from './http.js';
import type { CanvasClientOptions } from './http.js';
import { canvasFileSchema, canvasFolderSchema, uploadInitSchema } from './types.js';
import type { CanvasFileDto } from './types.js';

/**
 * Metadata for a file stored in Canvas.
 * - `id`: treat as a CACHE, not an identity — overwrites and course copies
 *   can reassign it; always be ready to re-resolve by filename.
 * - `url`: signed download URL. SHORT-LIVED — use immediately, never persist.
 */
export type CanvasFileInfo = {
  id: number;
  filename: string;
  displayName: string;
  size: number;
  contentType: string | null;
  updatedAt: string | null;
  url: string | null;
};

function toInfo(f: CanvasFileDto): CanvasFileInfo {
  return {
    id: f.id,
    filename: f.filename ?? '',
    displayName: f.display_name ?? f.filename ?? '',
    size: f.size ?? 0,
    contentType: f['content-type'] ?? null,
    updatedAt: f.updated_at ?? null,
    url: f.url ?? null,
  };
}

type Id = string | number;

export class CanvasFilesClient {
  private readonly http: CanvasHttp;
  private readonly options: CanvasClientOptions;

  constructor(options: CanvasClientOptions) {
    this.http = new CanvasHttp(options);
    // Share the resolved gate with forDomain siblings — file traffic and API
    // traffic compete for the same per-token Canvas rate budget, so pass the
    // SAME gate instance used by the CanvasClient for this token.
    this.options = { ...options, gate: this.http.gate };
  }

  get baseUrl(): string {
    return this.http.baseUrl;
  }

  get gate() {
    return this.http.gate;
  }

  /**
   * The Files-API twin of CanvasClient.forDomain: a client bound to another
   * Canvas instance, sharing this client's token and gate. Null/empty/
   * unsubstituted domains return this client unchanged; untrusted domains
   * throw rather than carry the token off-cluster.
   */
  forDomain(
    apiDomain: string | null | undefined,
    trustedSuffixes?: readonly string[],
  ): CanvasFilesClient {
    const host = normalizeHost(apiDomain);
    if (host === null || host === normalizeHost(this.http.baseUrl)) return this;
    const suffixes = trustedSuffixes ?? this.options.trustedSuffixes ?? DEFAULT_TRUSTED_SUFFIXES;
    if (!isTrustedHost(host, suffixes)) {
      throw new Error(
        `Refusing to send the Canvas API token to '${host}' — it matches none of the trusted ` +
          'domain suffixes. Add the suffix if this instance is yours.',
      );
    }
    return new CanvasFilesClient({ ...this.options, baseUrl: `https://${host}` });
  }

  // -------------------------------------------------------------- folders --

  /**
   * Resolves (creating if needed) a folder at `path` under the course root,
   * e.g. "AI Grader" or "AI Grader/runs". Created folders are
   * hidden AND locked: `hidden` alone removes the folder from the student
   * Files UI but direct file links still work; `locked` makes contents
   * genuinely unavailable to students. Both are set because these folders
   * hold teacher-only material (grading keys, run state with student names).
   */
  async ensureFolder(courseId: Id, path: string): Promise<number> {
    // by_path resolves the whole chain in one request; the last element is
    // the target folder. 404 means some segment doesn't exist yet.
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const byPathUrl = this.http.buildUrl(`/api/v1/courses/${courseId}/folders/by_path/${encoded}`);
    const res = await this.http.send('GET', byPathUrl);
    if (res.ok) {
      const chain = parsed(
        z.array(canvasFolderSchema),
        await this.http.parseJson(res, byPathUrl),
        byPathUrl,
      );
      if (chain.length > 0) return chain[chain.length - 1].id;
    } else {
      await drainResponse(res);
    }

    // Create segment by segment so intermediate folders also get the
    // hidden+locked flags (a single create with a nested path would leave
    // auto-created parents visible).
    let parentId: number | null = null;
    let currentId = 0;
    for (const segment of path.split('/')) {
      currentId = await this.ensureSingleFolder(courseId, segment, parentId);
      parentId = currentId;
    }
    return currentId;
  }

  /**
   * Resolves a folder id at `path` under the course root WITHOUT creating
   * anything — the read-path twin of ensureFolder, used by the document
   * stores so a read never conjures an empty folder. Returns
   * null when any segment is missing (404 from by_path); THROWS on real API
   * failures so a Canvas outage can't masquerade as "no folder" (the same
   * silent-empty data-loss trap listFolderFiles guards against).
   */
  async findFolderByPath(courseId: Id, path: string): Promise<number | null> {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const url = this.http.buildUrl(`/api/v1/courses/${courseId}/folders/by_path/${encoded}`);
    const res = await this.http.send('GET', url);
    if (res.status === 404) {
      await drainResponse(res);
      return null;
    }
    if (!res.ok) {
      throw new CanvasError(res.status, url, await res.text().catch(() => ''));
    }
    const chain = parsed(z.array(canvasFolderSchema), await this.http.parseJson(res, url), url);
    return chain.length > 0 ? chain[chain.length - 1].id : null;
  }

  private async ensureSingleFolder(
    courseId: Id,
    name: string,
    parentId: number | null,
  ): Promise<number> {
    const payload: Record<string, string> = {
      name,
      hidden: 'true',
      locked: 'true', // hidden hides from the Files UI; locked blocks student access entirely
    };
    if (parentId != null) payload['parent_folder_id'] = String(parentId);
    else payload['parent_folder_path'] = '';

    const createUrl = this.http.buildUrl(`/api/v1/courses/${courseId}/folders`);
    const create = await this.http.send('POST', createUrl, {
      body: encodeForm(payload),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (create.ok) {
      return parsed(canvasFolderSchema, await this.http.parseJson(create, createUrl), createUrl).id;
    }
    const failureStatus = create.status;
    await drainResponse(create);

    // TOCTOU: a concurrent caller (or a racing course-copy sync) may have
    // created the folder between our lookup and our create. Re-query and
    // reuse rather than orphaning files into a duplicate folder.
    // ALL pages: a course with >100 folders must not hide the winner.
    const listPath = `/api/v1/courses/${courseId}/folders`;
    const folders = parsed(
      z.array(canvasFolderSchema),
      await this.http.getPaginated(listPath, { per_page: 100 }),
      this.http.buildUrl(listPath),
    );
    // A top-level segment's parent is the course root folder (the one with no
    // parent) — never a same-named folder nested somewhere else.
    const wantParent = parentId ?? folders.find((f) => f.parent_folder_id == null)?.id ?? null;
    const found = folders.find(
      (f) => f.name === name && (wantParent == null || f.parent_folder_id === wantParent),
    );
    if (found) return found.id;

    throw new CanvasError(
      failureStatus,
      createUrl,
      `Could not create or find Canvas folder '${name}' in course ${courseId}.`,
    );
  }

  // ---------------------------------------------------------------- files --

  /** Lists the files directly inside a folder. */
  async listFolderFiles(folderId: Id): Promise<CanvasFileInfo[]> {
    const path = `/api/v1/folders/${folderId}/files`;
    const raw = await this.http.getPaginated(path, { per_page: 100 });
    return parsed(z.array(canvasFileSchema), raw, path).map(toInfo);
  }

  /**
   * Finds a file by EXACT filename within a folder (newest first), or null.
   * Listing the folder and matching exactly avoids the original TS project's
   * course-wide substring search ("AIGrader.json" matching backups etc.).
   */
  async findFileInFolder(folderId: Id, exactFilename: string): Promise<CanvasFileInfo | null> {
    const files = await this.listFolderFiles(folderId);
    const matches = files
      .filter((f) => f.filename === exactFilename || f.displayName === exactFilename)
      // ISO timestamps sort lexicographically; missing dates sort last.
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    return matches[0] ?? null;
  }

  /**
   * Uploads bytes as `filename` into a folder, overwriting any existing file
   * with that name (same name in same folder replaces — our update
   * primitive). Canvas's 2-step flow:
   *   1. POST /files → { upload_url, upload_params } (one-time target,
   *      usually inst-fs or S3, plus the params that authorize it)
   *   2. multipart POST to upload_url — WITHOUT our bearer (upload_params
   *      carry the authorization; some storage backends reject requests
   *      bearing an unexpected Authorization header). The file part is
   *      appended LAST per Canvas's upload contract.
   *   3. Canvas either returns the file JSON directly (201) or a 3xx
   *      redirect to a confirmation endpoint that must be fetched WITH the
   *      bearer. The storage host controls that Location header, so refuse
   *      to follow it anywhere but our Canvas host — following an arbitrary
   *      origin with the token attached would exfiltrate the API token.
   */
  async uploadFile(
    courseId: Id,
    folderId: Id,
    filename: string,
    contentType: string,
    bytes: Uint8Array,
  ): Promise<CanvasFileInfo> {
    // Step 1: tell Canvas what's coming.
    const initPath = `/api/v1/courses/${courseId}/files`;
    const init = parsed(
      uploadInitSchema,
      await this.http.postForm(initPath, {
        name: filename,
        size: bytes.length,
        content_type: contentType,
        parent_folder_id: String(folderId),
        on_duplicate: 'overwrite',
      }),
      initPath,
    );

    // Step 2: multipart POST to the upload target, bearer withheld.
    const form = new FormData();
    for (const [key, value] of Object.entries(init.upload_params ?? {})) {
      form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
    // The file field must be appended LAST per Canvas's upload contract.
    form.append('file', new Blob([new Uint8Array(bytes)], { type: contentType }), filename);

    const up = await this.http.send('POST', init.upload_url, {
      body: form,
      redirect: 'manual',
      withAuth: false,
    });

    // Step 3: direct JSON or guarded redirect confirmation.
    if (up.status >= 300 && up.status < 400) {
      const location = up.headers.get('location');
      await drainResponse(up);
      if (!location) {
        throw new CanvasError(up.status, init.upload_url, 'upload redirect missing Location header');
      }
      if (!this.http.isCanvasHost(location)) {
        throw new CanvasError(
          up.status,
          init.upload_url,
          'upload confirmation redirect pointed off the Canvas host; refusing to send the API token',
        );
      }
      const confirm = await this.http.requestOk('GET', location);
      return toInfo(parsed(canvasFileSchema, await this.http.parseJson(confirm, location), location));
    }

    if (!up.ok) {
      throw new CanvasError(up.status, init.upload_url, await up.text().catch(() => ''));
    }
    return toInfo(
      parsed(canvasFileSchema, await this.http.parseJson(up, init.upload_url), init.upload_url),
    );
  }

  /**
   * Downloads a file's bytes by id. Re-fetches the file object first to get a
   * fresh signed URL (stored URLs expire within minutes). Returns null when
   * the file id no longer exists (e.g. after an overwrite reassigned it) or
   * the signed-URL chain dead-ends. Redirects are followed by hand: the
   * bearer rides along only while we're on the Canvas host; signed storage
   * URLs authorize themselves.
   */
  async downloadFile(fileId: Id): Promise<Buffer | null> {
    const metaUrl = this.http.buildUrl(`/api/v1/files/${fileId}`);
    const meta = await this.http.send('GET', metaUrl);
    if (meta.status === 404) {
      await drainResponse(meta);
      return null;
    }
    if (!meta.ok) {
      throw new CanvasError(meta.status, metaUrl, await meta.text().catch(() => ''));
    }
    const file = parsed(canvasFileSchema, await this.http.parseJson(meta, metaUrl), metaUrl);
    if (!file.url) return null;

    let url = file.url;
    for (let hop = 0; hop < 5; hop++) {
      const res = await this.http.send('GET', url, { redirect: 'manual' });
      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get('location');
        await drainResponse(res);
        if (!next) return null;
        // Relative redirects resolve against the current hop.
        url = new URL(next, url).toString();
        continue;
      }
      if (!res.ok) {
        await drainResponse(res);
        return null;
      }
      return Buffer.from(await res.arrayBuffer());
    }
    return null; // redirect limit exceeded
  }

  /**
   * Deletes a file by id. Returns true when deleted or already gone (404 =
   * success for our purposes — idempotent delete), false on any other
   * failure (C# logged a warning and moved on; callers can log here).
   */
  async deleteFile(fileId: Id): Promise<boolean> {
    const url = this.http.buildUrl(`/api/v1/files/${fileId}`);
    const res = await this.http.send('DELETE', url);
    await drainResponse(res);
    return res.ok || res.status === 404;
  }
}

/** Creates a CanvasFilesClient. Pass the SAME gate as the CanvasClient for
 * this token so file and API traffic share one rate budget. */
export function createCanvasFilesClient(options: CanvasClientOptions): CanvasFilesClient {
  return new CanvasFilesClient(options);
}
