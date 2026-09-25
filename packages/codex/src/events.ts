// The `codex exec --json` event stream (one JSON object per line):
//   {"type":"thread.started","thread_id":…}
//   {"type":"turn.started"}
//   {"type":"item.completed","item":{"type":"agent_message","text":"…"}}
//   {"type":"item.completed","item":{"type":"error","message":"…"}}   (informational)
//   {"type":"turn.completed","usage":{"input_tokens":…,"cached_input_tokens":…,
//                                     "output_tokens":…,"reasoning_output_tokens":…}}
//   {"type":"error","message":"<often a JSON error document>"}
//   {"type":"turn.failed","error":{"message":"…"}}

export interface ExecUsage {
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

export interface ExecOutcome {
  /** The final agent message text (the JSON answer), if any. */
  agentText: string | null;
  usage: ExecUsage | null;
  /** turn.failed / top-level error messages (failures). */
  errors: string[];
  /** Item types that mean the model used a tool — must never happen. */
  toolItems: string[];
  completed: boolean;
  failed: boolean;
}

/** Item types that are NOT tool use. */
const BENIGN_ITEMS = new Set(['agent_message', 'reasoning', 'error', 'todo_list']);

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function parseExecEvents(jsonl: string): ExecOutcome {
  const outcome: ExecOutcome = {
    agentText: null,
    usage: null,
    errors: [],
    toolItems: [],
    completed: false,
    failed: false,
  };
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    switch (event.type) {
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const item = (event.item ?? {}) as Record<string, unknown>;
        const type = String(item.type ?? '');
        if (type === 'agent_message' && event.type === 'item.completed' && typeof item.text === 'string') {
          outcome.agentText = item.text;
        } else if (type && !BENIGN_ITEMS.has(type) && !outcome.toolItems.includes(type)) {
          outcome.toolItems.push(type);
        }
        break;
      }
      case 'turn.completed': {
        outcome.completed = true;
        const u = (event.usage ?? {}) as Record<string, unknown>;
        outcome.usage = {
          inputTokens: num(u.input_tokens),
          cachedTokens: num(u.cached_input_tokens),
          outputTokens: num(u.output_tokens),
          reasoningTokens: num(u.reasoning_output_tokens),
        };
        break;
      }
      case 'turn.failed': {
        outcome.failed = true;
        const err = (event.error ?? {}) as Record<string, unknown>;
        if (typeof err.message === 'string') outcome.errors.push(err.message);
        break;
      }
      case 'error':
        if (typeof event.message === 'string') outcome.errors.push(event.message);
        break;
      default:
        break;
    }
  }
  return outcome;
}
