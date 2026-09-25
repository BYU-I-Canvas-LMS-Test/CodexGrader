// EnvConfigLoader: the forgiving parser for the teacher's hand-edited
// ~/.aigrader/.env, its plain-English refusals, token secrecy, the second
// instance, and live reload.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EnvConfigLoader,
  normalizeBaseUrl,
  normalizeToken,
  parseEnvConfig,
  parseEnvText,
} from '../src/env-config.js';

const TOKEN = '12345~AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

describe('parseEnvText', () => {
  it('handles a BOM, CRLF, export, comments, and every quote style', () => {
    const vars = parseEnvText(
      '﻿# my settings\r\nexport CANVAS_BASE_URL="https://byui.instructure.com"\r\n' +
        "CANVAS_API_TOKEN='abc'  \r\n" +
        'AIGRADER_MODEL=gpt-5 # the model\r\n' +
        'SMART=“quoted”\r\n' +
        'lower_case=yes\r\n' +
        'not a pair\r\n',
    );
    expect(vars.get('CANVAS_BASE_URL')).toBe('https://byui.instructure.com');
    expect(vars.get('CANVAS_API_TOKEN')).toBe('abc');
    expect(vars.get('AIGRADER_MODEL')).toBe('gpt-5');
    expect(vars.get('SMART')).toBe('quoted');
    expect(vars.get('LOWER_CASE')).toBe('yes');
    expect(vars.size).toBe(5);
  });

  it('an empty value followed by a comment is empty, not the comment', () => {
    const vars = parseEnvText('AIGRADER_MODEL=                    # blank = default\nCODEX_PATH=# none');
    expect(vars.get('AIGRADER_MODEL')).toBe('');
    expect(vars.get('CODEX_PATH')).toBe('');
  });

  it('keeps a # inside a quoted value', () => {
    expect(parseEnvText('X="a # b"').get('X')).toBe('a # b');
  });
});

