import { describe, expect, it } from 'vitest';
import type { Feed, ProductPage } from '../src';
import { handleShopRequest, homeFeed, orderUpdate, ShopError, shopEvents } from '../src';

describe('shop api', () => {
  it('serves a feed of typed sections that the backend orders and personalizes', async () => {
    const feed = (await handleShopRequest({ method: 'GET', url: '/feed/home?hour=8' })) as Feed;
    expect(feed.sections.map((s) => `${s.type}:${s.id}`)).toEqual([
      'banners:hero',
      'categories:categories',
      'zyrox:sale',
      'rail:bestsellers',
      'rail:daily',
      'stories:stories',
    ]);
    expect(homeFeed({ hour: 20 }).sections[4]).toMatchObject({
      id: 'under99',
      api: { url: '/collections/under99' },
    });
    expect(homeFeed({ segment: 'new' }).sections[2]).toMatchObject({
      screen: 'sections/festive-sale',
      params: { code: 'FIRST100' },
    });
  });

  it('pages collections, searches and finds products', async () => {
    const first = (await handleShopRequest({ method: 'GET', url: '/collections/fruits' })) as ProductPage;
    expect(first).toMatchObject({ title: 'Fruits', page: 1, next: null });
    expect(first.products.map((p) => p.id)).toEqual(['banana', 'apple', 'mango', 'grapes', 'avocado']);
    const under = (await handleShopRequest({
      method: 'GET',
      url: 'http://api/collections/under99?page=2',
    })) as ProductPage;
    expect(under.page).toBe(2);
    expect(await handleShopRequest({ method: 'GET', url: '/search?q=milk' })).toMatchObject({
      products: [{ id: 'milk' }],
    });
    expect(await handleShopRequest({ method: 'GET', url: '/products/apple' })).toMatchObject({ price: 129 });
    await expect(handleShopRequest({ method: 'GET', url: '/collections/nope' })).rejects.toBeInstanceOf(
      ShopError,
    );
    await expect(handleShopRequest({ method: 'DELETE', url: '/feed/home' })).rejects.toThrow('No route');
  });
});

describe('registration', () => {
  it('checks username availability', async () => {
    expect(await handleShopRequest({ method: 'GET', url: '/username-available?u=Ada' })).toEqual({
      username: 'Ada',
      available: false,
    });
    expect(await handleShopRequest({ method: 'GET', url: '/username-available?u=ada_l' })).toMatchObject({
      available: true,
    });
  });

  it('re-checks the form and answers 422 with field errors', async () => {
    const valid = { name: 'Ada', email: 'ada@example.com', username: 'ada_l', password: 'secret123' };
    expect(await handleShopRequest({ method: 'POST', url: '/register', body: valid })).toEqual({
      id: 'u_ada_l',
      name: 'Ada',
      username: 'ada_l',
    });
    const err = await handleShopRequest({
      method: 'POST',
      url: '/register',
      body: { ...valid, email: 'taken@example.com', username: 'admin', business: true },
    }).catch((e: ShopError) => e);
    expect(err).toBeInstanceOf(ShopError);
    expect((err as ShopError).status).toBe(422);
    expect((err as ShopError).body).toEqual({
      errors: {
        email: 'This email is already registered',
        username: 'That username is taken',
        company: 'Enter your company name',
      },
    });
  });
});

describe('UI actions', () => {
  it('answers coupons with UI actions, also on errors', async () => {
    expect(
      await handleShopRequest({ method: 'POST', url: '/coupons/apply', body: { code: 'diwali30' } }),
    ).toEqual({
      code: 'DIWALI30',
      offer: '30% off festive items',
      $actions: [{ do: 'toast', message: 'DIWALI30 applied: 30% off festive items', tone: 'success' }],
    });
    const err = (await handleShopRequest({
      method: 'POST',
      url: '/coupons/apply',
      body: { code: 'OLD' },
    }).catch((e) => e)) as ShopError;
    expect(err.status).toBe(422);
    expect(err.body).toMatchObject({ $actions: [{ do: 'alert', title: 'Coupon not valid' }] });
  });

  it('serves valid trigger rules and order updates', async () => {
    const { validateUiMessage, validateUiTriggers } = await import('@wishyor/zyrox-actions');
    const { triggers } = (await handleShopRequest({ method: 'GET', url: '/ui/triggers' })) as {
      triggers: unknown;
    };
    expect(validateUiTriggers(triggers)).toEqual([]);
    expect(validateUiMessage(orderUpdate('o1'))).toEqual([]);
    const received: unknown[] = [];
    const stop = shopEvents.subscribe('demo', (m) => received.push(m));
    shopEvents.publish('demo', orderUpdate('o2'));
    stop();
    expect(received).toHaveLength(1);
  });
});
