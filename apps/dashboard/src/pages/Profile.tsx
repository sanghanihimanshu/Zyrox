import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { patch } from '../lib/api';
import { queryClient, useMe } from '../lib/queries';
import { Button, Card, errorMessage, Field, Input, PageHeader, Spinner, useToast } from '../ui';

export function Profile() {
  const me = useMe();
  const toast = useToast();
  const [name, setName] = useState('');
  useEffect(() => {
    if (me.data) setName(me.data.user.name);
  }, [me.data]);
  const save = useMutation({
    mutationFn: () => patch('/me', { name: name.trim() }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['me'] }),
        queryClient.invalidateQueries({ queryKey: ['auth'] }),
      ]);
      toast('Profile updated', 'success');
    },
    onError: (error) => toast(errorMessage(error), 'error'),
  });

  if (me.isLoading || !me.data) return <Spinner />;
  return (
    <div className="mx-auto max-w-2xl p-6">
      <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
        Back to projects
      </Link>
      <PageHeader title="Profile" description="Manage the name shown to your team." />
      <Card className="max-w-xl p-5">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <Field label="Name">
            <Input value={name} onChange={(event) => setName(event.target.value)} required maxLength={100} />
          </Field>
          <Field label="Email">
            <Input value={me.data.user.email} readOnly />
          </Field>
          <Button
            type="submit"
            variant="primary"
            className="self-start"
            loading={save.isPending}
            disabled={!name.trim() || name.trim() === me.data.user.name}
          >
            Save profile
          </Button>
        </form>
      </Card>
    </div>
  );
}
