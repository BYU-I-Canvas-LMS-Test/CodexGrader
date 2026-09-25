// Ported from: C:\Devs\AIgrader\lib\extract\text.ts (stripHtml + decodeEntities)
//
// HTML → plain text for Canvas rich content used inside prompt assembly
// (quiz question prompts). The C# HtmlTextExtractor.StripHtml is itself a
// port of this function; the TS regex form is the original and stays the
// implementation here (pure-JS, no parser dependency). Kept local to the
// prompts module — do NOT import @aigrader/extraction from prompt code.

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
