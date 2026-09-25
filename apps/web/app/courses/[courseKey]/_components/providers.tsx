'use client';

// FluentProvider boundary for the course surfaces — the views keep Fluent v9
// for interactive form primitives (Textarea, Checkbox, Dropdown, SpinButton),
// retinted to the BYU-Idaho Brand Blue ramp.
//
// Also installs the review page's CSRF echo ONCE: every same-origin
// non-GET fetch gets the `x-aigrader-csrf` header copied from the readable
// CSRF cookie set at session start. The server's browserMutationGuard
// requires it (plus Origin / Sec-Fetch-Site, which the browser supplies), so
// only this page — never a script calling localhost — can mutate or approve.

import { FluentProvider } from '@fluentui/react-components';
import { useEffect } from 'react';
import { byuiLightTheme } from '../../../../theme/byui-theme';

const CSRF_COOKIE = 'aigrader_csrf';
const CSRF_HEADER = 'x-aigrader-csrf';

function readCsrf(): string | null {
  const match = document.cookie.split('; ').find((c) => c.startsWith(`${CSRF_COOKIE}=`));
  return match ? decodeURIComponent(match.slice(CSRF_COOKIE.length + 1)) : null;
}

let patched = false;

function installCsrfEcho(): void {
  if (patched || typeof window === 'undefined') return;
  patched = true;
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      window.location.href,
    );
    if (method !== 'GET' && method !== 'HEAD' && url.origin === window.location.origin) {
      const csrf = readCsrf();
      if (csrf) {
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        headers.set(CSRF_HEADER, csrf);
        return original(input, { ...init, headers });
      }
    }
    return original(input, init);
  };
}

export function CourseProviders({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    installCsrfEcho();
  }, []);
  return (
    <FluentProvider theme={byuiLightTheme} style={{ background: 'transparent' }}>
      {children}
    </FluentProvider>
  );
}
