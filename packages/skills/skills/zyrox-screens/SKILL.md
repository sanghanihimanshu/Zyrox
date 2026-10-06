---
name: zyrox-screens
description: Design and edit Zyrox server-driven screens and blocks - the JSON document format, layout with your registered components, expressions, state and two-way binding, declarative form validation, lists with templates, conditions, fallbacks, motion, accessibility, and editing documents with ops through the dashboard, CLI files or the Zyrox MCP tools (get_design_context, apply_ops, validate_document). Use when building or changing a server-driven screen, turning a design or screenshot into a Zyrox screen, or fixing document validation problems.
---

# Designing Zyrox screens

A screen is a JSON document rendered by the app's own components. Only use components, props, events, slots and templates from the app's manifest (MCP: `list_components`, `get_component`; or the dashboard palette).

## Document

```jsonc
{
  "zyrox": 1, "kind": "screen", "key": "product", "title": "Product",
  "params": { "id": { "type": "string", "required": true } },
  "state": { "qty": 1 },
  "data": { "product": { "url": "/products/{{ params.id }}", "mock": { "name": "Trail Shoe", "price": 129.5 } } },
  "root": { "id": "root", "type": "Screen", "props": { "title": "{{ data.product.name }}" }, "children": [ … ] }
}
```

Node fields: `id` (unique, readable: `hero-title`), `type`, `props`, `children`, `slots`, `templates`, `on` (event → actions), `bind`, `if`, `repeat`, `with`, `fallback`, `a11y`, `motion`, `meta`.

## Expressions

`"{{ expr }}"` (whole string) keeps the type; `"Hi {{ app.user.name }}"` interpolates. Safe JS subset: `a.b`, `a[b]`, arithmetic, `== != < >` (`==` is strict), `&& || ?? !`, `cond ? a : b`, arrays/objects, helper calls.

Scope: `state`, `data`, `loading`, `error`, `params`, `forms`, `app`, `device` (`width`, `height`, `platform`, `colorScheme`, `locale`, `direction`), `i18n` (`locale`, `direction`), `item`/`index` (templates, repeat), `event` (in actions), names from `with`, `input` (in blocks).

Helpers: `len includes upper lower trim join slice keys coalesce min max round floor ceil abs number string json semver concat merge pluck find filterBy sortBy sum unique t format.number format.currency format.percent format.date` + the app's own.

## Patterns

- **Responsive:** `"direction": "{{ device.width > 768 ? 'row' : 'column' }}"`.
- **Dark mode:** `"tone": "{{ device.colorScheme == 'dark' ? 'muted' : 'default' }}"`.
- **Conditional:** `"if": "{{ state.loggedIn }}"`; loading: `"if": "{{ loading.product }}"`; errors: `"{{ error.product.message }}"`.
- **Lists:** prefer a list component's template over `repeat` for data lists (virtualized):
  `{ "type": "List", "props": { "items": "{{ data.feed.items }}" }, "templates": { "item": { "id": "row", "type": "Card", "props": { "title": "{{ item.name }}" } } }, "slots": { "empty": [ … ] } }`.
  `repeat` is for a few items: `"repeat": { "each": "{{ data.promos }}", "as": "promo", "key": "{{ promo.id }}" }`.
- **Forms:** bind inputs (`"bind": "form.email"`) and declare rules in `forms` (below), not hand-written error expressions.
- **Local variables:** `"with": { "p": "{{ item.product }}" }` then `{{ p.name }}`.
- **Counters/toggles:** `{ "do": "setState", "path": "qty", "value": "{{ state.qty + 1 }}" }`.
- **Lifecycle:** every node has `appear` / `disappear` events (impressions: `{ "do": "track", "event": "promo_seen" }`).
- **Motion:** `"motion": { "enter": "fade", "exit": "fade", "layout": true }` with presets from the manifest.
- **Navigation:** `{ "do": "navigate", "to": "product", "params": { "id": "{{ item.id }}" }, "presentation": "modal", "transition": "slide" }`.
- **Sheets, alerts, toasts:** `{ "do": "sheet", "screen": "sheets/address", "params": {…}, "onClose": [ … ] }` (inside the sheet: `{ "do": "closeSheet", "result": … }`); `{ "do": "alert", "title": "Remove?", "buttons": [{ "label": "Cancel", "style": "cancel" }, { "label": "Remove", "style": "destructive", "actions": [ … ] }] }`; `{ "do": "toast", "message": "Saved", "tone": "success", "action": { "label": "Undo", "actions": [ … ] } }`. The app renders them with its `overlays`. Backends can send the same actions (see zyrox-backend-ui).
- **Accessibility:** set `a11y.label` on icon-only buttons and images.
- **New components:** add `"fallback"` so app builds without it still render something.
- **Blocks:** reusable fragments (`kind: "block"`) referencing `{{ input.x }}`; use them as `{ "id": "promo", "type": "@block/promo-banner", "props": { "title": "Sale" } }`. They are inlined when the screen is published.

