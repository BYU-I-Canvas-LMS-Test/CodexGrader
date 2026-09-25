// Plain-text and HTML extraction for Canvas `online_text_entry` submissions.
//
// Ported from: C:\Devs\AIgrader\lib\extract\text.ts
//
// Canvas stores rich-text submissions as HTML inside `submission.body`.
// Faculty paste-in text is wrapped in <p> tags by the WYSIWYG editor.
// The grader does not need the markup — it only reads prose — so we
// strip tags, decode the small set of named entities Canvas inserts, and
// collapse whitespace.

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  ndash: '–',
  mdash: '—',
  hellip: '…',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const cp = parseInt(body.slice(2), 16);
      if (!Number.isFinite(cp)) return whole;
      try {
        return String.fromCodePoint(cp);
      } catch {
        return whole;
      }
    }
    if (body.startsWith('#')) {
      const cp = parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp)) return whole;
      try {
        return String.fromCodePoint(cp);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

export function stripHtml(html: string): string {
  // Replace block-level tags with newlines so paragraph breaks survive.
  // Then strip the rest. Then decode entities. Then collapse whitespace.
  const blockified = html
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  const decoded = decodeEntities(blockified);
  return decoded
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

export function extractOnlineTextEntry(body: string): string {
  return stripHtml(body);
}
