import type { Action, Document } from '@zyrox/protocol';
import { describe, expect, it } from 'vitest';
import { compileActions } from '../src/compile';
import { checkField, isEmptyValue } from '../src/forms';
import { I18n } from '../src/i18n';
import { type FormSnapshot, type RuntimeHost, ScreenRuntime } from '../src/runtime';
import { hasErrors, validateDocument } from '../src/validate';

const tick = () => new Promise((r) => setTimeout(r, 0));
const actions = (list: Action[]) => compileActions(list, []);

describe('checkField', () => {
  it('treats blank values as missing and skips other rules for them', () => {
    for (const empty of [undefined, null, '', '  ', false, []]) expect(isEmptyValue(empty)).toBe(true);
    expect(isEmptyValue(0)).toBe(false);
    expect(checkField('', { required: true })).toBe('This field is required');
    expect(checkField('', { required: 'Enter your name' })).toBe('Enter your name');
    expect(checkField('', { minLength: 3, email: true })).toBeNull();
  });

  it('checks lengths, numbers, patterns and formats in order', () => {
    expect(checkField('ab', { minLength: 3 })).toBe('Enter at least 3 characters');
    expect(checkField('abcd', { maxLength: { value: 3, message: 'Too long' } })).toBe('Too long');
    expect(checkField(['a', 'b'], { maxLength: 1 })).toBe('Enter at most 1 characters');
    expect(checkField('17', { min: 18 })).toBe('Enter 18 or more');
    expect(checkField('abc', { min: 18 })).toBe('Enter a number');
    expect(checkField(101, { max: 100 })).toBe('Enter 100 or less');
    expect(checkField('56003', { pattern: '^[1-9][0-9]{5}$' })).toBe('Invalid format');
    expect(checkField('560038', { pattern: '^[1-9][0-9]{5}$' })).toBeNull();
    expect(checkField('x', { pattern: '([' })).toBeNull();
    expect(checkField('ada@', { email: true })).toBe('Enter a valid email address');
    expect(checkField('ada@example.com', { email: 'Bad email' })).toBeNull();
    expect(checkField('ftp://x', { url: true })).toBe('Enter a valid URL');
    expect(checkField('gold', { oneOf: ['silver', 'bronze'] })).toBe('Choose one of the options');
    expect(checkField('a', { equals: { value: 'b', message: 'Must match' } })).toBe('Must match');
  });

  it('runs custom rules even for empty values and uses translations', () => {
    expect(checkField('', { rules: [{ check: false, message: 'Pick one' }] })).toBe('Pick one');
    expect(checkField('x', { rules: [{ check: true, message: 'no' }, { check: 0 }] })).toBe('Invalid value');
    const translate = (key: string, vars: Record<string, unknown>) =>
      key === 'zyrox.form.minLength' ? `Mindestens ${vars.n} Zeichen` : undefined;
    expect(checkField('ab', { minLength: 3 }, translate)).toBe('Mindestens 3 Zeichen');
    expect(checkField('', { required: true }, translate)).toBe('This field is required');
  });
});

const formDoc: Document = {
  zyrox: 1,
  kind: 'screen',
  key: 'form-test',
  state: {
    account: { email: '', password: '', confirm: '', business: false, company: '' },
    submitted: false,
  },
  forms: {
    account: {
      fields: {
        email: { required: 'Enter your email', email: true },
        password: { required: true, minLength: 8 },
        confirm: { equals: { value: '{{ state.account.password }}', message: "Passwords don't match" } },
        company: { if: '{{ state.account.business }}', required: 'Enter your company' },
      },
    },
  },
  root: {
    id: 'root',
    type: 'Screen',
    on: {
      press: [
        { do: 'validate', form: 'account' },
        { do: 'setState', path: 'submitted', value: true },
      ],
    },
  },
};

function setup(doc: Document = formDoc, host: RuntimeHost = {}) {
  const runtime = new ScreenRuntime({ document: doc, host });
  const form = (name = 'account') => runtime.store.get(`forms.${name}`) as FormSnapshot;
  return { runtime, form };
}

