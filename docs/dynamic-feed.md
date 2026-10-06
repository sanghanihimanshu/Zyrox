# Example: a dynamic home feed (Zepto / Blinkit / Amazon style)

Quick-commerce and marketplace apps build their home screen from a **feed API**: the backend returns an ordered list of typed sections (banners, category grids, product rails, campaign widgets), personalized per user, location and time. The app has a renderer per section type.

With Zyrox, those renderers aren't hard-coded in the app. They're documents you edit and release from the dashboard. Responsibility splits in three:

| Who | Decides | Changes ship |
| --- | --- | --- |
| **Your backend** (feed API) | Which sections, in what order, for whom, with what data | Instantly, per request |
| **Zyrox documents** | How each section type looks and behaves: layout, copy, actions, analytics | On publish, within a minute, no app release |
| **Your app** | The components (ProductCard, Tile…), the cart, auth, navigation, the API client | App release |

The example lives in this repository:

| Path | What |
| --- | --- |
| `examples/shop-api` | The backend: feed, collections, search, products ([contract](../examples/shop-api/src/contract.ts)) |
| `examples/components/documents/shop-home.json` | The feed screen |
| `examples/components/documents/sections/product-rail.json` | A section that loads its own data |
| `examples/components/documents/sections/festive-sale.json` | A section designed in the dashboard, placed by the backend |
| `examples/components/documents/shop-collection.json`, `shop-product.json` | "See all" with pagination, product page |
| `examples/components/src/{web,native}/components.tsx` | `Tile`, `ProductCard`, `Section`, horizontal `List` |
| `examples/web`, `examples/native` | The apps: cart state, native cart screen, the backend as data source |

Run it: `pnpm --filter @zyrox-examples/web dev` (web) or `pnpm --filter @zyrox-examples/native start` (Expo). Both run the backend in-process. To use it over HTTP, run `pnpm --filter @zyrox-examples/shop-api start` and set `VITE_SHOP_API=http://localhost:4600` (or `EXPO_PUBLIC_SHOP_API`).

## 1. The backend contract

```ts
type Section =
  // Static: everything to render is inline.
  | { id: string; type: 'banners'; items: Banner[] }
  | { id: string; type: 'categories'; title: string; items: Category[] }
  // Dynamic: the section fetches its own data from `api`, lazily, when it renders.
  | { id: string; type: 'rail'; title: string; api: { url: string }; seeAll?: Link }
  // A section designed in the Zyrox dashboard, placed and parameterised by the backend.
  | { id: string; type: 'zyrox'; screen: string; params?: Record<string, unknown> };

interface Feed { header: { eta: string; address: string }; sections: Section[] }
```

`GET /feed/home` decides everything about the feed: a "Breakfast essentials" rail in the morning and "Snacks under ₹99" later, a "first order" campaign for new users and the festive sale for others. It also returns a `stories` section that this app build doesn't know; the app skips it, which is how you roll out new section types safely.

Two kinds of API calls appear:

- **Static**: the feed itself, at a URL fixed in the document (`/feed/home`).
- **Dynamic**: each rail's URL comes from the feed response (`api.url`), so the backend can point a rail at any collection, search or recommendation endpoint without an app or document change. The product page derives one more call from its first response (similar items from `data.product.category`).

## 2. The feed screen

`shop-home.json` (abridged):

