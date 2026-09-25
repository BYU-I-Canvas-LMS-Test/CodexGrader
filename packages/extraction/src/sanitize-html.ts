// Allowlist HTML sanitizer for untrusted student content rendered same-origin
// in the review UI: mammoth's DOCX→HTML output, RTF conversions, text-entry
// submission bodies, and quiz answer HTML. This is the CANONICAL sanitizer —
// it lives in @aigrader/extraction because conversion happens in the engine
// (the engine owns Canvas; apps/web only relays).
// The web tier NEVER sanitizes: it only renders HTML that already passed
// through here.
//
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Viewing\PreviewHtmlSanitizer.cs
// (HtmlAgilityPack → parse5). The allowlist logic is a 1:1 port; behavior is
// pinned by tests/sanitize-html.test.ts (the PreviewHtmlSanitizerTests port —
// the XSS suite). Non-allowlisted elements are unwrapped to their children
// (never dropped) so no student words vanish; only outright dangerous
// containers (script/style/iframe/…) are removed with their content.

import { parseFragment, serialize, defaultTreeAdapter as adapter } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

type Node = DefaultTreeAdapterMap['node'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];
type Element = DefaultTreeAdapterMap['element'];

/** Elements allowed through with (scrubbed) attributes. */
const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption',
  'strong', 'em', 'b', 'i', 'u', 's', 'a', 'img', 'br', 'hr',
  'blockquote', 'pre', 'code', 'sup', 'sub', 'span', 'div',
  'figure', 'figcaption',
]);

/** Elements removed INCLUDING their content — their inner text is code or
 * chrome, not student prose. */
const DROPPED_WITH_CONTENT: ReadonlySet<string> = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed',
  'applet', 'form', 'input', 'button', 'select', 'textarea', 'option',
  'link', 'meta', 'base', 'svg', 'math', 'video', 'audio', 'source',
  'track', 'canvas', 'template', 'noscript',
]);

/**
 * Returns HTML reduced to the allowlist: unknown elements are unwrapped to
 * their children, scripts/styles/event handlers/inline styles removed, links
 * restricted to http(s) and forced to open in a new tab, and image sources
 * restricted to http(s) or data:image (mammoth inlines embedded pictures as
 * data URIs). Null/blank input yields an empty string.
 */
export function sanitizeHtml(html: string | null | undefined): string {
  if (html == null || html.trim() === '') return '';
  const fragment = parseFragment(html);
  sanitizeChildren(fragment);
  return serialize(fragment);
}

function sanitizeChildren(parent: ParentNode): void {
  // Snapshot first — sanitizing mutates the child collection.
  for (const child of [...parent.childNodes]) sanitizeNode(child);
}

function isElement(node: Node): node is Element {
  return 'tagName' in node && typeof (node as Element).tagName === 'string';
}

function sanitizeNode(node: Node): void {
  if (node.nodeName === '#comment') {
    adapter.detachNode(node);
    return;
  }
  if (!isElement(node)) return; // text nodes pass through (the serializer entity-encodes them)

  const name = node.tagName.toLowerCase();

  if (DROPPED_WITH_CONTENT.has(name)) {
    adapter.detachNode(node);
    return;
  }

  if (!ALLOWED_TAGS.has(name)) {
    // Unwrap: keep the (sanitized) children, drop the element itself.
    sanitizeChildren(node);
    const parent = node.parentNode;
    if (parent) {
      for (const child of [...node.childNodes]) {
        adapter.insertBefore(parent, child, node);
      }
    }
    adapter.detachNode(node);
    return;
  }

  scrubAttributes(node, name);
  sanitizeChildren(node);
}

function scrubAttributes(node: Element, name: string): void {
  node.attrs = node.attrs.filter((attr) => {
    const attrName = attr.name.toLowerCase();
    if (name === 'a' && attrName === 'href') return isSafeLinkHref(attr.value);
    if (name === 'img' && attrName === 'src') return isSafeImageSrc(attr.value);
    if (name === 'img' && attrName === 'alt') return true;
    if ((name === 'td' || name === 'th') && (attrName === 'colspan' || attrName === 'rowspan')) {
      return true;
    }
    return false; // everything else — on*, style, class, id — goes
  });

  // Surviving links open in a new tab and never get window.opener.
  if (name === 'a' && node.attrs.some((a) => a.name.toLowerCase() === 'href')) {
    setAttribute(node, 'target', '_blank');
    setAttribute(node, 'rel', 'noopener noreferrer');
  }
}

function setAttribute(node: Element, name: string, value: string): void {
  const existing = node.attrs.find((a) => a.name.toLowerCase() === name);
  if (existing) existing.value = value;
  else node.attrs.push({ name, value });
}

function isSafeLinkHref(value: string | null | undefined): boolean {
  const v = (value ?? '').trim();
  if (v === '') return false;
  try {
    const url = new URL(v); // throws for relative/invalid — absolute URIs only, like C# Uri.TryCreate(Absolute)
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isSafeImageSrc(value: string | null | undefined): boolean {
  const v = (value ?? '').trim();
  return v.toLowerCase().startsWith('data:image/') || isSafeLinkHref(v);
}
