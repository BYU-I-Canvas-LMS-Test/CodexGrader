// Verifies the Canvas Link-header parsing that drives pagination.
// Ported from: C:\Devs\AIGrader-C#\tests\AiGrader.Tests\CanvasPaginationTests.cs

import { describe, expect, it } from 'vitest';
import { parseNextLink } from '../src/pagination.js';

describe('parseNextLink', () => {
  it('parses the rel="next" URL from a realistic Canvas Link header', () => {
    const header =
      '<https://byuird.instructure.com/api/v1/courses/1/assignments?page=1&per_page=100>; rel="current",' +
      '<https://byuird.instructure.com/api/v1/courses/1/assignments?page=2&per_page=100>; rel="next",' +
      '<https://byuird.instructure.com/api/v1/courses/1/assignments?page=1&per_page=100>; rel="first"';

    expect(parseNextLink(header)).toBe(
      'https://byuird.instructure.com/api/v1/courses/1/assignments?page=2&per_page=100',
    );
  });

  it('returns null on the last page (no rel="next")', () => {
    const header =
      '<https://byuird.instructure.com/api/v1/courses/1/assignments?page=2>; rel="current",' +
      '<https://byuird.instructure.com/api/v1/courses/1/assignments?page=1>; rel="prev"';

    expect(parseNextLink(header)).toBeNull();
  });

  it('returns null when there is no Link header at all', () => {
    expect(parseNextLink(null)).toBeNull();
  });
});
