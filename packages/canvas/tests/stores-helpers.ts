// In-memory CanvasFilesClient fake for the document-store test suites: a
// tiny multi-instance "Canvas Files area" (folders with hidden/locked flags,
// files with reassignable ids) plus an operation log and a manual upload
// gate for deterministic write-serialization tests.

import { normalizeHost } from '../src/domains.js';
import type { CanvasFileInfo } from '../src/files.js';
import type { CourseFilesPort } from '../src/stores/course-doc-store.js';

type Id = string | number;

export type FakeFolder = {
  id: number;
  courseId: number;
  path: string; // full path from the course root, e.g. "AI Grader/runs"
  hidden: boolean;
  locked: boolean;
};

export type FakeFile = {
  id: number;
  folderId: number;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  updatedAt: string;
};

type HostState = { folders: FakeFolder[]; files: FakeFile[] };

type Shared = {
  hosts: Map<string, HostState>;
  ops: string[];
  next: { id: number };
  manualUploads: boolean;
  pendingUploads: Array<{ label: string; release: () => void }>;
  clock: { tick: number };
};

export const FAKE_DEFAULT_HOST = 'school.instructure.com';

export class FakeFilesClient implements CourseFilesPort {
  readonly host: string;
  private readonly shared: Shared;

  constructor(host: string = FAKE_DEFAULT_HOST, shared?: Shared) {
    this.host = host;
    this.shared =
      shared ??
      ({
        hosts: new Map(),
        ops: [],
        next: { id: 1 },
        manualUploads: false,
        pendingUploads: [],
        clock: { tick: 0 },
      } satisfies Shared);
  }

  // ------------------------------------------------------------- test API --

  /** Every operation performed, e.g. "findFolderByPath:9:AI Grader". */
  get ops(): string[] {
    return this.shared.ops;
  }

  countOps(prefix: string): number {
    return this.shared.ops.filter((op) => op.startsWith(prefix)).length;
  }

  /** When true, uploadFile blocks until releaseNextUpload() is called. */
  set manualUploads(value: boolean) {
    this.shared.manualUploads = value;
  }

  get pendingUploadLabels(): string[] {
    return this.shared.pendingUploads.map((p) => p.label);
  }

  releaseNextUpload(): void {
    const next = this.shared.pendingUploads.shift();
    if (!next) throw new Error('No pending upload to release.');
    next.release();
  }

  seedFolder(
    courseId: number,
    path: string,
    flags: { hidden?: boolean; locked?: boolean } = {},
  ): number {
    const state = this.state();
    let parentPath = '';
    let id = 0;
    for (const segment of path.split('/')) {
      const current = parentPath ? `${parentPath}/${segment}` : segment;
      const existing = state.folders.find((f) => f.courseId === courseId && f.path === current);
      if (existing) {
        id = existing.id;
      } else {
        id = this.shared.next.id++;
        state.folders.push({
          id,
          courseId,
          path: current,
          hidden: flags.hidden ?? true,
          locked: flags.locked ?? true,
        });
      }
      parentPath = current;
    }
    return id;
  }

  seedFile(courseId: number, folderPath: string, filename: string, content: string | Uint8Array): number {
    const folderId = this.seedFolder(courseId, folderPath);
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const id = this.shared.next.id++;
    this.state().files.push({
      id,
      folderId,
      filename,
      contentType: 'application/json',
      bytes,
      updatedAt: this.stamp(),
    });
    return id;
  }

  folderByPath(courseId: number, path: string): FakeFolder | undefined {
    return this.state().folders.find((f) => f.courseId === courseId && f.path === path);
  }

  /** Decoded content of a file, or null when missing. */
  fileText(courseId: number, folderPath: string, filename: string): string | null {
    const folder = this.folderByPath(courseId, folderPath);
    if (!folder) return null;
    const file = this.state().files.find((f) => f.folderId === folder.id && f.filename === filename);
    return file ? new TextDecoder().decode(file.bytes) : null;
  }

  /** Reassigns a file's id in place (simulates Canvas overwrites/course copies). */
  reassignFileId(courseId: number, folderPath: string, filename: string): number {
    const folder = this.folderByPath(courseId, folderPath);
    const file = this.state().files.find(
      (f) => folder && f.folderId === folder.id && f.filename === filename,
    );
    if (!file) throw new Error(`No such file to reassign: ${folderPath}/${filename}`);
    file.id = this.shared.next.id++;
    return file.id;
  }

