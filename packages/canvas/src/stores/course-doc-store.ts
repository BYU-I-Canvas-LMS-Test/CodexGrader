// Generic typed JSON document store over Canvas course files — the layer that
// makes "Canvas Files as a database" feel like a key/value store to the rest
// of the app. Sits between the domain stores (ProfileStore, RunStore, …) and
// CanvasFilesClient. Owns: folder resolution + caching, JSON
// (de)serialization via the shared storage serializer, a short-TTL read
// cache, and per-course write serialization.
//
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Storage\CourseDocumentStore.cs
//
// CONSISTENCY MODEL: Canvas files
// have no transactions, no ETags, no compare-and-swap — uploads are
// last-write-wins. This app accepts that, because (a) ONE local server
// process per machine owns every write (its single-instance lock), (b) all
// writes for a course funnel through one in-process gate here, (c) run
// documents carry an advisory RunLock that a second machine checks, and (d)
// the write rate is low (teacher edits + debounced run checkpoints).
//
// The root folder is "AI Grader" — the SAME folder the C# BYU-(A)I Grader
// used, so existing course data is read in place. One deliberate delta from
// the C# store: read paths here NEVER create folders (the C# read path could
// create an empty root via EnsureFolderAsync); a course the tool has never
// written to simply reads as empty.

import type { z } from 'zod';
import { parseStorageDocument, serializeStorageDocument } from '@aigrader/shared';
import { normalizeHost } from '../domains.js';
import type { CanvasFileInfo } from '../files.js';

/** Name of the per-course storage folder — shared with the C# BYU-(A)I
 * Grader; existing courses already have it. Never rename it. */
export const ROOT_FOLDER_NAME = 'AI Grader';

/** Folder ids barely change — cache for 6 hours (C# FolderIdTtl). */
export const FOLDER_ID_TTL_MS = 6 * 60 * 60 * 1000;

/** Documents change on teacher action — cache reads for 15 minutes
 * (C# DocumentTtl); writes refresh the cache write-through. */
export const DOCUMENT_TTL_MS = 15 * 60 * 1000;

/** "No storage folder yet" is cached briefly (not 6h) so a folder created by
 * another writer (e.g. the C# app) is noticed within minutes, not hours. */
export const ABSENT_DECISION_TTL_MS = DOCUMENT_TTL_MS;

type Id = string | number;

/**
 * The slice of CanvasFilesClient the document store composes with — kept as a
 * structural port type so tests can drive the store with in-memory fakes.
 * CanvasFilesClient satisfies it as-is.
 */
export interface CourseFilesPort {
  forDomain(apiDomain: string | null | undefined): CourseFilesPort;
  ensureFolder(courseId: Id, path: string): Promise<number>;
  findFolderByPath(courseId: Id, path: string): Promise<number | null>;
  listFolderFiles(folderId: Id): Promise<CanvasFileInfo[]>;
  findFileInFolder(folderId: Id, exactFilename: string): Promise<CanvasFileInfo | null>;
  uploadFile(
    courseId: Id,
    folderId: Id,
    filename: string,
    contentType: string,
    bytes: Uint8Array,
  ): Promise<CanvasFileInfo>;
  downloadFile(fileId: Id): Promise<Uint8Array | null>;
  deleteFile(fileId: Id): Promise<boolean>;
}

/** Minimal TTL cache over an injectable clock (the port of the C# store's
 * IMemoryCache usage — no background eviction, entries checked on read). */
export class TtlCache {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(private readonly now: () => Date) {}

