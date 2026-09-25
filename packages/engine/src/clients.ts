// The engine's Canvas client factory: course host → the teacher's configured
// credential (src/credentials.ts) → CanvasClient + CanvasFilesClient bound to
// that instance → document stores.
//
// The document stores are built ONCE per credential and reused for every
// request and run on that instance. That matters: CourseDocumentStore owns
// the per-course write gate and the read caches, so a store rebuilt per
// request would let two writers interleave a read-modify-write (e.g. two
// material uploads racing on resources.json) and would defeat the caches.
//
// API traffic and file traffic share ONE per-token gate (Canvas rate-limits
// per token). Tokens are pinned to their own instance: forDomain to any other
// host throws (token-exfiltration guard) unless that host has its own
// configured credential, in which case its own client is used instead.

import {
  AlignmentStore,
  CanvasGateRegistry,
  CourseDocumentStore,
  ProfileStore,
  ResourceStore,
  RunStore,
  createCanvasClient,
  createCanvasFilesClient,
  type CanvasClient,
  type FetchLike,
} from '@aigrader/canvas';
import type { RunClientFactory } from './coordinator/engine.js';
import type { CanvasCredential, CanvasCredentialProvider } from './credentials.js';

export interface CourseClientFactoryDeps {
  /** The teacher's configured Canvas instances (from ~/.aigrader/.env). */
  credentials: CanvasCredentialProvider;
  /** The app-wide per-token gate registry singleton. */
  gates: CanvasGateRegistry;
  /** fetch injection (tests). */
  fetchImpl?: FetchLike;
}

/** The CONCRETE client bundle one Canvas instance resolves to. The engine
 * consumes this through its narrower structural ports (RunClients); the
 * /course service routes need the full store surfaces (save/upload/import),
 * so the concrete types are exposed here. */
export interface CourseClients {
  canvas: CanvasClient;
  runStore: RunStore;
  profiles: ProfileStore;
  resources: ResourceStore;
  alignment: AlignmentStore;
}

export type CourseClientFactory = (args: { apiDomain: string | null }) => Promise<CourseClients>;

export function createCourseClientFactory(deps: CourseClientFactoryDeps): CourseClientFactory {
  // One bundle per (host, token). A rotated token (new sha) builds a fresh
  // bundle; the old one is simply dropped.
  const bundles = new Map<string, CourseClients>();

  function build(credential: CanvasCredential): CourseClients {
    const options = {
      baseUrl: credential.baseUrl,
      token: credential.token,
      gate: deps.gates.gateFor(credential.tokenSha256),
      trustedSuffixes: [] as string[],
      ...(deps.fetchImpl ? { fetch: deps.fetchImpl } : {}),
    };
    const canvas = createCanvasClient(options);
    const files = createCanvasFilesClient(options);
    const store = new CourseDocumentStore({ files, apiDomain: credential.host });
    return {
      canvas,
      runStore: new RunStore({ store }),
      profiles: new ProfileStore(store),
      resources: new ResourceStore({ store }),
      alignment: new AlignmentStore(store),
    };
  }

  return async ({ apiDomain }): Promise<CourseClients> => {
    const credential = deps.credentials.forHost(apiDomain);
    const key = `${credential.host}:${credential.tokenSha256}`;
    let bundle = bundles.get(key);
    if (!bundle) {
      bundle = build(credential);
      bundles.set(key, bundle);
    }
    return bundle;
  };
}

/** The engine's factory: the same concrete clients, consumed through the
 * engine's structural ports (CanvasClient/stores satisfy them). */
export function createRunClientFactory(deps: CourseClientFactoryDeps): RunClientFactory {
  return createCourseClientFactory(deps);
}
