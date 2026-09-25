// Canvas Link-header pagination.
//
// Ported from: C:\Devs\AIgrader\lib\canvas\client.ts (parseNextLink) —
// behavior pinned by C:\Devs\AIGrader-C#\tests\AiGrader.Tests\
// CanvasPaginationTests.cs (CanvasApiClient.GetNextPageUrl).
//
// Canvas's header looks like:
//   <https://…?page=2>; rel="next", <https://…?page=1>; rel="first"
// We must pull exactly the rel="next" URL and return null on the last page.

export function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const m = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
    if (m && m[1]) return m[1];
  }
  return null;
}