  get<T>(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now().getTime()) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  set(key: string, value: unknown, ttlMs: number): void {
    this.entries.set(key, { value, expiresAt: this.now().getTime() + ttlMs });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  deleteByPrefix(prefix: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }
}

export type CourseDocumentStoreOptions = {
  /** The files client (or an in-memory fake in tests). */
  files: CourseFilesPort;
  /**
   * Default Canvas instance host for calls that omit apiDomain (undefined on
   * a call = this default; explicit null on a call = the files client's own
   * base). Mirrors how the C# store threads apiDomain through every call.
   */
  apiDomain?: string | null;
  /** Injectable clock for cache TTLs (tests). Defaults to wall time. */
  now?: () => Date;
  /** Warning sink for corrupt documents (default console.warn). */
  warn?: (message: string) => void;
};

/** The root-folder decision for one (instance, course): the "AI Grader"
 * folder's Canvas id, or 'absent' when the course doesn't have one yet. */
type RootDecision = { id: number; name: string } | 'absent';

/**
 * Typed JSON documents (and raw files) stored under a course's hidden
 * storage folder. Paths are relative to that folder and may contain one
 * subfolder level, e.g. "AIGrader.json" or "runs/run-….json".
 *
 * On every method, `apiDomain` is the Canvas instance host the course lives
 * on (the host part of the course key); omitted = this store's bound
 * default; null = the files client's own base instance. Course ids are only
 * unique PER INSTANCE, so callers in multi-instance deployments must pass it
 * consistently.
 */
export class CourseDocumentStore {
  private readonly files: CourseFilesPort;
  private readonly defaultDomain: string | null;
  private readonly now: () => Date;
  private readonly warn: (message: string) => void;

  // Shared across forDomain siblings (reassigned in forDomain): keys already
  // carry the instance host, and the point of the write gate is ONE gate per
  // (instance, course) in the process — a per-view map would break that.
  private cache: TtlCache;
  private writeGates: Map<string, Promise<void>>;

  constructor(options: CourseDocumentStoreOptions) {
    this.files = options.files;
    this.defaultDomain = normalizeHost(options.apiDomain ?? null);
    this.now = options.now ?? (() => new Date());
    this.warn = options.warn ?? ((message) => console.warn(message));
    this.cache = new TtlCache(this.now);
    this.writeGates = new Map();
  }

  /** The bound default instance host (null = the files client's own base). */
  get apiDomain(): string | null {
    return this.defaultDomain;
  }

  /**
   * A store bound to another Canvas instance — the document-store twin of
   * CanvasFilesClient.forDomain. Shares this store's caches and write gates
   * (keys carry the instance host, so sharing is what keeps the per-
   * (instance, course) gate discipline intact across views).
   */
  forDomain(apiDomain: string | null | undefined): CourseDocumentStore {
    const host = normalizeHost(apiDomain ?? null);
    if (host === this.defaultDomain) return this;
    const sibling = new CourseDocumentStore({
      files: this.files,
      apiDomain: host,
      now: this.now,
      warn: this.warn,
    });
    sibling.cache = this.cache;
    sibling.writeGates = this.writeGates;
    return sibling;
  }

  /** Normalized effective instance host for a call (null = the files
   * client's own base). undefined arg = this store's bound default. */
  resolveDomain(apiDomain?: string | null): string | null {
    return apiDomain === undefined ? this.defaultDomain : normalizeHost(apiDomain);
  }

  /** Cache/gate key segment naming the Canvas instance. Course ids are only
   * unique per instance, so every per-course key must include this — never
   * key by courseId alone (port of the C# InstanceKey discipline). */
  instanceKey(apiDomain?: string | null): string {
    return this.resolveDomain(apiDomain) ?? 'default';
  }

  // ---------------------------------------------------------------- reads --

  /**
   * Loads and parses a document against `schema`; null when it doesn't exist
   * or won't parse (a corrupt document must never crash a page — callers
   * treat null as "missing" and offer recreation). `fresh` skips the read
   * cache — for documents another computer may be writing (run checkpoints).
   */
  async get<S extends z.ZodTypeAny>(
    courseId: number,
    relativePath: string,
    schema: S,
    apiDomain?: string | null,
    opts: { fresh?: boolean } = {},
  ): Promise<z.infer<S> | null> {
    const cacheKey = this.docCacheKey(courseId, relativePath, apiDomain);
    const cached = opts.fresh ? undefined : this.cache.get<string>(cacheKey);
    if (cached !== undefined) return this.deserialize(schema, cached, relativePath);

    const bytes = await this.getFile(courseId, relativePath, apiDomain);
    if (bytes === null) return null;

    const json = new TextDecoder().decode(bytes);
    this.cache.set(cacheKey, json, DOCUMENT_TTL_MS);
    return this.deserialize(schema, json, relativePath);
  }