```jsonc
{
  "key": "shop-home",
  "state": { "q": "" },
  "data": {
    "feed": { "url": "/feed/home?segment={{ app.user.segment ?? '' }}", "refresh": ["mount", "foreground"], "cache": 30, "mock": { … } },
    "results": { "url": "/search?q={{ trim(state.q) }}", "if": "{{ len(trim(state.q)) > 1 }}", "debounce": 300 }
  },
  "root": { "id": "root", "type": "Screen", "children": [
    { "id": "eta", "type": "Text", "props": { "text": "Delivery in {{ data.feed.header.eta ?? '10 minutes' }}", "variant": "title" } },
    { "id": "search", "type": "TextField", "bind": "q", "props": { "label": "Search" } },
    { "id": "results", "type": "Stack", "if": "{{ len(trim(state.q)) > 1 }}", "children": [ /* 2-column grid of ProductCard */ ] },
    { "id": "feed", "type": "List", "if": "{{ len(trim(state.q)) <= 1 }}",
      "props": { "items": "{{ data.feed.sections ?? [] }}", "gap": "lg" },
      "templates": { "item": {
        "id": "section", "type": "Stack",
        "if": "{{ includes(['banners', 'categories', 'rail', 'zyrox'], item.type) }}",
        "children": [
          { "id": "banners", "type": "List", "if": "{{ item.type == 'banners' }}",
            "props": { "items": "{{ item.items }}", "horizontal": true, "itemWidth": 300 },
            "templates": { "item": { "id": "banner", "type": "Tile", "props": { "title": "{{ item.title }}", "emoji": "{{ item.emoji }}", "color": "{{ item.color }}", "size": "lg" },
              "on": { "press": [{ "do": "track", "event": "banner_tap", "props": { "banner": "{{ item.id }}" } },
                                { "do": "navigate", "to": "{{ item.link.screen }}", "params": "{{ item.link.params }}" }] } } } },
          { "id": "categories", "type": "Stack", "if": "{{ item.type == 'categories' }}", "children": [ /* title + 4-column grid of Tile */ ] },
          { "id": "rail", "type": "Section", "if": "{{ item.type == 'rail' }}",
            "props": { "screen": "sections/product-rail", "params": { "title": "{{ item.title }}", "api": "{{ item.api.url }}", "collection": "{{ item.seeAll.params.id }}" } } },
          { "id": "designed", "type": "Section", "if": "{{ item.type == 'zyrox' }}",
            "props": { "screen": "{{ item.screen }}", "params": "{{ item.params ?? {} }}" } }
        ] } } }
  ],
  "slots": { "footer": [
    { "id": "cart-bar", "type": "Button", "if": "{{ app.cart.count > 0 }}",
      "props": { "label": "{{ app.cart.count }} items · {{ format.currency(app.cart.total, 'INR') }} · View cart" },
      "on": { "press": [{ "do": "navigate", "to": "cart" }] }, "motion": { "enter": "slideUp" } }
  ] } }
}
```

Things to notice:

- **One template switches on `item.type`.** Supporting a new section type means adding one branch to this document and publishing; older builds without the needed components get a `fallback`, and the `includes([...])` guard skips types the document doesn't know.
- **Search is reactive.** `results` refetches when `state.q` changes, waits 300 ms after typing, and only runs with 2+ characters. The feed is hidden while results show.
- **The cart is app state.** `app.cart` comes from the provider's `app` prop; ADD calls the app's `addToCart` action; the footer bar appears with motion when the count is positive and opens the app's native cart screen.
- **Loading and errors** are plain nodes: `"if": "{{ loading.feed && !data.feed }}"` shows a placeholder, and `"if": "{{ error.feed && !data.feed }}"` shows a retry button (`{ "do": "refresh", "data": "feed" }`). With `cache`, returning to the screen shows the last feed instantly while it revalidates.

## 3. Sections that load their own data

A rail is its own document, rendered by the `Section` component:

```tsx
// examples/components/src/web/components.tsx
export const Section = implement(SectionDef, ({ screen, params }) => (
  <ZyroxScreen screen={screen} params={params} loading={<Skeleton />} fallback={null} />
));
```

