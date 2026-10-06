import type { Document } from '@wishyor/zyrox-protocol';
import { describe, expect, it, vi } from 'vitest';
import { compileDocument } from '../src/compile';
import { createTranslator, formatMessage, I18n, isRtl, localeChain, pickLocale } from '../src/i18n';
import { ScreenRuntime } from '../src/runtime';

describe('formatMessage', () => {
  it('interpolates, pluralizes and selects', () => {
    expect(formatMessage('Hello {name}!', { name: 'Ada' })).toBe('Hello Ada!');
    expect(formatMessage('Hi {user.first}', { user: { first: 'Bo' } })).toBe('Hi Bo');
    expect(formatMessage('Missing {x}')).toBe('Missing {x}');
    const items = '{count, plural, =0 {No items} one {# item} other {# items}}';
    expect(formatMessage(items, { count: 0 })).toBe('No items');
    expect(formatMessage(items, { count: 1 })).toBe('1 item');
    expect(formatMessage(items, { count: 1234 })).toBe('1,234 items');
    expect(formatMessage('{n, plural, one {# fichier} other {# fichiers}}', { n: 0 }, 'fr')).toBe(
      '0 fichier',
    );
    expect(
      formatMessage('{role, select, admin {Admin {name}} other {Member}}', { role: 'admin', name: 'Al' }),
    ).toBe('Admin Al');
    expect(formatMessage('{role, select, admin {Admin} other {Member}}', { role: 'x' })).toBe('Member');
    expect(formatMessage('Broken {oops')).toBe('Broken {oops');
  });
});

describe('locales', () => {
  it('picks and chains locales', () => {
    expect(pickLocale(['fr-CA', 'en'], ['en', 'fr'], 'en')).toBe('fr');
    expect(pickLocale(['pt-BR'], ['en', 'pt-BR'], 'en')).toBe('pt-BR');
    expect(pickLocale(['de'], ['en', 'fr'], 'en')).toBe('en');
    expect(pickLocale(['es'], ['en', 'es-MX'], 'en')).toBe('es-MX');
    expect(localeChain('zh-Hant-TW')).toEqual(['zh-Hant-TW', 'zh-Hant', 'zh']);
    expect(isRtl('ar-EG')).toBe(true);
    expect(isRtl('en')).toBe(false);
  });

  it('translates with fallbacks and reports missing keys once', () => {
    const onMissing = vi.fn();
    const t = createTranslator('fr-CA', { a: 'A-ca' }, [{ a: 'A-fr', b: 'B-fr' }, { c: 'C-en' }], onMissing);
    expect([t('a'), t('b'), t('c'), t('zz'), t('zz')]).toEqual(['A-ca', 'B-fr', 'C-en', 'zz', 'zz']);
    expect(onMissing).toHaveBeenCalledTimes(1);
    expect(t.has('c')).toBe(true);
    expect(t.locale).toBe('fr-CA');
  });
});

describe('I18n', () => {
  it('merges local < remote < runtime and falls back to the default locale', async () => {
    const loader = vi.fn(async (locale: string) =>
      locale === 'fr' ? { hello: 'Bonjour (remote)', bye: 'Au revoir' } : null,
    );
    const i18n = new I18n({
      defaultLocale: 'en',
      preferred: ['fr-FR'],
      local: { en: { hello: 'Hello', only: 'Only English' }, fr: { hello: 'Bonjour (local)' } },
      loader,
    });
    expect(i18n.locale).toBe('fr');
    expect(i18n.translator()('hello')).toBe('Bonjour (local)');
    await i18n.setLocale('fr');
    expect(i18n.translator()('hello')).toBe('Bonjour (remote)');
    i18n.addMessages('fr', { hello: 'Salut (runtime)' });
    expect(i18n.translator()('hello')).toBe('Salut (runtime)');
    expect(i18n.translator()('only')).toBe('Only English');
    expect(loader).toHaveBeenCalledWith('fr');
    expect(loader).toHaveBeenCalledWith('en');
  });

  it('switches locale at runtime and notifies subscribers', async () => {
    const i18n = new I18n({ local: { en: { hi: 'Hi' }, ar: { hi: 'مرحبا' } } });
    const listener = vi.fn();
    i18n.subscribe(listener);
    expect(i18n.getSnapshot()).toMatchObject({ locale: 'en', direction: 'ltr', locales: ['ar', 'en'] });
    await i18n.setLocale('ar');
    expect(i18n.getSnapshot()).toMatchObject({ locale: 'ar', direction: 'rtl' });
    expect(i18n.translator()('hi')).toBe('مرحبا');
    expect(listener).toHaveBeenCalled();
  });

  it('translates missing keys at runtime', async () => {
    const translateMissing = vi.fn(
      async ({ source, locale }: { source?: string; locale: string }) => `[${locale}] ${source}`,
    );
    const i18n = new I18n({ locale: 'de', local: { en: { greet: 'Good morning' } }, translateMissing });
    expect(i18n.translator()('greet')).toBe('Good morning');
    await new Promise((r) => setTimeout(r, 0));
    expect(i18n.translator()('greet')).toBe('[de] Good morning');
    expect(translateMissing).toHaveBeenCalledTimes(1);
  });
});

