// @aigrader/codex — the grading model backend: one isolated `codex exec` per
// graded student (no tools, strict output schema, the teacher's own Codex
// sign-in), behind the engine's ModelCallFn seam.

export { createCodexBackend, type CodexBackend, type CodexBackendOptions, type CodexState, type CodexStatus } from './backend.js';
export { createCodexModelCall, UNTRUSTED_CONTENT_CLAUSE, type CodexModelCallOptions } from './model-call.js';
export { buildExecArgs, tomlString, type ExecArgsInput } from './args.js';
export { classifyFailure, toThrowable, type FailureInfo } from './errors.js';
export { parseExecEvents, type ExecOutcome, type ExecUsage } from './events.js';
export {
  REQUIRED_EXEC_FLAGS,
  SAFE_FEATURES,
  codexLoginState,
  featuresToDisable,
  parseExecFlags,
  parseFeatures,
  parseLoginStatus,
  parseVersion,
  probeCodex,
  type CodexCapabilities,
  type FeatureRow,
  type LoginState,
} from './capabilities.js';
export { prepareWorkerCatalog, sanitizeCatalog, summarizeCatalog, type CatalogModel, type WorkerCatalog } from './catalog.js';
export { codexCandidates, existingCodexCandidates, type CodexCandidate, type CodexSource } from './locator.js';
export { QuotaGuard, createUsageReader, parseRateLimits, type UsageReader, type UsageSnapshot, type UsageWindow } from './rate-limits.js';
export { killTree, runCodex, type CodexCommand, type RunResult } from './process.js';