  private deserialize<S extends z.ZodTypeAny>(
    schema: S,
    json: string,
    context: string,
  ): z.infer<S> | null {
    try {
      return parseStorageDocument(schema, json);
    } catch (err) {
      // The warning preserves the trail (C# logged and returned null).
      this.warn(
        `[course-doc-store] Stored document ${context} failed to parse: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /** Downloads raw bytes by relative path; null when missing. Never creates folders. */
  async getFile(
    courseId: number,
    relativePath: string,
    apiDomain?: string | null,
  ): Promise<Uint8Array | null> {
    const files = this.files.forDomain(this.resolveDomain(apiDomain));
    const { subfolder, filename } = splitPath(relativePath);
    const folderId = await this.resolveFolder(courseId, subfolder, false, apiDomain);
    if (folderId === null) return null;

    const file = await files.findFileInFolder(folderId, filename);
    if (file === null) return null;

    return files.downloadFile(file.id);
  }

  /** Lists files in the root storage folder ("") or a subfolder ("runs"). */
  async list(
    courseId: number,
    subfolder: string,
    apiDomain?: string | null,
  ): Promise<CanvasFileInfo[]> {
    const folderId = await this.resolveFolder(courseId, subfolder, false, apiDomain);
    if (folderId === null) return [];
    return this.files.forDomain(this.resolveDomain(apiDomain)).listFolderFiles(folderId);
  }

  // --------------------------------------------------------------- writes --

  /** Serializes (via the shared storage serializer — the one dialect every
   * document under the folder uses) and uploads a document (overwriting),
   * then refreshes the read cache write-through. */
  async put(
    courseId: number,
    relativePath: string,
    document: unknown,
    apiDomain?: string | null,
  ): Promise<void> {
    const json = serializeStorageDocument(document);
    await this.putFile(
      courseId,
      relativePath,
      'application/json',
      new TextEncoder().encode(json),
      apiDomain,
    );
    // Write-through: the cache holds exactly what we just wrote, so reads
    // after a save are correct even within the TTL window.
    this.cache.set(this.docCacheKey(courseId, relativePath, apiDomain), json, DOCUMENT_TTL_MS);
  }

  /**
   * Uploads raw bytes (templates, grading keys) under the storage folder.
   * All storage writes for a course serialize through one in-process gate so
   * two in-app writers can never interleave a read-modify-write (cross-
   * process writers are fenced by the server's single-instance lock).
   */
  async putFile(
    courseId: number,
    relativePath: string,
    contentType: string,
    bytes: Uint8Array,
    apiDomain?: string | null,
  ): Promise<CanvasFileInfo> {
    const { subfolder, filename } = splitPath(relativePath);
    const gateKey = `${this.instanceKey(apiDomain)}:${courseId}`;

    return this.runExclusive(gateKey, async () => {
      const folderId = await this.resolveFolder(courseId, subfolder, true, apiDomain);
      if (folderId === null) {
        throw new Error(`Could not resolve storage folder for course ${courseId}.`);
      }
      return this.files
        .forDomain(this.resolveDomain(apiDomain))
        .uploadFile(courseId, folderId, filename, contentType, bytes);
    });
  }

  /**
   * Runs a read-modify-write of ONE document exclusively: two in-process
   * writers (the review page and a Codex chat tool, say) can never interleave
   * a load and a save and lose each other's update. The gate is per
   * (instance, course, document) — separate from the per-course write gate
   * put/putFile take inside, so nesting them never deadlocks. Never nest two
   * exclusive() calls for the SAME document.
   */
  async exclusive<T>(
    courseId: number,
    relativePath: string,
    fn: () => Promise<T>,
    apiDomain?: string | null,
  ): Promise<T> {
    return this.runExclusive(`doc:${this.instanceKey(apiDomain)}:${courseId}:${relativePath}`, fn);
  }

  /** Deletes a document if it exists. */
  async delete(courseId: number, relativePath: string, apiDomain?: string | null): Promise<void> {
    const files = this.files.forDomain(this.resolveDomain(apiDomain));
    const { subfolder, filename } = splitPath(relativePath);
    const folderId = await this.resolveFolder(courseId, subfolder, false, apiDomain);
    if (folderId === null) return;

    const file = await files.findFileInFolder(folderId, filename);
    if (file !== null) await files.deleteFile(file.id);

    this.cache.delete(this.docCacheKey(courseId, relativePath, apiDomain));
  }

  // -------------------------------------------------------------- helpers --

  /** One write gate per (instance, course): a simple promise-chain mutex.
   * Failures release the gate without poisoning the chain. */
  private async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.writeGates.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.writeGates.set(
      key,
      prev.then(() => current),
    );
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Resolves the storage folder (or a one-level subfolder) id, with caching.
   * Returns null when the folder doesn't exist and creation wasn't requested
   * — i.e. a course the tool has never written to.
   */
  private async resolveFolder(
    courseId: number,
    subfolder: string,
    createIfMissing: boolean,
    apiDomain?: string | null,
  ): Promise<number | null> {
    const root = await this.resolveRoot(courseId, createIfMissing, apiDomain);
    if (root === null) return null;
    if (!subfolder) return root.id;

    const path = `${root.name}/${subfolder}`;
    const cacheKey = this.folderCacheKey(courseId, path, apiDomain);
    const cached = this.cache.get<number>(cacheKey);
    if (cached !== undefined) return cached;

    const files = this.files.forDomain(this.resolveDomain(apiDomain));
    const id = createIfMissing
      ? await files.ensureFolder(courseId, path)
      : await files.findFolderByPath(courseId, path);
    if (id === null) return null;

    this.cache.set(cacheKey, id, FOLDER_ID_TTL_MS);
    return id;
  }

  /**
   * Resolves (and caches) the per-course ROOT folder decision: the
   * "AI Grader" folder when present, else absent. Only write paths create it.
   */
  private async resolveRoot(
    courseId: number,
    createIfMissing: boolean,
    apiDomain?: string | null,
  ): Promise<{ id: number; name: string } | null> {
    const decisionKey = `aigrader:folder-root:${this.instanceKey(apiDomain)}:${courseId}`;
    const files = this.files.forDomain(this.resolveDomain(apiDomain));

    let decision = this.cache.get<RootDecision>(decisionKey);
    if (decision === undefined) {
      const id = await files.findFolderByPath(courseId, ROOT_FOLDER_NAME);
      decision = id !== null ? { id, name: ROOT_FOLDER_NAME } : 'absent';
      this.cache.set(
        decisionKey,
        decision,
        decision === 'absent' ? ABSENT_DECISION_TTL_MS : FOLDER_ID_TTL_MS,
      );
    }

    // Read paths NEVER create: an absent folder just reads as empty.
    if (!createIfMissing) {
      return decision === 'absent' ? null : decision;
    }

    if (decision === 'absent') {
      // Fresh course: create the root (hidden+locked — the files client sets
      // both on every folder it creates).
      const id = await files.ensureFolder(courseId, ROOT_FOLDER_NAME);
      const created = { id, name: ROOT_FOLDER_NAME };
      this.cache.set(decisionKey, created, FOLDER_ID_TTL_MS);
      return created;
    }

    return decision;
  }

  private docCacheKey(courseId: number, relativePath: string, apiDomain?: string | null): string {
    return `aigrader:doc:${this.instanceKey(apiDomain)}:${courseId}:${relativePath}`;
  }

  private folderCacheKey(courseId: number, path: string, apiDomain?: string | null): string {
    return `aigrader:folder:${this.instanceKey(apiDomain)}:${courseId}:${path}`;
  }
}

/** Splits "runs/run-x.json" into { subfolder: "runs", filename: "run-x.json" }.
 * One subfolder level only (port of the C# SplitPath contract). */
function splitPath(relativePath: string): { subfolder: string; filename: string } {
  const idx = relativePath.indexOf('/');
  if (idx < 0) return { subfolder: '', filename: relativePath };
  const subfolder = relativePath.slice(0, idx);
  const filename = relativePath.slice(idx + 1);
  if (filename.includes('/')) {
    throw new Error(`Storage paths support one subfolder level only: '${relativePath}'.`);
  }
  return { subfolder, filename };
}
