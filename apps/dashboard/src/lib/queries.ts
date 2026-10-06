import { QueryClient, useQuery } from '@tanstack/react-query';
import { get } from './api';
import type { DocumentSummary, Environment, ManifestEntry, Project, Role, User } from './types';

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 } },
});

export function useAuthStatus() {
  return useQuery({
    queryKey: ['auth'],
    queryFn: () => get<{ hasUsers: boolean; openSignup: boolean; user: User | null }>('/auth/status'),
  });
}

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => get<{ user: User; projects: (Project & { role: Role })[] }>('/me'),
  });
}

export function useProject(slug: string) {
  return useQuery({
    queryKey: ['project', slug],
    queryFn: () => get<{ project: Project; role: Role; environments: Environment[] }>(`/projects/${slug}`),
  });
}

export function useDocuments(slug: string) {
  return useQuery({
    queryKey: ['documents', slug],
    queryFn: () => get<{ documents: DocumentSummary[] }>(`/projects/${slug}/documents`),
  });
}

export function useManifests(slug: string) {
  return useQuery({
    queryKey: ['manifests', slug],
    queryFn: () => get<{ manifests: ManifestEntry[] }>(`/projects/${slug}/manifests`),
  });
}

export function useLatestManifest(slug: string) {
  const q = useManifests(slug);
  return { ...q, manifest: q.data?.manifests.find((m) => m.latest)?.manifest };
}

const ROLE_ORDER: Role[] = ['viewer', 'editor', 'publisher', 'admin'];
export const can = (role: Role | undefined, min: Role) =>
  !!role && ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(min);
