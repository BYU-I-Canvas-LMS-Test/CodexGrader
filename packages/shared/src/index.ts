// @aigrader/shared — types + Zod schemas shared by the local web UI and the
// grading engine, plus the SSRF policy core (ssrf.ts) used to validate the
// Canvas base URL a teacher puts in their .env. Runtime deps stay minimal
// (zod only). Heavy libraries live in @aigrader/canvas and
// @aigrader/extraction (engine-only).

export * from './storageJson.js';
export * from './course-profile.js';
export * from './grading-run.js';
export * from './course-resources.js';
export * from './alignment.js';
export * from './run-progress.js';
export * from './course-key.js';
export * from './audit.js';
export * from './preview.js';
export * from './ssrf.js';
export * from './local-host.js';
