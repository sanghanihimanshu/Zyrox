import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useLocation } from 'wouter';
import { post } from '../lib/api';
import { queryClient, useAuthStatus } from '../lib/queries';
import { Button, Card, errorMessage, Field, Input } from '../ui';
import { Logo } from './Logo';

export function Login() {
  const status = useAuthStatus();
  const firstRun = status.data && !status.data.hasUsers;
  const [mode, setMode] = useState<'login' | 'signup'>(firstRun ? 'signup' : 'login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [, navigate] = useLocation();
  const submit = useMutation({
    mutationFn: () => post(mode === 'signup' ? '/auth/signup' : '/auth/login', form),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      navigate('/');
    },
  });
  const signup = mode === 'signup' || firstRun;
  return (
    <div className="grid min-h-full place-items-center p-4">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-6 flex items-center gap-2">
          <Logo />
          <span className="text-lg font-semibold">Zyrox</span>
        </div>
        <h1 className="mb-1 text-lg font-semibold">
          {firstRun ? 'Create the owner account' : signup ? 'Create an account' : 'Sign in'}
        </h1>
        <p className="mb-5 text-sm text-zinc-500">
          {firstRun
            ? 'The first account owns this Zyrox server.'
            : 'Build, release and monitor your server-driven UI.'}
        </p>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit.mutate();
          }}
        >
          {signup ? (
            <Field label="Name">
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                autoComplete="name"
              />
            </Field>
          ) : null}
          <Field label="Email">
            <Input
              type="email"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              autoComplete="email"
            />
          </Field>
          <Field label="Password" hint={signup ? 'At least 8 characters' : undefined}>
            <Input
              type="password"
              required
              minLength={8}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              autoComplete={signup ? 'new-password' : 'current-password'}
            />
          </Field>
          {submit.error ? <p className="text-sm text-red-600">{errorMessage(submit.error)}</p> : null}
          <Button type="submit" variant="primary" loading={submit.isPending} className="mt-1">
            {signup ? 'Create account' : 'Sign in'}
          </Button>
        </form>
        {!firstRun && status.data?.openSignup ? (
          <button
            type="button"
            className="mt-4 text-sm text-indigo-600 hover:underline"
            onClick={() => setMode(signup ? 'login' : 'signup')}
          >
            {signup ? 'I already have an account' : 'Create an account'}
          </button>
        ) : null}
      </Card>
    </div>
  );
}
