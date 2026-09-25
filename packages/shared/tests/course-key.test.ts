import { describe, it, expect } from 'vitest';
import { makeCourseKey, parseCourseKey } from '../src/index.js';

describe('makeCourseKey', () => {
  it('builds "${host}#${courseId}"', () => {
    expect(makeCourseKey('byui.instructure.com', 4409)).toBe('byui.instructure.com#4409');
  });

  it('accepts a numeric-string course id and canonicalizes it', () => {
    expect(makeCourseKey('byupw.instructure.com', '4409')).toBe('byupw.instructure.com#4409');
    expect(makeCourseKey('byupw.instructure.com', '007')).toBe('byupw.instructure.com#7');
  });

  it('accepts a single-label host (local development)', () => {
    expect(makeCourseKey('localhost', 1)).toBe('localhost#1');
  });

  it('rejects hosts with a scheme, port, path, or uppercase letters', () => {
    expect(() => makeCourseKey('https://byui.instructure.com', 1)).toThrow(/bare lowercase hostname/);
    expect(() => makeCourseKey('byui.instructure.com:443', 1)).toThrow(/bare lowercase hostname/);
    expect(() => makeCourseKey('byui.instructure.com/courses', 1)).toThrow(/bare lowercase hostname/);
    expect(() => makeCourseKey('Byui.Instructure.com', 1)).toThrow(/bare lowercase hostname/);
    expect(() => makeCourseKey('', 1)).toThrow(/bare lowercase hostname/);
    expect(() => makeCourseKey('byui.instructure.com.', 1)).toThrow(/bare lowercase hostname/);
  });

  it('rejects non-positive, fractional, and non-numeric course ids', () => {
    expect(() => makeCourseKey('byui.instructure.com', 0)).toThrow(/positive integer/);
    expect(() => makeCourseKey('byui.instructure.com', -5)).toThrow(/positive integer/);
    expect(() => makeCourseKey('byui.instructure.com', 1.5)).toThrow(/positive integer/);
    expect(() => makeCourseKey('byui.instructure.com', 'abc')).toThrow(/positive integer/);
    expect(() => makeCourseKey('byui.instructure.com', '12a')).toThrow(/positive integer/);
  });
});

describe('parseCourseKey', () => {
  it('round-trips makeCourseKey output', () => {
    const key = makeCourseKey('byui.instructure.com', 4409);
    expect(parseCourseKey(key)).toEqual({ host: 'byui.instructure.com', courseId: 4409 });
  });

  it('rejects keys without the separator or with malformed parts', () => {
    expect(() => parseCourseKey('byui.instructure.com')).toThrow(/separator/);
    expect(() => parseCourseKey('#4409')).toThrow(/bare lowercase hostname/);
    expect(() => parseCourseKey('byui.instructure.com#')).toThrow(/positive integer/);
    expect(() => parseCourseKey('byui.instructure.com#abc')).toThrow(/positive integer/);
    expect(() => parseCourseKey('byui.instructure.com#1#2')).toThrow(/positive integer/);
    expect(() => parseCourseKey('https://byui.instructure.com#1')).toThrow(/bare lowercase hostname/);
  });
});
