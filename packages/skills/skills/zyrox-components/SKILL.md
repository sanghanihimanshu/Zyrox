---
name: zyrox-components
description: Design, define, implement and register components for Zyrox server-driven UI (React and React Native) - defineComponent / extendComponent schemas, implement for web and native, events, slots, templates, two-way binding, design tokens, app actions, and uploading the manifest. Use when adding or changing a component that server-driven screens can use, scaffolding a component, or when the dashboard says a component "isn't in this app build".
---

# Components for Zyrox

Zyrox ships no UI kit. Each component the server can use is **your** component plus a schema. One schema drives TypeScript props, the dashboard's property forms, publish-time validation, and what AI agents may generate.

## 1. Define (no React imports - the CLI loads this in Node)

```ts
// src/zyrox/components/product-card/def.ts
import { defineComponent, z, zx } from '@wishyor/zyrox-react'; // or '@wishyor/zyrox-protocol'

export const ProductCardDef = defineComponent({
  name: 'ProductCard',                                   // what documents use as "type"
  description: 'Product tile with image, title and price. Pressable.', // shown to editors and AI: be specific
  source: 'src/zyrox/components/product-card/ProductCard.tsx',        // where the code lives (agents use it)
  props: z.object({
    title: z.string().describe('Product name'),
    image: zx.image(),                                   // editor hints: zx.image(), zx.color(), zx.url(), zx.multiline()
    price: z.number().optional(),
    tone: z.enum(['default', 'promo']).default('default'), // design tokens as enums
  }),
  events: ['press'],                                     // or { press: z.object({ id: z.string() }) } for typed payloads
  children: false,                                       // true → renders a default children slot
  slots: ['footer'],                                     // named slots → props.slots.footer
  templates: [],                                         // item renderers → props.templates.item(item, index)
});
```

Rules that keep old app builds working:
- **Props are additive.** Add optional props or props with `.default(...)`. Never rename/remove a prop or change its type - make a new component name (`ProductCard2`) instead.
- Required props must always be meaningful; prefer defaults.
- `null` from an expression means "use the default".
- Enums are the right way to expose design tokens (`tone`, `size`, `space`).

### Extending an existing definition

```ts
export const PromoCardDef = extendComponent(ProductCardDef, {
  name: 'PromoCard',
  props: { discount: z.number() },     // or (base) => base.omit({ tone: true })
  events: ['dismiss'],
  slots: ['badge'],
});
```

### Inputs: two-way binding

```ts
export const TextFieldDef = defineComponent({
  name: 'TextField',
  props: z.object({ label: z.string().optional(), value: z.string().default(''), error: z.string().optional() }),
  events: { change: z.string(), submit: z.object({}) },
  bind: { prop: 'value', event: 'change' },   // documents: "bind": "form.email"
});
```

### Lists: templates

```ts
export const ListDef = defineComponent({
  name: 'List',
  props: z.object({ items: z.array(z.unknown()).default([]), columns: z.number().int().min(1).default(1) }),
  events: ['endReached'],
  slots: ['empty'],
  templates: ['item'],
});
```

## 2. Implement per platform

```tsx
// ProductCard.tsx (web)              // ProductCard.native.tsx (React Native) - Metro picks it automatically
import { implement } from '@wishyor/zyrox-react';
import { ProductCardDef } from './def';

export const ProductCard = implement(ProductCardDef, ({ title, image, price, tone, onPress, slots, nodeId, a11y }) => (
  <MyCard tone={tone} onPress={onPress} data-testid={nodeId} aria-label={a11y?.label}>
    <MyImage src={image} />
    <MyText>{title}</MyText>
    {price !== undefined ? <MyPrice value={price} /> : null}
    {slots.footer}
  </MyCard>
));
```

What your component receives: the parsed props (defaults applied), `on<Event>` handlers (only when the document wires that event - so `onPress` being undefined means "not pressable"), `children`, `slots.<name>`, `templates.<name>(item, index)` (use as `renderItem` for `FlatList`/FlashList), `a11y`, `nodeId`, `meta`.

Use your existing design system inside; one file is enough if it is already cross-platform (Tamagui, NativeWind, Unistyles, react-native-web).

## 3. App actions (things documents can do that only your app can)

```ts
export const AddToCartDef = defineAction({
  name: 'addToCart',
  description: 'Adds a product to the cart.',
  args: z.object({ productId: z.string(), qty: z.number().int().min(1).default(1) }),
});
export const addToCart = implementAction(AddToCartDef, async ({ productId, qty }, ctx) => {
  await cart.add(productId, qty);
  ctx.setState('added', true);              // ctx: getState, setState, navigate, track, refresh, event, nodeId, screen
});
```

Documents call it as `{ "do": "addToCart", "productId": "{{ item.id }}", "qty": 1 }`.

## 4. Register

1. Add the implementation to `createRegistry({ components: [...] })` (both web and native registries).
2. Add the definition to `zyrox.config.ts`:

```ts
import { defineConfig } from '@wishyor/zyrox-cli';
export default defineConfig({
  server: 'https://ui.example.com',
  project: 'shop',
  manifest: { components: [ProductCardDef, …], actions: [AddToCartDef, …], helpers: [], motions: ['fade'], transitions: ['slide'], tokens },
  documents: './zyrox',
});
```

3. `npx zyrox manifest push --label 3.5.0` (CI does this per build). The dashboard palette, forms and validation update immediately; publishing warns when a screen uses a component that older builds still in use don't have.

Share one `manifestInput` object between the registry and the config so hashes match (`registry.manifest.hash === buildManifest(input).hash`).

## 5. With an AI agent (MCP)

Connect the Zyrox MCP server (`https://<server>/mcp`, bearer = a personal access token). Useful tools:
- `scaffold_component` - generates def + web + native files following these rules.
- `get_component_map` - every component, where it lives (`source`), which screens use it, which app builds have it.
- `get_variable_defs` - design tokens.
- `upload_manifest` - register components without the CLI (pass `zyrox manifest build` output).

## Checklist

- [ ] `description` says what it is and when to use it
- [ ] all new props optional or defaulted; tokens as enums
- [ ] web and native implementations render the same semantics and a11y
- [ ] added to the registry and to `zyrox.config.ts`
- [ ] `zyrox manifest push` ran for the new build
- [ ] screens using it have a `fallback` until old builds are gone
