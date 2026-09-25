// Opens a URL in the teacher's default browser — the ONLY way a review
// session starts (the URL carries a single-use, 30-second login token, so it
// is never printed or returned to Codex; it goes straight to the OS).

import { spawn } from 'node:child_process';

export type BrowserOpener = (url: string) => void;

export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  // No shell anywhere: the URL's `&` and `?` must reach the browser intact.
  const [command, args] =
    platform === 'win32'
      ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  const child = spawn(command, args as string[], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => undefined);
  child.unref();
}