describe('normalizeBaseUrl', () => {
  it.each([
    ['https://byui.instructure.com', 'https://byui.instructure.com'],
    ['https://byui.instructure.com/', 'https://byui.instructure.com'],
    ['https://byui.instructure.com/api/v1', 'https://byui.instructure.com'],
    ['https://BYUI.instructure.com/courses/123?x=1#frag', 'https://byui.instructure.com'],
    ['byui.instructure.com', 'https://byui.instructure.com'],
    ['https://byui.instructure.com:443', 'https://byui.instructure.com'],
    ['<https://canvas.example.edu>', 'https://canvas.example.edu'],
  ])('%s → %s', (raw, expected) => {
    const result = normalizeBaseUrl(raw);
    expect(result).toMatchObject({ ok: true, baseUrl: expected });
  });

  it.each([
    ['http://byui.instructure.com', /https:\/\//],
    ['https://user:pw@byui.instructure.com', /user name or password/],
    ['https://byui.instructure.com:8443', /port/],
    ['https://127.0.0.1', /school's Canvas address/],
    ['https://localhost', /school's Canvas address/],
    ['https://[::1]', /school's Canvas address/],
    ['', /empty/],
    ['ftp://x.example.com', /https/],
  ])('refuses %s in plain English', (raw, message) => {
    const result = normalizeBaseUrl(raw);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.problem).toMatch(message);
  });
});

describe('normalizeToken', () => {
  it('strips "Bearer ", quotes-already-removed whitespace, and line breaks', () => {
    expect(normalizeToken(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(normalizeToken(`  ${TOKEN.slice(0, 10)}\n${TOKEN.slice(10)} `)).toBe(TOKEN);
  });
});

describe('parseEnvConfig', () => {
  it('builds the primary and a second instance; never exposes the token in summaries', () => {
    const config = parseEnvConfig(
      [
        'CANVAS_BASE_URL=https://byui.instructure.com/api/v1',
        `CANVAS_API_TOKEN="Bearer ${TOKEN}"`,
        'CANVAS_BASE_URL_2=https://canvas.other.edu',
        `CANVAS_API_TOKEN_2=${TOKEN}zz`,
        'AIGRADER_MAX_WORKERS=3',
        'AIGRADER_REASONING_EFFORT=High',
        'AIGRADER_UI_PORT=48000',
      ].join('\n'),
      '/home/t/.aigrader/.env',
    );
    expect(config.problems).toEqual([]);
    expect(config.entries).toEqual([
      { baseUrl: 'https://byui.instructure.com', token: TOKEN },
      { baseUrl: 'https://canvas.other.edu', token: `${TOKEN}zz` },
    ]);
    expect(config.instances).toEqual([
      { index: 1, baseUrl: 'https://byui.instructure.com', host: 'byui.instructure.com', tokenHint: '…6789' },
      { index: 2, baseUrl: 'https://canvas.other.edu', host: 'canvas.other.edu', tokenHint: '…89zz' },
    ]);
    expect(config.settings).toEqual({ maxWorkers: 3, reasoningEffort: 'high', uiPort: 48000 });
    expect(JSON.stringify({ ...config, entries: undefined })).not.toContain(TOKEN.slice(0, 12));
  });

  it('explains a missing token, an http URL, and a swapped URL/token — without echoing the token', () => {
    const missing = parseEnvConfig('CANVAS_BASE_URL=https://byui.instructure.com\nCANVAS_API_TOKEN=', 'f');
    expect(missing.entries).toEqual([]);
    expect(missing.problems[0]).toMatch(/CANVAS_API_TOKEN is empty/);
    expect(missing.instances[0]!.tokenHint).toBeNull();

    const http = parseEnvConfig(`CANVAS_BASE_URL=http://byui.instructure.com\nCANVAS_API_TOKEN=${TOKEN}`, 'f');
    expect(http.entries).toEqual([]);
    expect(http.problems.join(' ')).toMatch(/https:\/\//);
    expect(http.problems.join(' ')).not.toContain(TOKEN);

    const swapped = parseEnvConfig(
      `CANVAS_BASE_URL=${TOKEN}\nCANVAS_API_TOKEN=https://byui.instructure.com`,
      'f',
    );
    expect(swapped.entries).toEqual([]);
    expect(swapped.problems.join(' ')).toMatch(/looks like a web address/);
    expect(swapped.problems.join(' ')).not.toContain(TOKEN);
  });

  it('flags the placeholder, a too-short token, bad settings, and a missing file', () => {
    expect(
      parseEnvConfig('CANVAS_BASE_URL=https://a.instructure.com\nCANVAS_API_TOKEN=paste-your-token-here', 'f')
        .problems[0],
    ).toMatch(/placeholder/);
    expect(
      parseEnvConfig('CANVAS_BASE_URL=https://a.instructure.com\nCANVAS_API_TOKEN=abc', 'f').problems[0],
    ).toMatch(/too short/);
    const bad = parseEnvConfig(
      `CANVAS_BASE_URL=https://a.instructure.com\nCANVAS_API_TOKEN=${TOKEN}\nAIGRADER_MAX_WORKERS=12`,
      'f',
    );
    expect(bad.entries).toHaveLength(1);
    expect(bad.problems[0]).toMatch(/AIGRADER_MAX_WORKERS/);
    expect(parseEnvConfig(null, '/x/.env')).toMatchObject({ exists: false, entries: [] });
  });

  it('ignores an empty commented-out second-instance template', () => {
    const config = parseEnvConfig(
      `CANVAS_BASE_URL=https://a.instructure.com\nCANVAS_API_TOKEN=${TOKEN}\nCANVAS_BASE_URL_2=\nCANVAS_API_TOKEN_2=`,
      'f',
    );
    expect(config.problems).toEqual([]);
    expect(config.entries).toHaveLength(1);
  });
});

describe('EnvConfigLoader', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('reloads on change and fires onChange only when something changed', () => {
    dir = mkdtempSync(join(tmpdir(), 'aigrader-env-'));
    const file = join(dir, '.env');
    writeFileSync(file, `CANVAS_BASE_URL=https://a.instructure.com\nCANVAS_API_TOKEN=${TOKEN}`);
    const changes: number[] = [];
    const loader = new EnvConfigLoader(file, { onChange: (c) => changes.push(c.entries.length) });
    expect(loader.current.entries).toHaveLength(1);

    loader.reload();
    expect(changes).toEqual([]); // same content

    writeFileSync(file, `CANVAS_BASE_URL=https://a.instructure.com\nCANVAS_API_TOKEN=${TOKEN}rotated`);
    loader.reload();
    expect(changes).toEqual([1]);
    expect(loader.current.entries[0]!.token).toBe(`${TOKEN}rotated`);
  });

  it('watches the file (poll) and picks up an edit without a restart', async () => {
    dir = mkdtempSync(join(tmpdir(), 'aigrader-env-'));
    const file = join(dir, '.env');
    writeFileSync(file, 'CANVAS_BASE_URL=https://a.instructure.com\nCANVAS_API_TOKEN=');
    const seen: number[] = [];
    const loader = new EnvConfigLoader(file, { pollMs: 20, onChange: (c) => seen.push(c.entries.length) });
    loader.watch();
    try {
      await new Promise((r) => setTimeout(r, 60));
      writeFileSync(file, `CANVAS_BASE_URL=https://a.instructure.com\nCANVAS_API_TOKEN=${TOKEN}`);
      for (let i = 0; i < 100 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(seen).toEqual([1]);
    } finally {
      loader.close();
    }
  });
});
