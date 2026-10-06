import { describe, expect, it } from 'vitest';
import { type EvalEnv, ExprError, evaluate, MISSING, parseExpression, splitTemplate } from '../src/expr';
import { createBuiltinHelpers, helperFunctions } from '../src/helpers';

const helpers = createBuiltinHelpers(() => 'en-US');
const callable = helperFunctions(helpers);

function run(src: string, vars: Record<string, unknown> = {}, tracked?: string[]) {
  const env: EvalEnv = {
    lookup: (name) => (name in vars ? vars[name] : name in helpers ? (helpers as any)[name] : MISSING),
    isCallable: (fn) => typeof fn === 'function' && callable.has(fn),
    track: tracked ? (p) => tracked.push(p) : undefined,
  };
  return evaluate(parseExpression(src), env);
}

describe('expressions', () => {
  it.each([
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['10 - 4 - 3', 3],
    ['2 * 3 % 4', 2],
    ['-2 + +3', 1],
    ['1.5e2', 150],
    ['.5 + .5', 1],
    ['\'a\' + "b"', 'ab'],
    ["'it\\'s'", "it's"],
    ["'\\u0041'", 'A'],
    ['1 < 2 && 2 <= 2', true],
    ['3 > 4 || 4 >= 4', true],
    ['1 == 1', true],
    ["1 == '1'", false],
    ["1 != '1'", true],
    ['null ?? 5', 5],
    ['0 ?? 5', 0],
    ['0 || 5', 5],
    ['!0', true],
    ['true ? 1 : 2', 1],
    ['false ? 1 : true ? 2 : 3', 2],
    ['[1, 2, 3][1]', 2],
    ["{ a: 1, 'b c': 2 }['b c']", 2],
    ['[1,2,].length', 2],
    ['"abc".length', 3],
  ])('%s', (src, expected) => {
    expect(run(src)).toEqual(expected);
  });

  it('reads scope with null-safe member access', () => {
    const vars = { state: { user: { name: 'Ada', tags: ['x'] } }, item: null };
    expect(run('state.user.name', vars)).toBe('Ada');
    expect(run('state.user.tags[0]', vars)).toBe('x');
    expect(run('state.missing.deep.path', vars)).toBeUndefined();
    expect(run('item.name', vars)).toBeUndefined();
    expect(run('item?.name ?? "none"', vars)).toBe('none');
    expect(run('nothing', vars)).toBeUndefined();
    expect(run('{ name: state.user.name, n }', { ...vars, n: 2 })).toEqual({ name: 'Ada', n: 2 });
    expect(run('a ? .5 : 1', { a: true })).toBe(0.5);
  });

  it('tracks the paths it reads', () => {
    const tracked: string[] = [];
    const vars = { state: { a: { b: 1 }, list: [{ v: 2 }], i: 0 } };
    run('state.a.b + state.list[state.i].v', vars, tracked);
    expect(tracked).toEqual(['state.a.b', 'state.i', 'state.list.0.v']);
  });

  it('calls helpers but nothing else', () => {
    expect(run("upper('hi')")).toBe('HI');
    expect(run("format.currency(5, 'USD')")).toBe('$5.00');
    expect(run('len([1,2]) + len("abc") + len({a: 1})')).toBe(6);
    expect(() => run('fn()', { fn: () => 1 })).toThrow(/not a helper/);
    expect(() => run('state.fn()', { state: { fn: () => 1 } })).toThrow(/not a helper/);
  });

  it('blocks prototype and global access', () => {
    const vars = { state: { a: 1 }, s: 'x', arr: [] };
    expect(run('state.constructor', vars)).toBeUndefined();
    expect(run('state.__proto__', vars)).toBeUndefined();
    expect(run("state['__proto__']", vars)).toBeUndefined();
    expect(run('s.constructor', vars)).toBeUndefined();
    expect(run('arr.map', vars)).toBeUndefined();
    expect(run('globalThis', vars)).toBeUndefined();
    expect(run('{ __proto__: 1 }', vars)).toEqual({});
    expect(() => run('s.toUpperCase()', vars)).toThrow(/not a helper/);
    expect(() => run("upper.constructor('return 1')()")).toThrow();
  });

  it.each(['a =  1', 'a => 1', '1 +', '(1', "'open", 'a.', 'a b', '{ a: }', 'x++', 'new Foo()', '`t`'])(
    'rejects %s',
    (src) => {
      expect(() => parseExpression(src)).toThrow(ExprError);
    },
  );

  it('limits size and depth', () => {
    expect(() => parseExpression(`${'1+'.repeat(1500)}1`)).toThrow(/too long|too large/);
    expect(() => parseExpression(`${'('.repeat(100)}1${')'.repeat(100)}`)).toThrow(/nested/);
    expect(() => parseExpression(Array.from({ length: 600 }, (_, i) => `a${i % 9}`).join('+'))).toThrow(
      /too large/,
    );
  });
});

describe('splitTemplate', () => {
  it('splits text and expressions', () => {
    expect(splitTemplate('Hi {{ user.name }}!')).toEqual(['Hi ', { src: 'user.name' }, '!']);
    expect(splitTemplate('{{a}}{{b}}')).toEqual([{ src: 'a' }, { src: 'b' }]);
    expect(splitTemplate("{{ '}}' }}")).toEqual([{ src: "'}}'" }]);
    expect(splitTemplate('literal \\{{ braces }}')).toEqual(['literal {{ braces }}']);
    expect(() => splitTemplate('{{ oops')).toThrow(/Missing/);
  });
});
