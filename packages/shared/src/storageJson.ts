// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Models\Storage\StorageJson.cs
//
// The one serialization dialect for every JSON document persisted to Canvas
// course files, byte-compatible with the C# app's StorageJson options:
//   - camelCase property names (our objects are already camelCase — schemas
//     define the exact wire names)
//   - nulls omitted on write (C# WhenWritingNull); undefined omitted too
//   - enums as SNAKE_UPPER strings (modeled as z.enum with the exact values)
//   - 2-space indentation (C# WriteIndented — documents are inspected by
//     humans during support; bytes are cheap here)
//
// Forward-compatible by construction: document schemas use .passthrough() so
// unknown members written by a newer build survive a read-modify-write cycle
// here (the C# reader merely ignores them; we go one better and preserve them).

import { z } from 'zod';

/**
 * An ISO-8601 timestamp string as C# DateTimeOffset serializes it
 * (e.g. "2026-07-01T10:00:00+00:00", optional fractional seconds, "Z" or
 * numeric offset, offset-less tolerated). Kept as a STRING at this layer so
 * timestamps round-trip byte-for-byte.
 */
export const IsoDateTimeSchema = z.string().datetime({ offset: true, local: true });

/** Recursively drops null/undefined OBJECT PROPERTIES (array elements are kept,
 * matching C# WhenWritingNull, which only affects properties). */
function pruneNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruneNulls);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === null || entry === undefined) continue;
      out[key] = pruneNulls(entry);
    }
    return out;
  }
  return value;
}

/**
 * Serialize a storage document exactly as the C# app's StorageJson.Options
 * would: camelCase keys (already on the object), nulls omitted, 2-space
 * indent. Use this — and only this — when writing any document under the
 * "AI Grader" Canvas folder, so every document on disk has one
 * consistent dialect.
 */
export function serializeStorageDocument(doc: unknown): string {
  return JSON.stringify(pruneNulls(doc), null, 2);
}

/**
 * Parse a storage document written by either app. Unknown members survive
 * (schemas are .passthrough()), missing members take the C# model defaults.
 */
export function parseStorageDocument<S extends z.ZodTypeAny>(
  schema: S,
  json: string,
): z.infer<S> {
  return schema.parse(JSON.parse(json)) as z.infer<S>;
}
