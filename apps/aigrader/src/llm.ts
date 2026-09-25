// The grading model backend. Phase 3 plugs in packages/codex (an isolated
// `codex exec` per student). Until then the server runs with this
// placeholder: every model call fails as "model unavailable", so a run
// started now ends its rows in ERROR (re-runnable) — never with a fake grade.

import { GradingCallError, StructuredGradingClient, type GradingLlm } from '@aigrader/engine';

export function unavailableLlm(): GradingLlm {
  return new StructuredGradingClient({
    maxAttempts: 1,
    modelCall: async () => {
      throw new GradingCallError('Codex grading is not connected in this build yet.', {
        retryable: false,
        kind: 'model_unavailable',
      });
    },
  });
}