describe('runtime integration', () => {
  const doc: Document = {
    zyrox: 1,
    kind: 'screen',
    key: 'lang',
    root: {
      id: 'r',
      type: 'Text',
      props: { text: "{{ t('cart', { count: 2 }) }}", dir: '{{ i18n.direction }}' },
      on: { press: [{ do: 'setLocale', locale: 'ar' }] },
    },
  };

  it('re-renders t() when the locale changes', async () => {
    const i18n = new I18n({
      local: { en: { cart: '{count, plural, one {# item} other {# items}}' }, ar: { cart: '{count} عناصر' } },
    });
    const runtime = new ScreenRuntime({ document: doc, host: { i18n } });
    runtime.start();
    const compiled = compileDocument(doc);
    const deps: string[] = [];
    expect(runtime.evaluate(compiled.root.props, null, (p) => deps.push(p))).toEqual({
      text: '2 items',
      dir: 'ltr',
    });
    expect(deps).toContain('i18n');
    const changed = vi.fn();
    runtime.store.watch(() => deps, changed);
    await runtime.run(compiled.root.on.press, null);
    expect(changed).toHaveBeenCalled();
    expect(runtime.evaluate(compiled.root.props, null)).toEqual({ text: '2 عناصر', dir: 'rtl' });
    runtime.stop();
  });

  it('runs remote functions with the call action', async () => {
    const callFunction = vi.fn(async (fn: string, args: Record<string, unknown>, _ctx: unknown) => ({
      fn,
      total: (args.amount as number) * 0.9,
    }));
    const d: Document = {
      zyrox: 1,
      kind: 'screen',
      key: 'coupon',
      state: { amount: 100 },
      root: {
        id: 'r',
        type: 'Button',
        on: {
          press: [
            {
              do: 'call',
              fn: 'applyCoupon',
              args: { amount: '{{ state.amount }}', code: 'SAVE10' },
              into: 'quote',
              onSuccess: [{ do: 'setState', path: 'total', value: '{{ event.total }}' }],
            },
          ],
          fail: [
            {
              do: 'call',
              fn: 'boom',
              onError: [{ do: 'setState', path: 'err', value: '{{ event.message }}' }],
            },
          ],
        },
      },
    };
    const runtime = new ScreenRuntime({
      document: d,
      host: {
        callFunction: async (fn, args, ctx) => {
          if (fn === 'boom') throw new Error('Function failed');
          return callFunction(fn, args, ctx);
        },
      },
    });
    const compiled = compileDocument(d);
    expect(await runtime.run(compiled.root.on.press, null, undefined, 'r')).toBe(true);
    expect(callFunction).toHaveBeenCalledWith(
      'applyCoupon',
      { amount: 100, code: 'SAVE10' },
      { screen: 'coupon', nodeId: 'r' },
    );
    expect(runtime.getState('quote')).toEqual({ fn: 'applyCoupon', total: 90 });
    expect(runtime.getState('total')).toBe(90);
    await runtime.run(compiled.root.on.fail, null);
    expect(runtime.getState('err')).toBe('Function failed');
  });
});

describe('I18n availability', () => {
  it('re-picks the best locale when the server reveals more, unless chosen explicitly', async () => {
    const loader = vi.fn(async (l: string) => (l === 'fr' ? { hi: 'Salut' } : null));
    const auto = new I18n({ preferred: ['fr-FR', 'en'], loader });
    expect(auto.locale).toBe('en');
    auto.setAvailable(['en', 'fr']);
    expect(auto.locale).toBe('fr');
    await auto.ensureLoaded();
    expect(auto.translator()('hi')).toBe('Salut');

    const chosen = new I18n({ preferred: ['fr'], locale: 'en' });
    chosen.setAvailable(['fr']);
    expect(chosen.locale).toBe('en');
  });
});
