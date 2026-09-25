// Multi-instance Canvas routing support.
//
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Canvas\CanvasDomains.cs
// (behavior pinned by tests\AiGrader.Tests\CanvasDomainsTests.cs).
//
// Institutions can run several Canvas instances joined by Canvas trust
// (byui.instructure.com, byuird.instructure.com, …); one API token works
// across all of them, but every REST call must target the instance the course
// actually lives on. The course key ("host#courseId") names that instance,
// and these helpers normalize/validate the host before any client binds to
// it (the C# app got it from the LTI launch's canvas_api_domain).
//
// This is a token-exfiltration guard, not a convenience: the clients attach
// the Canvas API token to whatever base URL they are bound to, so an unvetted
// launch-supplied domain must never become a request target.

export const DEFAULT_TRUSTED_SUFFIXES: readonly string[] = ['.instructure.com'];

/**
 * Normalizes a raw `canvas_api_domain` value to a bare lowercase host
 * (e.g. "byui.instructure.com"). Returns null when the value is absent, is an
 * unsubstituted `$Canvas.api.domain` literal (Canvas echoes the variable name
 * when a registration predates the parameter), or does not parse as a host —
 * null means "use the configured default instance".
 *
 * Accepts a bare host or a full URL (scheme/path stripped); an explicit
 * non-default port survives (self-hosted or local test Canvas).
 */
export function normalizeHost(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (trimmed.startsWith('$')) return null; // unsubstituted variable literal

  // Canvas sends a bare host; tolerate a scheme'd value anyway.
  const value = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.hostname === '') return null;

  // WHATWG URL lowercases the hostname and drops a scheme-default port, so
  // `url.host` is already the C# `IsDefaultPort ? Host : Host:Port` shape.
  return url.host.toLowerCase();
}

/**
 * True when `host` (a normalized host from normalizeHost) matches the suffix
 * allowlist and may therefore receive the API token. ".instructure.com"
 * matches "byui.instructure.com" and "instructure.com" itself, but never
 * "evilinstructure.com" — matching is on dot boundaries.
 *
 * Note: the C# IsTrusted also treated the configured default instance as
 * always-trusted; in this port that half lives in CanvasClient.forDomain
 * (a host equal to the client's own base URL short-circuits before the
 * suffix check).
 */
export function isTrustedHost(
  host: string,
  trustedSuffixes: readonly string[] = DEFAULT_TRUSTED_SUFFIXES,
): boolean {
  const h = host.toLowerCase();
  for (const suffix of trustedSuffixes) {
    const s = suffix.trim().toLowerCase();
    if (s === '') continue;
    const bare = s.replace(/^\.+/, '');
    if (bare === '') continue;
    if (h === bare || h.endsWith(`.${bare}`)) return true;
  }
  return false;
}
