// Domain store for grading materials (templates/keys) and per-assignment prep
// settings. Bytes go to flat Canvas files with the TS predecessor's naming
// (a{assignmentId}-{kind}{.ext}); metadata lives in resources.json.
//
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Storage\ResourceStore.cs
//
// COURSE-COPY RELINK: material downloads resolve by the deterministic stored
// FILENAME, never the recorded Canvas file id (an id is a cache — overwrites
// and course copies reassign it). Because the filename survives a course
// copy, materials relink by name automatically; assignmentName is recorded so
// the UI's explicit relink flow (out of scope here, as in C#) can match
// copied assignments whose numeric ids changed.

import { AssignmentPrepSettingsSchema, CourseResourcesDocumentSchema } from '@aigrader/shared';
import type {
  AssignmentPrepSettings,
  AssignmentResourceEntry,
  CourseResourcesDocument,
  ResourceKind,
} from '@aigrader/shared';
import { TtlCache } from './course-doc-store.js';
import type { CourseDocumentStore } from './course-doc-store.js';

/** The course materials index document. */
export const RESOURCES_DOCUMENT_NAME = 'resources.json';

/** Material bytes are cached briefly: during a 100-student run every grade
 * wants the same key/template — one Canvas download serves the whole run. */
export const MATERIAL_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Deterministic stored filename for a material, e.g. "a11824-key.xlsx":
 * re-upload overwrites in place, and it matches materials the predecessor
 * apps already stored (zero migration). Extension comes from the teacher's
 * original filename, lowercased (C# Path.GetExtension + ToLowerInvariant).
 */
export function materialFilename(
  assignmentId: number,
  kind: ResourceKind,
  originalFilename: string,
): string {
  return `a${assignmentId}-${kind.toLowerCase()}${getExtension(originalFilename).toLowerCase()}`;
}

/** C# Path.GetExtension semantics: the final segment's last ".", inclusive;
 * "" when there is no dot or the dot is the final character. */
function getExtension(filename: string): string {
  const normalized = filename.replace(/\\/g, '/');
  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  const idx = name.lastIndexOf('.');
  if (idx < 0 || idx === name.length - 1) return '';
  return name.slice(idx);
}

export type ResourceStoreOptions = {
  store: CourseDocumentStore;
  /** Injectable clock for uploadedAt stamps and the byte cache (tests). */
  now?: () => Date;
};

/** Manages assignment templates, grading keys, and prep settings.
 * `apiDomain` on every method names the Canvas instance the course lives on
 * (omitted = the document store's bound default; null = the client's base). */
export class ResourceStore {
  private readonly store: CourseDocumentStore;
  private readonly now: () => Date;
  private readonly cache: TtlCache;

  constructor(options: ResourceStoreOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.cache = new TtlCache(this.now);
  }

  private async load(courseId: number, apiDomain?: string | null): Promise<CourseResourcesDocument> {
    return (
      (await this.store.get(courseId, RESOURCES_DOCUMENT_NAME, CourseResourcesDocumentSchema, apiDomain)) ??
      CourseResourcesDocumentSchema.parse({ canvasCourseId: courseId })
    );
  }

  /** Lists all material metadata for a course (one read). */
  async list(courseId: number, apiDomain?: string | null): Promise<AssignmentResourceEntry[]> {
    return (await this.load(courseId, apiDomain)).resources;
  }

  /** Uploads (or replaces) a material and records its metadata. */
  async uploadMaterial(
    courseId: number,
    assignmentId: number,
    assignmentName: string,
    kind: ResourceKind,
    originalFilename: string,
    contentType: string,
    bytes: Uint8Array,
    apiDomain?: string | null,
  ): Promise<AssignmentResourceEntry> {
    // Deterministic name = re-upload overwrites in place (and matches
    // materials the predecessor apps already stored, zero migration).
    const storedName = materialFilename(assignmentId, kind, originalFilename);

    const entry = await this.store.exclusive(
      courseId,
      RESOURCES_DOCUMENT_NAME,
      async () => {
        const file = await this.store.putFile(courseId, storedName, contentType, bytes, apiDomain);
        const doc = await this.load(courseId, apiDomain);
        doc.resources = doc.resources.filter(
          (r) => !(r.canvasAssignmentId === assignmentId && r.kind === kind),
        );
        const next: AssignmentResourceEntry = {
          canvasAssignmentId: assignmentId,
          assignmentName,
          kind,
          fileName: storedName,
          originalFilename,
          contentType,
          canvasFileId: file.id,
          uploadedAt: this.now().toISOString(),
        };
        doc.resources.push(next);
        await this.store.put(courseId, RESOURCES_DOCUMENT_NAME, doc, apiDomain);
        return next;
      },
      apiDomain,
    );

    // Small delta from C# (which left the byte cache alone): drop the cached
    // bytes so a re-upload is served fresh instead of stale for up to 10 min.
    this.cache.delete(this.materialCacheKey(courseId, assignmentId, kind, apiDomain));
    return entry;
  }

  /** Downloads a material's bytes; null when none uploaded. */
  async downloadMaterial(
    courseId: number,
    assignmentId: number,
    kind: ResourceKind,
    apiDomain?: string | null,
  ): Promise<Uint8Array | null> {
    const cacheKey = this.materialCacheKey(courseId, assignmentId, kind, apiDomain);
    const cached = this.cache.get<Uint8Array>(cacheKey);
    if (cached !== undefined) return cached;

    const doc = await this.load(courseId, apiDomain);
    const entry = doc.resources.find(
      (r) => r.canvasAssignmentId === assignmentId && r.kind === kind,
    );
    if (!entry) return null;

    // Resolve by FILENAME, not the stored file id — overwrites and course
    // copies can reassign ids, and the filename is the durable handle (this
    // is what relinks materials by name after a course copy).
    const bytes = await this.store.getFile(courseId, entry.fileName, apiDomain);
    if (bytes !== null) this.cache.set(cacheKey, bytes, MATERIAL_CACHE_TTL_MS);
    return bytes;
  }

  /** Removes a material (file + metadata). */
  async deleteMaterial(
    courseId: number,
    assignmentId: number,
    kind: ResourceKind,
    apiDomain?: string | null,
  ): Promise<void> {
    await this.store.exclusive(
      courseId,
      RESOURCES_DOCUMENT_NAME,
      async () => {
        const doc = await this.load(courseId, apiDomain);
        const entry = doc.resources.find(
          (r) => r.canvasAssignmentId === assignmentId && r.kind === kind,
        );
        if (!entry) return;

        await this.store.delete(courseId, entry.fileName, apiDomain);
        doc.resources = doc.resources.filter((r) => r !== entry);
        await this.store.put(courseId, RESOURCES_DOCUMENT_NAME, doc, apiDomain);
      },
      apiDomain,
    );
    this.cache.delete(this.materialCacheKey(courseId, assignmentId, kind, apiDomain));
  }

  /** Reads prep settings for an assignment (defaults when unset). */
  async getPrep(
    courseId: number,
    assignmentId: number,
    apiDomain?: string | null,
  ): Promise<AssignmentPrepSettings> {
    const doc = await this.load(courseId, apiDomain);
    // JSON object keys are strings — assignment ids are stringified (C# parity).
    return doc.prep[String(assignmentId)] ?? AssignmentPrepSettingsSchema.parse({});
  }

  /** Saves prep settings for an assignment. */
  async savePrep(
    courseId: number,
    assignmentId: number,
    prep: AssignmentPrepSettings,
    apiDomain?: string | null,
  ): Promise<void> {
    await this.store.exclusive(
      courseId,
      RESOURCES_DOCUMENT_NAME,
      async () => {
        const doc = await this.load(courseId, apiDomain);
        doc.prep[String(assignmentId)] = prep;
        await this.store.put(courseId, RESOURCES_DOCUMENT_NAME, doc, apiDomain);
      },
      apiDomain,
    );
  }

  /** The instance host is part of the key — course ids collide across instances. */
  private materialCacheKey(
    courseId: number,
    assignmentId: number,
    kind: ResourceKind,
    apiDomain?: string | null,
  ): string {
    return `aigrader:material:${this.store.instanceKey(apiDomain)}:${courseId}:${assignmentId}:${kind}`;
  }
}
