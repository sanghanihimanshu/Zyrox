import { describe, expect, it } from 'vitest';
import { BUILTIN_HELPER_NAMES, createBuiltinHelpers, satisfies } from '../src/helpers';

describe('satisfies', () => {
  it.each([
    ['3.4.1', '>=3.4', true],
    ['3.3.9', '>=3.4', false],
    ['3.4.1', '>=3.4 <4', true],
    ['4.0.0', '>=3.4 <4', false],
    ['1.2.3', '1.2.3', true],
    ['1.2.3', '=1.2.4', false],
    ['3.9.0', '^3.4', true],
    ['4.0.0', '^3.4', false],
    ['0.3.1', '^0.3.0', true],
    ['0.4.0', '^0.3.0', false],
    ['3.4.9', '~3.4.1', true],
    ['3.5.0', '~3.4.1', false],
    ['2.0.0', '*', true],
    ['garbage', '>=1', false],
    ['v2.1', '>2', true],
  ])('%s %s → %s', (v, range, expected) => {
    expect(satisfies(v, range)).toBe(expected);
  });
});

describe('helpers', () => {
  const h = createBuiltinHelpers(() => 'en-US') as any;
  it('formats', () => {
    expect(h.format.currency(1234.5, 'EUR')).toBe('€1,234.50');
    expect(h.format.number(Math.PI)).toBe('3.14');
    expect(h.format.percent(0.25)).toBe('25%');
    expect(h.format.date('2026-01-15T10:00:00Z', 'long')).toMatch(/January 1[45], 2026/);
    expect(h.format.currency('x')).toBe('');
  });
  it('works on collections', () => {
    expect(h.coalesce(null, undefined, 0, 1)).toBe(0);
    expect(h.join(['a', 'b'], '-')).toBe('a-b');
    expect(h.includes('abc', 'b')).toBe(true);
    expect(h.slice([1, 2, 3], 1)).toEqual([2, 3]);
    expect(h.round(1.256, 2)).toBe(1.26);
  });
  it('lists names', () => {
    expect(BUILTIN_HELPER_NAMES).toContain('format.currency');
    expect(BUILTIN_HELPER_NAMES).toContain('len');
  });
});
