import type { Document, Manifest } from '@wishyor/zyrox-protocol';

export type Role = 'viewer' | 'editor' | 'publisher' | 'admin';
export type Kind = 'screen' | 'block' | 'strings';

export interface User {
  id: string;
  email: string;
  name: string;
  owner: boolean;
}

export interface Project {
  id: string;
  slug: string;
  name: string;
  defaultLocale: string;
  previewUrl: string | null;
  role?: Role;
}

export interface Environment {
  id: string;
  key: string;
  name: string;
  publicKey: string;
  ttl: number;
}

export interface DocumentSummary {
  id: string;
  key: string;
  kind: Kind;
  title: string;
  description: string;
  revision: number | null;
  updatedAt: string | null;
  latest: { number: number; ref: string; createdAt: string } | null;
  dirty: boolean;
  live: Record<string, { number: number; rules: number }>;
}

export interface Draft {
  content: Document | StringsContent;
  revision: number;
  updatedAt?: string;
}

export interface StringsContent {
  zyrox: 1;
  kind: 'strings';
  locale: string;
  messages: Record<string, string>;
}

export interface Problem {
  level: 'error' | 'warning';
  code: string;
  message: string;
  nodeId?: string;
  path?: string;
}

export interface CompatEntry {
  hash: string;
  label: string;
  share: number;
  problems: Problem[];
}

export interface ManifestEntry {
  hash: string;
  label: string;
  uploadedAt: string;
  latest: boolean;
  share: number;
  requests: number;
  manifest: Manifest;
}
