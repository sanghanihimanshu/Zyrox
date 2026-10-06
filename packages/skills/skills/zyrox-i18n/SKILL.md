---
name: zyrox-i18n
description: Translate Zyrox server-driven screens - the built-in t() helper with ICU plurals/selects, translation bundles managed in the dashboard and fetched at runtime, translations bundled in the app, runtime language switching (setLocale), machine translation with any model (Claude, DeepL, LibreTranslate, on-device, your own) at runtime and in the dashboard, RTL layouts, and locale-aware formatting. Use when adding languages, translating strings, switching language at runtime, or debugging missing translations.
---

# Languages in Zyrox

## In documents

```jsonc
"props": { "text": "{{ t('cart.items', { count: state.qty }) }}" }
```

Messages use placeholders and ICU plurals/selects:

```json
{ "cart.items": "{count, plural, =0 {No items} one {# item} other {# items}}",
  "greeting": "Hello {name}",
  "role": "{role, select, admin {Administrator} other {Member}}" }
```

`format.number`, `format.currency`, `format.percent`, `format.date` follow the active language. `{{ i18n.direction }}` (`ltr`/`rtl`) and `{{ i18n.locale }}` are available for layouts and pickers.

## Where translations come from (merged, later wins)

1. **Local** - shipped in the app: `<ZyroxProvider strings={{ en: {...}, fr: {...} }} defaultLocale="en" />` (works offline).
2. **Remote** - Translations page in the dashboard (documents `strings/<locale>`), published per environment. The app fetches only the locales it needs, caches them, and updates them in the background. Your own source: `loadStrings={(locale) => fetch(...)}`.
3. **Runtime** - `useI18n().addMessages(locale, messages)` and machine translation of missing keys, with any model:
   - **Server provider (default):** when the server runs with `ZYROX_RUNTIME_TRANSLATION=true`, the provider fetches missing keys from `/v1/translate` in batches and keeps the results on the device until the source strings change. Apps send keys only; the server translates its own released source strings, so the public key can't be used to translate arbitrary text. Calls are cached and rate limited.
   - **Your own model** (on-device ML Kit / Apple Translation, your cloud, a function):
```ts
import { splitMessage } from '@wishyor/zyrox-core';
<ZyroxProvider translateMissing={async ({ source, locale, sourceLocale }) => {
  if (!source) return null;
  const parts = splitMessage(source);              // protects {placeholders} and plural/select branches
  return parts.join(await myModel.translate(parts.texts, sourceLocale, locale)); // null if the model broke a token
}} />
```

Lookup per key: active locale chain (`fr-CA` → `fr`), then the default locale, then the key itself. Missing keys are reported once (`debug` logs them).

## Switching language at runtime

- From a document: `{ "do": "setLocale", "locale": "fr" }` (e.g. a language picker built from `{{ i18n.locales }}`).
- From the app: `const { locale, locales, setLocale, t, direction } = useI18n();`
- Controlled: pass `locale` to the provider (persist the user's choice yourself).
Screens re-render immediately; remote bundles are fetched first if needed.

## Workflow

1. Add a language in the dashboard (Translations → Add language) or push `zyrox/strings/fr.json` (`{ "zyrox": 1, "kind": "strings", "locale": "fr", "messages": {…} }`) with the CLI.
2. "Translate missing" fills empty cells with the server's translation provider (placeholders and plurals are checked; broken results are dropped); review, then Publish.
3. Release `strings/<locale>` to environments like any screen.

## Translation providers (server)

Pick any model; the same provider serves the dashboard and runtime translation.

| `ZYROX_TRANSLATOR` | Model | Settings |
| --- | --- | --- |
| `claude` (default when `ANTHROPIC_API_KEY` is set) | Claude, structured output | `ZYROX_AI_MODEL` |
| `deepl` | DeepL API | `ZYROX_TRANSLATOR_KEY` (free keys end with `:fx`) |
| `libretranslate` | LibreTranslate (self-hosted open models) | `ZYROX_TRANSLATOR_URL`, optional `ZYROX_TRANSLATOR_KEY` |
| `webhook` | Anything: your endpoint gets `{ sourceLocale, locale, messages, context }` and returns `{ messages }` | `ZYROX_TRANSLATOR_URL`, optional bearer `ZYROX_TRANSLATOR_KEY` |
| `off` | None | |

In code (`createZyroxServer({ translator })`): `deeplTranslator`, `libreTranslator`, `webhookTranslator`, `claudeTranslator`, `textTranslator(name, (texts, { sourceLocale, locale }) => …)` for any plain-text model (NLLB, Marian, Google, an LLM on Ollama/vLLM…; it protects placeholders and plurals for you), or your own `{ name, translate }`. Results whose placeholders differ from the source are always discarded. Turn on runtime translation with `ZYROX_RUNTIME_TRANSLATION=true` (or `runtimeTranslation: true`).
