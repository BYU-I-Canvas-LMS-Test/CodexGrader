// The isolated worker's command line — one `codex exec` per graded student.
// Every setting here was verified against Codex 0.155 (`--strict-config`
// accepts every key; the worker then reports no tools and ~130 input tokens
// for a tiny prompt):
//
//   --ephemeral               nothing written to the session history
//   --ignore-user-config      the teacher's config.toml (MCP servers, model,
//                             profiles) is not loaded; sign-in still works
//   --ignore-rules            no execpolicy rules
//   --strict-config           an unknown key is an error, never ignored
//   --sandbox read-only / -C <empty temp dir> / approval_policy="never"
//   model_instructions_file   OUR calibrated system prompt replaces Codex's
//   model_catalog_json        tool-free catalog (see catalog.ts)
//   include_* = false, project_doc_max_bytes = 0, skills.* off,
//   multi-agent hints blanked  no environment context, permissions text,
//                             AGENTS.md, skills list, or agent-team prompt
//   web search / request_user_input / update_plan disabled
//   --disable <every enabled feature not on the safe list>
//   --output-schema / -o / --json   strict JSON answer + event stream
//   -i <image>…               vision parts, in submission order
//   -                         the user message arrives on stdin

export interface ExecArgsInput {
  /** Empty working directory (-C). */
  cwd: string;
  systemFile: string;
  schemaFile: string;
  outFile: string;
  catalogFile: string | null;
  model?: string;
  reasoningEffort?: string;
  images: readonly string[];
  disableFeatures: readonly string[];
}

/** A TOML basic string (JSON's escapes are a valid subset of TOML's). */
export function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function buildExecArgs(input: ExecArgsInput): string[] {
  const args = [
    'exec',
    '--strict-config',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--cd',
    input.cwd,
    '-c',
    'approval_policy="never"',
    '-c',
    `model_instructions_file=${tomlString(input.systemFile)}`,
  ];
  if (input.catalogFile) args.push('-c', `model_catalog_json=${tomlString(input.catalogFile)}`);
  if (input.model) args.push('--model', input.model);
  if (input.reasoningEffort) args.push('-c', `model_reasoning_effort=${tomlString(input.reasoningEffort)}`);
  args.push(
    '-c',
    'web_search="disabled"',
    '-c',
    'tools.web_search={enabled=false}',
    '-c',
    'tools.experimental_request_user_input={enabled=false}',
    '-c',
    'tools.update_plan={enabled=false}',
    '-c',
    'include_environment_context=false',
    '-c',
    'include_permissions_instructions=false',
    '-c',
    'include_apps_instructions=false',
    '-c',
    'include_collaboration_mode_instructions=false',
    '-c',
    'project_doc_max_bytes=0',
    '-c',
    'skills.include_instructions=false',
    '-c',
    'skills.bundled.enabled=false',
    '-c',
    'features.multi_agent_v2={enabled=false,usage_hint_enabled=false,root_agent_usage_hint_text="",multi_agent_mode_hint_text=""}',
  );
  for (const feature of input.disableFeatures) args.push('--disable', feature);
  for (const image of input.images) args.push('--image', image);
  args.push('--output-schema', input.schemaFile, '--output-last-message', input.outFile, '--json', '-');
  return args;
}