describe('document forms', () => {
  it('hides errors until a field is touched, then follows the value', () => {
    const { runtime, form } = setup();
    expect(form().valid).toBe(false);
    expect(form().errors.email).toBe('Enter your email');
    expect(form().shown.email).toBeNull();
    expect(form().required).toMatchObject({ email: true, password: true, confirm: false, company: false });
    runtime.setState('account.email', 'ada');
    runtime.touch('account.email');
    expect(form().shown.email).toBe('Enter a valid email address');
    expect(form().touched).toEqual({ email: true });
    runtime.setState('account.email', 'ada@example.com');
    expect(form().shown.email).toBeNull();
    expect(runtime.formField('account.email')).toEqual({ form: 'account', field: 'email', required: true });
    expect(runtime.formField('account.unknown')).toBeUndefined();
    expect(runtime.formField('submitted')).toBeUndefined();
  });

  it('validate shows every error and stops the action list while invalid', async () => {
    const { runtime, form } = setup();
    const press = runtime.doc.nodes.get('root')!.on.press!;
    expect(await runtime.run(press, null)).toBe(false);
    expect(runtime.getState('submitted')).toBe(false);
    expect(form()).toMatchObject({ submitted: true, shown: { email: 'Enter your email' } });
    runtime.setState('account', { email: 'ada@example.com', password: 'secret123', confirm: 'secret123' });
    expect(form().valid).toBe(true);
    expect(await runtime.run(press, null)).toBe(true);
    expect(runtime.getState('submitted')).toBe(true);
  });

  it('re-checks cross-field and conditional rules when the fields they read change', () => {
    const { runtime, form } = setup();
    runtime.setState('account.password', 'secret123');
    runtime.setState('account.confirm', 'secret123');
    expect(form().errors.confirm).toBeNull();
    runtime.setState('account.password', 'secret1234');
    expect(form().errors.confirm).toBe("Passwords don't match");
    expect(form().errors.company).toBeNull();
    runtime.setState('account.business', true);
    expect(form().errors.company).toBe('Enter your company');
    runtime.setState('account.business', false);
    expect(form().errors.company).toBeNull();
  });

  it('shows API errors until the field changes, including undeclared fields', () => {
    const { runtime, form } = setup();
    runtime.setState('account', { email: 'taken@example.com', password: 'secret123', confirm: 'secret123' });
    runtime.setFormErrors('account', { email: 'Already registered', terms: 'Accept the terms' });
    expect(form()).toMatchObject({
      valid: false,
      shown: { email: 'Already registered', terms: 'Accept the terms' },
    });
    runtime.setState('account.password', 'secret1234');
    expect(form().errors.email).toBe('Already registered');
    expect(form().errors.terms).toBeUndefined();
    runtime.setState('account.email', 'ada@example.com');
    expect(form().errors.email).toBeNull();
    runtime.setFormErrors('account', [{ field: 'password', message: 'Too common' }, { field: 1 }]);
    expect(form().errors.password).toBe('Too common');
  });

  it('resets values, touched fields and API errors', async () => {
    const { runtime, form } = setup();
    runtime.setState('account.email', 'x');
    runtime.touch('account.email');
    runtime.setFormErrors('account', { password: 'nope' });
    await runtime.run(actions([{ do: 'resetForm', form: 'account' }]), null);
    expect(runtime.getState('account.email')).toBe('');
    expect(form()).toMatchObject({ submitted: false, touched: {}, shown: { email: null, password: null } });
    await runtime.run(
      actions([{ do: 'resetForm', form: 'account', values: { email: 'ada@example.com' } }]),
      null,
    );
    expect(runtime.getState('account.email')).toBe('ada@example.com');
    await runtime.run(actions([{ do: 'setErrors', form: 'account', errors: { email: 'Taken' } }]), null);
    expect(form().shown.email).toBe('Taken');
  });

  it("with show: 'submit', errors appear only after validate", async () => {
    const doc = structuredClone(formDoc);
    doc.forms!.account!.show = 'submit';
    const { runtime, form } = setup(doc);
    runtime.setState('account.email', 'ada');
    runtime.touch('account.email');
    expect(form().shown.email).toBeNull();
    await runtime.run(actions([{ do: 'validate', form: 'account' }]), null);
    expect(form().shown.email).toBe('Enter a valid email address');
  });

  it('translates built-in messages and follows the language', async () => {
    const i18n = new I18n({
      locale: 'en',
      local: { en: {}, de: { 'zyrox.form.required': 'Pflichtfeld' } },
    });
    const { runtime, form } = setup(formDoc, { i18n });
    runtime.start();
    expect(form().errors.password).toBe('This field is required');
    await i18n.setLocale('de');
    await tick();
    expect(form().errors.password).toBe('Pflichtfeld');
    expect(form().errors.email).toBe('Enter your email');
    runtime.stop();
  });

  it('validates form definitions and actions', () => {
    const bad: Document = {
      ...formDoc,
      forms: {
        account: { fields: { email: { pattern: '([', rules: [{ check: '{{ value ==', message: 'x' }] } } },
      },
      root: { id: 'root', type: 'Screen', on: { press: [{ do: 'validate', form: 'missing' }] } },
    };
    const codes = validateDocument(bad).map((p) => p.code);
    expect(codes).toContain('unknown_form');
    expect(codes).toContain('invalid_rule');
    expect(codes).toContain('expression');
    const warn = validateDocument({ ...formDoc, state: {} });
    expect(warn.some((p) => p.level === 'warning' && p.path === 'forms.account')).toBe(true);
    expect(hasErrors(validateDocument(formDoc))).toBe(false);
  });
});
