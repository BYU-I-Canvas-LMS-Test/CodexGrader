// The allowlist sanitizer guards every same-origin render path the viewer
// has: mammoth's DOCX→HTML output, RTF conversions, student text-entry
// bodies, and quiz answer HTML. These tests pin the security behavior:
// active content never survives, student words always do.
//
// Ported from: C:\Devs\AIGrader-C#\tests\AiGrader.Tests\PreviewHtmlSanitizerTests.cs
// — every case, including the expanded unsafe-scheme theory rows.

import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from '../src/sanitize-html.js';

describe('sanitizeHtml (PreviewHtmlSanitizer port)', () => {
  it('removes script and style blocks INCLUDING their content', () => {
    const html = "<p>keep</p><script>alert('xss')</script><style>p{color:red}</style>";
    const clean = sanitizeHtml(html);
    expect(clean).toContain('<p>keep</p>');
    expect(clean.toLowerCase()).not.toContain('script');
    expect(clean).not.toContain('alert');
    expect(clean).not.toContain('color:red');
  });

  it('strips event handlers and inline styles from allowed tags', () => {
    const clean = sanitizeHtml(
      '<p onclick="steal()" style="position:fixed" class="x" id="y">text</p><img src="https://a/b.png" onerror="steal()">',
    );
    expect(clean.toLowerCase()).not.toContain('onclick');
    expect(clean.toLowerCase()).not.toContain('onerror');
    expect(clean.toLowerCase()).not.toContain('style');
    expect(clean).not.toContain('steal');
    expect(clean).toContain('>text</p>');
  });

  it.each([
    ['javascript:alert(1)'],
    ['vbscript:x'],
    ['data:text/html,<script>1</script>'],
    ['file:///etc/passwd'],
  ])('drops unsafe link scheme %s (href gone, text survives)', (href) => {
    const clean = sanitizeHtml(`<a href="${href}">link</a>`);
    expect(clean.toLowerCase()).not.toContain('href');
    expect(clean).toContain('link'); // the text survives
  });

  it('safe links survive with target=_blank and noopener', () => {
    const clean = sanitizeHtml('<a href="https://example.edu/page">site</a>');
    expect(clean).toContain('href="https://example.edu/page"');
    expect(clean).toContain('target="_blank"');
    expect(clean).toContain('rel="noopener noreferrer"');
  });

  it('image sources restricted to http(s) and data:image', () => {
    const kept = sanitizeHtml('<img src="data:image/png;base64,AAAA" alt="fig">');
    expect(kept).toContain('src="data:image/png;base64,AAAA"');
    expect(kept).toContain('alt="fig"');

    const dropped = sanitizeHtml('<img src="data:text/html;base64,AAAA">');
    expect(dropped.toLowerCase()).not.toContain('src');
  });

  it('unknown-but-benign tags unwrap to their content — student words never vanish', () => {
    const clean = sanitizeHtml(
      '<article><section><p>the essay</p></section></article><custom>note</custom>',
    );
    expect(clean).toContain('<p>the essay</p>');
    expect(clean).toContain('note');
    expect(clean).not.toContain('<article');
    expect(clean).not.toContain('<custom');
  });

  it('preserves allowed document structure (tables keep span attributes)', () => {
    const html =
      '<h2>Title</h2><ul><li>one</li></ul><table><tr><td colspan="2">cell</td></tr></table><pre><code>x=1</code></pre>';
    const clean = sanitizeHtml(html);
    expect(clean).toContain('<h2>Title</h2>');
    expect(clean).toContain('<li>one</li>');
    expect(clean).toContain('colspan="2"');
    expect(clean).toContain('<code>x=1</code>');
  });

  it('handles edge inputs: null/blank → empty; iframes/objects removed entirely', () => {
    expect(sanitizeHtml(null)).toBe('');
    expect(sanitizeHtml(undefined)).toBe('');
    expect(sanitizeHtml('   ')).toBe('');
    const clean = sanitizeHtml('<iframe src="https://evil"></iframe><object data="x"></object><p>ok</p>');
    expect(clean.trim()).toBe('<p>ok</p>');
  });

  it('comments are removed', () => {
    const clean = sanitizeHtml('<p>a</p><!-- hidden -->');
    expect(clean).toContain('<p>a</p>');
    expect(clean).not.toContain('hidden');
    expect(clean).not.toContain('<!--');
  });
});
