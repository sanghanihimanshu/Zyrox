import type { UiAction, UiMessage, UiTrigger } from './types';

export interface Problem {
  path: string;
  message: string;
}

const NEEDS: Record<string, string[]> = {
  navigate: ['to'],
  openUrl: ['url'],
  alert: ['title'],
  toast: ['message'],
  track: ['event'],
  setState: ['path'],
  setLocale: ['locale'],
  setErrors: ['form', 'errors'],
  resetForm: ['form'],
  if: ['cond'],
};
const LISTS = ['then', 'else', 'onClose'] as const;
const PRESENTATIONS = ['push', 'replace', 'modal', 'sheet', 'reset'];
const STYLES = ['default', 'primary', 'cancel', 'destructive'];
const TONES = ['info', 'success', 'warning', 'danger'];
const EVENTS = ['screen_view', 'track', 'app_open', 'foreground'];
const isObject = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function checkButtons(value: unknown, path: string, out: Problem[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) return void out.push({ path, message: 'Expected a list of buttons' });
  value.forEach((button, i) => {
    const at = `${path}.${i}`;
    if (!isObject(button) || typeof button.label !== 'string') {
      out.push({ path: at, message: 'A button needs a "label"' });
      return;
    }
    if (button.style !== undefined && !STYLES.includes(String(button.style)))
      out.push({ path: `${at}.style`, message: `style must be one of ${STYLES.join(', ')}` });
    if (button.actions !== undefined) checkList(button.actions, `${at}.actions`, out);
  });
}

function checkList(value: unknown, path: string, out: Problem[]): void {
  if (!Array.isArray(value)) return void out.push({ path, message: 'Expected a list of actions' });
  value.forEach((action, i) => {
    checkAction(action, `${path}.${i}`, out);
  });
}

function checkAction(action: unknown, path: string, out: Problem[]): void {
  if (!isObject(action) || typeof action.do !== 'string' || !action.do)
    return void out.push({ path, message: 'An action is an object with "do"' });
  for (const field of NEEDS[action.do] ?? [])
    if (action[field] === undefined) out.push({ path, message: `"${action.do}" needs "${field}"` });
  for (const list of LISTS) if (action[list] !== undefined) checkList(action[list], `${path}.${list}`, out);
  switch (action.do) {
    case 'navigate':
      if (action.presentation !== undefined && !PRESENTATIONS.includes(String(action.presentation)))
        out.push({
          path: `${path}.presentation`,
          message: `presentation must be one of ${PRESENTATIONS.join(', ')}`,
        });
      break;
    case 'sheet': {
      if (action.screen === undefined && action.document === undefined && action.content === undefined)
        out.push({ path, message: '"sheet" needs "screen", "document" or "content"' });
      const doc = action.document;
      if (
        doc !== undefined &&
        (!isObject(doc) || doc.zyrox !== 1 || typeof doc.key !== 'string' || !isObject(doc.root))
      )
        out.push({
          path: `${path}.document`,
          message: 'Expected a Zyrox document { zyrox: 1, kind, key, root }',
        });
      if (action.content !== undefined) {
        if (!isObject(action.content)) out.push({ path: `${path}.content`, message: 'Expected an object' });
        else checkButtons(action.content.buttons, `${path}.content.buttons`, out);
      }
      if (action.size !== undefined && !['auto', 'half', 'full'].includes(String(action.size)))
        out.push({ path: `${path}.size`, message: 'size must be auto, half or full' });
      break;
    }
    case 'alert':
      checkButtons(action.buttons, `${path}.buttons`, out);
      break;
    case 'toast':
      if (action.tone !== undefined && !TONES.includes(String(action.tone)))
        out.push({ path: `${path}.tone`, message: `tone must be one of ${TONES.join(', ')}` });
      if (action.action !== undefined) {
        if (!isObject(action.action) || typeof action.action.label !== 'string')
          out.push({ path: `${path}.action`, message: 'A toast action needs a "label"' });
        else if (action.action.actions !== undefined)
          checkList(action.action.actions, `${path}.action.actions`, out);
      }
      break;
  }
}

/** Checks a list of actions. Returns problems (empty when valid). */
export function validateUiActions(actions: unknown): Problem[] {
  const out: Problem[] = [];
  checkList(actions, '', out);
  return out.map((p) => ({ ...p, path: p.path.replace(/^\./, '') }));
}

export function validateUiTriggers(triggers: unknown): Problem[] {
  const out: Problem[] = [];
  if (!Array.isArray(triggers)) return [{ path: '', message: 'Expected a list of triggers' }];
  const ids = new Set<string>();
  triggers.forEach((t, i) => {
    const at = String(i);
    if (!isObject(t)) {
      out.push({ path: at, message: 'Expected an object' });
      return;
    }
    if (typeof t.id !== 'string' || !t.id) out.push({ path: at, message: 'A trigger needs an "id"' });
    else if (ids.has(t.id)) out.push({ path: at, message: `Duplicate trigger id "${t.id}"` });
    else ids.add(t.id);
    if (!EVENTS.includes(String(t.on)))
      out.push({ path: `${at}.on`, message: `on must be one of ${EVENTS.join(', ')}` });
    for (const field of ['cooldown', 'maxPerSession', 'delay'] as const)
      if (t[field] !== undefined && (typeof t[field] !== 'number' || (t[field] as number) < 0))
        out.push({ path: `${at}.${field}`, message: `${field} must be a number ≥ 0` });
    if (t.if !== undefined && typeof t.if !== 'string')
      out.push({ path: `${at}.if`, message: 'if must be a string' });
    checkList(t.actions, `${at}.actions`, out);
  });
  return out;
}

export function validateUiMessage(message: unknown): Problem[] {
  if (!isObject(message)) return [{ path: '', message: 'Expected an object' }];
  const out: Problem[] = [];
  if (message.actions === undefined && message.triggers === undefined)
    out.push({ path: '', message: 'A message needs "actions" or "triggers"' });
  if (message.actions !== undefined)
    out.push(
      ...validateUiActions(message.actions).map((p) => ({
        ...p,
        path: `actions.${p.path}`.replace(/\.$/, ''),
      })),
    );
  if (message.triggers !== undefined)
    out.push(
      ...validateUiTriggers(message.triggers).map((p) => ({
        ...p,
        path: `triggers.${p.path}`.replace(/\.$/, ''),
      })),
    );
  return out;
}

/** Throws with every problem listed: use in tests or before publishing. */
export function assertUiActions(actions: unknown): asserts actions is UiAction[] {
  const problems = validateUiActions(actions);
  if (problems.length)
    throw new Error(
      `Invalid UI actions:\n${problems.map((p) => `  ${p.path || '(root)'}: ${p.message}`).join('\n')}`,
    );
}

export type { UiMessage, UiTrigger };