  // ----------------------------------------------------- CourseFilesPort --

  forDomain(apiDomain: string | null | undefined): FakeFilesClient {
    const host = normalizeHost(apiDomain);
    if (host === null || host === this.host) return this;
    return new FakeFilesClient(host, this.shared);
  }

  async findFolderByPath(courseId: Id, path: string): Promise<number | null> {
    this.record(`findFolderByPath:${courseId}:${path}`);
    return this.folderByPath(Number(courseId), path)?.id ?? null;
  }

  async ensureFolder(courseId: Id, path: string): Promise<number> {
    this.record(`ensureFolder:${courseId}:${path}`);
    // Created folders are hidden AND locked — mirrors CanvasFilesClient.
    return this.seedFolder(Number(courseId), path, { hidden: true, locked: true });
  }

  async listFolderFiles(folderId: Id): Promise<CanvasFileInfo[]> {
    this.record(`listFolderFiles:${folderId}`);
    return this.state()
      .files.filter((f) => f.folderId === Number(folderId))
      .map((f) => this.toInfo(f));
  }

  async findFileInFolder(folderId: Id, exactFilename: string): Promise<CanvasFileInfo | null> {
    this.record(`findFileInFolder:${folderId}:${exactFilename}`);
    const matches = this.state()
      .files.filter((f) => f.folderId === Number(folderId) && f.filename === exactFilename)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return matches[0] ? this.toInfo(matches[0]) : null;
  }

  async uploadFile(
    courseId: Id,
    folderId: Id,
    filename: string,
    contentType: string,
    bytes: Uint8Array,
  ): Promise<CanvasFileInfo> {
    const label = `${courseId}:${filename}`;
    this.record(`uploadFile:start:${label}`);
    if (this.shared.manualUploads) {
      await new Promise<void>((release) => {
        this.shared.pendingUploads.push({ label, release });
      });
    }
    const state = this.state();
    // Canvas on_duplicate=overwrite: same name in same folder replaces (and
    // may reassign the file id — model that so id-as-cache behavior is real).
    state.files = state.files.filter(
      (f) => !(f.folderId === Number(folderId) && f.filename === filename),
    );
    const file: FakeFile = {
      id: this.shared.next.id++,
      folderId: Number(folderId),
      filename,
      contentType,
      bytes,
      updatedAt: this.stamp(),
    };
    state.files.push(file);
    this.record(`uploadFile:end:${label}`);
    return this.toInfo(file);
  }

  async downloadFile(fileId: Id): Promise<Uint8Array | null> {
    this.record(`downloadFile:${fileId}`);
    const file = this.state().files.find((f) => f.id === Number(fileId));
    return file ? file.bytes : null;
  }

  async deleteFile(fileId: Id): Promise<boolean> {
    this.record(`deleteFile:${fileId}`);
    const state = this.state();
    state.files = state.files.filter((f) => f.id !== Number(fileId));
    return true;
  }

  // -------------------------------------------------------------- private --

  private state(): HostState {
    let state = this.shared.hosts.get(this.host);
    if (!state) {
      state = { folders: [], files: [] };
      this.shared.hosts.set(this.host, state);
    }
    return state;
  }

  private record(op: string): void {
    this.shared.ops.push(`${this.host === FAKE_DEFAULT_HOST ? '' : `${this.host}|`}${op}`);
  }

  private stamp(): string {
    // Monotonic fake timestamps so "newest first" ordering is deterministic.
    this.shared.clock.tick += 1;
    return new Date(Date.UTC(2026, 0, 1) + this.shared.clock.tick * 1000).toISOString();
  }

  private toInfo(f: FakeFile): CanvasFileInfo {
    return {
      id: f.id,
      filename: f.filename,
      displayName: f.filename,
      size: f.bytes.length,
      contentType: f.contentType,
      updatedAt: f.updatedAt,
      url: null,
    };
  }
}

/** Flushes queued microtasks + macrotasks so gate-serialized work settles. */
export async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}