## Forms and validation

Rules live next to the form's state; bound fields get `error` and `required` props automatically (when their schema has them), shown once a field is touched (on blur if the component has a `blur` event, else on change) and for all fields after `validate`.

```jsonc
"state": { "signup": { "email": "", "password": "", "confirm": "", "business": false, "company": "" } },
"forms": { "signup": { "fields": {
  "email":    { "required": "Enter your email", "email": true },
  "password": { "required": true, "minLength": 8, "pattern": { "value": "[0-9]", "message": "Add a number" } },
  "confirm":  { "equals": { "value": "{{ state.signup.password }}", "message": "Passwords don't match" } },
  "company":  { "if": "{{ state.signup.business }}", "required": "Enter your company" },
  "username": { "rules": [{ "check": "{{ data.availability.available }}", "message": "Taken" }] }
} } }
```

Rules: `required`, `minLength`, `maxLength`, `min`, `max`, `pattern`, `email`, `url`, `oneOf`, `equals`, `rules` (custom `check` expressions; `value` is the field value), `if` (conditional field). Any rule can be `{ "value": …, "message": "…" }` and any value an expression. Read `forms.<name>.valid`, `.errors.<field>`, `.shown.<field>`, `.submitted` for summaries or non-input errors (e.g. a terms toggle).

Submit: `[{ "do": "validate", "form": "signup" }, { "do": "request", …, "onError": [{ "do": "setErrors", "form": "signup", "errors": "{{ event.body.errors ?? {} }}" }] }]`. `validate` stops the list while invalid; `setErrors` shows the API's field errors until edited; `resetForm` clears it. Don't disable the submit button for invalid forms: let `validate` show what's missing.

## Editing with ops

All tools (editor, AI assistant, MCP, preview) change documents with ops addressed by node id:

```json
[
  { "op": "insert", "parent": "root", "index": 0, "node": { "id": "banner", "type": "Badge", "props": { "label": "New" } } },
  { "op": "update", "id": "title", "set": { "props.text": "Hello", "if": "{{ state.ready }}" }, "unset": ["props.tone"] },
  { "op": "move", "id": "banner", "parent": "header", "slot": "children", "index": 1 },
  { "op": "remove", "id": "old" },
  { "op": "doc", "set": { "state.qty": 1, "data.reviews": { "url": "/reviews", "mock": [] } } }
]
```

Slots for insert/move: `children` (default), `slots.<name>`, `templates.<name>`, `fallback`.

### With the Zyrox MCP server

1. `get_design_context { project, key }` - the document (or one node), the components it uses with their schemas, data sources, problems.
2. `apply_ops { project, key, ops }` - small, targeted ops; read the returned problems and fix them.
3. `validate_document` - also lists app builds the screen would break (with traffic share).
4. `create_preview_link` - open on a device / web app to check.
Publishing and releasing are done by a person in the dashboard.

### As files (GitOps)

`npx zyrox pull` writes `zyrox/<key>.json`; edit; `npx zyrox validate`; `npx zyrox push [--publish --release dev]`.

## Before publishing

- `zyrox validate` / the Problems panel shows no errors.
- Every data source has a realistic `mock` (the canvas and device preview use it).
- Texts fit on small screens; long lists use templates; empty and loading states exist.