```jsonc
// sections/product-rail.json
{
  "key": "sections/product-rail",
  "params": { "title": { "type": "string" }, "api": { "type": "string", "required": true }, "collection": { "type": "string" } },
  "data": { "products": { "url": "{{ params.api }}", "cache": 60, "mock": { … } } },
  "root": { "id": "rail", "type": "Stack", "if": "{{ loading.products || len(data.products.products) > 0 }}", "children": [
    { "id": "rail-header", "type": "Stack", "props": { "direction": "row", "justify": "between" }, "children": [
      { "id": "rail-title", "type": "Text", "props": { "text": "{{ params.title }}", "variant": "subtitle" } },
      { "id": "rail-see-all", "type": "Button", "if": "{{ params.collection }}", "props": { "label": "See all", "variant": "ghost" },
        "on": { "press": [{ "do": "navigate", "to": "shop-collection", "params": { "id": "{{ params.collection }}" } }] } } ] },
    { "id": "rail-list", "type": "List", "props": { "items": "{{ data.products.products ?? [] }}", "horizontal": true, "itemWidth": 150 },
      "templates": { "item": { "id": "product", "type": "ProductCard",
        "props": { "name": "{{ item.name }}", "price": "{{ item.price }}", "mrp": "{{ item.mrp }}", "qty": "{{ app.cart.items[item.id] ?? 0 }}", "width": 150 },
        "on": { "add": [{ "do": "addToCart", "productId": "{{ item.id }}", "qty": 1, "price": "{{ item.price }}" },
                        { "do": "track", "event": "add_to_cart", "props": { "product": "{{ item.id }}", "source": "{{ params.title }}" } }],
                "remove": [{ "do": "removeFromCart", "productId": "{{ item.id }}", "qty": 1 }],
                "press": [{ "do": "navigate", "to": "shop-product", "params": { "id": "{{ item.id }}" } }] } } } }
  ] }
}
```

Each section has its own state, loading and error handling, so a slow recommendation API doesn't hold up the feed, and a failing one only hides its own rail (empty rails hide themselves too). Every rail on the home screen is the same document with different params; changing the rail's look changes all of them.

In the provider, `documents={…}` bundles these documents with the app. They render immediately with no server, and once the server has a published version, it takes over.

## 4. Sections designed in the dashboard

`sections/festive-sale.json` is a campaign widget marketing builds in the dashboard (badge, title, code, "Shop now", "Copy code" with its own state and a toast). The backend places it in the feed with parameters:

```json
{ "id": "sale", "type": "zyrox", "screen": "sections/festive-sale",
  "params": { "title": "Festive sale: up to 30% off", "code": "DIWALI30", "collection": "festive" } }
```

So the people who design the campaign and the people who decide who sees it work independently: marketing changes the widget and publishes; the backend (or your experimentation system) decides placement and audience. Release rules and experiments in Zyrox can also target the widget itself (for example a variant for `attrs.city == 'Mumbai'`).

## 5. Pagination, product page, cart

- **See all** (`shop-collection.json`) shows page 1 from a data source, then "Load more" uses a `request` action and appends with `concat(state.more, event.products)`; the button hides when the backend returns `next: null`.
- **Product page** (`shop-product.json`) loads `/products/{{ params.id }}`, then a "More in this category" rail whose API is built from that response (`/collections/{{ item.category }}`).
- **Cart** is the app's own state and screen: `navigate({ to: 'cart' })` opens a native React / React Native view, showing how Zyrox screens and native screens mix.

## 6. Tests

- `examples/components/test/scenarios.ts` → "shop feed": the same steps on web and React Native (banners, categories, the dashboard-designed section with its state, a rail inside a section, ADD → `addToCart`, navigation).
- `examples/components/test/shop.web.test.tsx`: the feed against the real backend handler (no mocks): the feed call, lazy rail calls, the unknown `stories` section skipped, cart updates, and debounced search.
- `examples/shop-api/test/api.test.ts`: the backend contract (ordering, personalization, pagination).

## Adapting it to your app

1. Write down your section contract (like `contract.ts`), including a catch-all for future types.
2. Define the components your sections need (`ProductCard`, `Tile`, `Section`…) and register them on web and native.
3. Build the feed document with one template branch per type, and one document per section that loads its own data.
4. Bundle the documents with `documents={…}` for the first release, then edit and publish them from the dashboard.
5. Give data sources realistic `mock`s so designers can work in the dashboard canvas and on devices without your backend.
