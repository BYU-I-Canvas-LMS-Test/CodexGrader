// @aigrader/canvas — Canvas REST client layer: API client, Files client,
// per-token request gate, domain trust, and the Canvas-file document stores
// (src/stores/ — the app's "database" layer over course files).
//
// Ported from: C:\Devs\AIgrader\lib\canvas\client.ts (client base) and
// C:\Devs\AIGrader-C#\src\AiGrader\Services\Canvas\* (gate, domains,
// ForDomain routing, files hidden+locked) +
// C:\Devs\AIGrader-C#\src\AiGrader\Models\Canvas\CanvasModels.cs (DTOs) +
// C:\Devs\AIGrader-C#\src\AiGrader\Services\Storage\* (document stores).
// Consumed by the engine ONLY — the web tier makes zero Canvas calls by
// design (the engine owns Canvas).

export { CanvasGate, CanvasGateRegistry, DEFAULT_MAX_CONCURRENT_REQUESTS } from './gate.js';
export { DEFAULT_TRUSTED_SUFFIXES, isTrustedHost, normalizeHost } from './domains.js';
export { parseNextLink } from './pagination.js';
export { CanvasError, extractCanvasErrorMessage } from './errors.js';
export type { CanvasClientOptions, FetchLike } from './http.js';
export {
  CanvasClient,
  createCanvasClient,
  buildRubricUpdateForm,
  flattenDiscussionEntries,
} from './client.js';
export type { PostGradeArgs, RubricCriterionInput, RubricRatingInput } from './client.js';
export { CanvasFilesClient, createCanvasFilesClient } from './files.js';
export type { CanvasFileInfo } from './files.js';
export * from './types.js';

// Canvas-file document stores (the app's "database" layer over course files).
export {
  CourseDocumentStore,
  TtlCache,
  ROOT_FOLDER_NAME,
  FOLDER_ID_TTL_MS,
  DOCUMENT_TTL_MS,
  ABSENT_DECISION_TTL_MS,
} from './stores/course-doc-store.js';
export type { CourseDocumentStoreOptions, CourseFilesPort } from './stores/course-doc-store.js';
export { ProfileStore, PROFILE_FILENAME } from './stores/profile-store.js';
export {
  RunStore,
  runFilename,
  runStamp,
  parseRunFilename,
  RUNS_SUBFOLDER,
  RETENTION_AGE_MS,
  MAX_RUNS_PER_ASSIGNMENT,
} from './stores/run-store.js';
export type { RunListEntry, RunStoreOptions } from './stores/run-store.js';
export {
  ResourceStore,
  materialFilename,
  RESOURCES_DOCUMENT_NAME,
  MATERIAL_CACHE_TTL_MS,
} from './stores/resource-store.js';
export type { ResourceStoreOptions } from './stores/resource-store.js';
export { AlignmentStore, ALIGNMENT_DOCUMENT_NAME } from './stores/alignment-store.js';
