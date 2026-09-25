// The review UI: the built Next.js app (apps/web) served by this process's
// own HTTP server (a Next "custom server"). `next` is resolved FROM the web
// app's folder so the server uses exactly the Next that built it.
//
// Layout (repo and release bundle alike): apps/aigrader/{src|dist}/web.* →
// ../../web is apps/web. AIGRADER_WEB_DIR overrides it.

import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface WebHandler {
  handle(req: IncomingMessage, res: ServerResponse): void | Promise<void>;
  close?(): void | Promise<void>;
}

export function resolveWebDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AIGRADER_WEB_DIR?.trim() || fileURLToPath(new URL('../../web', import.meta.url));
}

interface NextServerLike {
  prepare(): Promise<void>;
  getRequestHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  close?(): Promise<void>;
}

type NextFactory = (options: {
  dev: boolean;
  dir: string;
  hostname: string;
  port: number;
  customServer?: boolean;
  quiet?: boolean;
}) => NextServerLike;

export async function createNextHandler(opts: { dir: string; port: number }): Promise<WebHandler> {
  if (!existsSync(join(opts.dir, '.next', 'BUILD_ID'))) {
    throw new Error(
      `The review page has not been built (no ${join(opts.dir, '.next')}). Reinstall AI Grader, or run \`pnpm build\` in a source checkout.`,
    );
  }
  process.env.NEXT_TELEMETRY_DISABLED = '1';
  const require = createRequire(join(opts.dir, 'package.json'));
  const loaded = require('next') as NextFactory | { default: NextFactory };
  const next = typeof loaded === 'function' ? loaded : loaded.default;
  const app = next({
    dev: false,
    dir: opts.dir,
    hostname: '127.0.0.1',
    port: opts.port,
    customServer: true,
    quiet: true,
  });
  await app.prepare();
  const handle = app.getRequestHandler();
  return {
    handle: (req, res) => handle(req, res),
    close: () => app.close?.(),
  };
}
