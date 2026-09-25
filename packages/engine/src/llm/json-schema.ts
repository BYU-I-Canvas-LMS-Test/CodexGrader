// The JSON Schema subset the engine hands a model as its REQUIRED output
// shape (codex exec --output-schema). Strict mode rules, enforced by
// tests/response-schemas.test.ts: every object sets additionalProperties:false
// and lists every one of its properties in `required`.

/** A (strict-mode) JSON Schema node. */
export type JsonSchema = {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  description?: string;
  enum?: string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: JsonSchema;
};
