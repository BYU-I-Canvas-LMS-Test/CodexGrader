// Canvas error shaping.
//
// Ported from: C:\Devs\AIgrader\lib\canvas\client.ts (CanvasError — status,
// URL, TRUNCATED body excerpt; never log full Canvas response bodies, they can
// carry student work) and
// C:\Devs\AIGrader-C#\src\AiGrader\Services\Canvas\CanvasApiClient.cs
// (ExtractCanvasErrorMessage — surface Canvas's own refusal message, e.g.
// "Outcome cannot be deleted because it is aligned to content", instead of
// guessing at the reason).

export class CanvasError extends Error {
  readonly status: number;
  readonly url: string;
  /** First 600 chars of the response body. PII guardrail: never the full body. */
  readonly bodyExcerpt: string;
  /** Human-readable text pulled out of Canvas's error JSON, when present. */
  readonly canvasMessage: string | null;

  constructor(status: number, url: string, body: string) {
    const excerpt = body.slice(0, 600);
    const canvasMessage = extractCanvasErrorMessage(body);
    super(`Canvas ${status} ${url}\n${canvasMessage ?? excerpt}`);
    this.name = 'CanvasError';
    this.status = status;
    this.url = url;
    this.bodyExcerpt = excerpt;
    this.canvasMessage = canvasMessage;
  }
}

/**
 * Pulls human-readable text out of Canvas's error JSON, which arrives in
 * several shapes: `{"message":…}`, `{"errors":[{"message":…}]}`, or
 * `{"errors":{"field":[{"message":…}]}}`. Returns null for HTML or
 * unrecognized bodies.
 *
 * Ported from: CanvasApiClient.cs ExtractCanvasErrorMessage.
 */
export function extractCanvasErrorMessage(body: string): string | null {
  if (!body || body.trimStart().startsWith('<')) return null;
  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch {
    return null;
  }

  const messages: string[] = [];
  collect(root, 0);
  const text = [...new Set(messages)].join('; ');
  if (text.trim() === '') return null;
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;

  function collect(element: unknown, depth: number): void {
    if (depth > 4 || element === null || element === undefined) return; // error payloads are shallow; guard anyway
    if (Array.isArray(element)) {
      for (const item of element) collect(item, depth + 1);
      return;
    }
    if (typeof element === 'object') {
      for (const [key, value] of Object.entries(element)) {
        if (key === 'message' && typeof value === 'string') {
          messages.push(value);
        } else if (key === 'errors' || key === 'error' || (value !== null && typeof value === 'object')) {
          collect(value, depth + 1);
        }
      }
    }
  }
}
