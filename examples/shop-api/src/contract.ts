/**
 * The contract between this backend and the app. The backend decides WHAT the home feed shows
 * (which sections, in which order, for whom); Zyrox documents decide HOW each section type looks.
 */

/** An API call the app makes later (lazily, when the section is on screen). GET only. */
export interface ApiCall {
  url: string;
}

/** Where a tap goes: a Zyrox screen key plus its params. */
export interface Link {
  screen: string;
  params?: Record<string, string | number>;
}

export interface Product {
  id: string;
  name: string;
  unit: string;
  price: number;
  mrp?: number;
  emoji: string;
  color: string;
  category: string;
  /** Minutes to delivery. */
  eta: number;
  tags: string[];
}

export interface Banner {
  id: string;
  title: string;
  subtitle?: string;
  emoji: string;
  color: string;
  link?: Link;
}

export interface Category {
  id: string;
  name: string;
  emoji: string;
  color: string;
  link: Link;
}

/** Sections the backend can place in the feed. Unknown types are skipped by older app builds. */
export type Section =
  /** Static: everything needed to render is inline. */
  | { id: string; type: 'banners'; items: Banner[] }
  | { id: string; type: 'categories'; title: string; items: Category[] }
  /** Dynamic: the section fetches its own data from `api` (e.g. personalized rails). */
  | { id: string; type: 'rail'; title: string; api: ApiCall; seeAll?: Link }
  /** UI designed in the Zyrox dashboard, placed and parameterised by the backend. */
  | { id: string; type: 'zyrox'; screen: string; params?: Record<string, unknown> };

export interface Feed {
  /** Header copy the backend controls (delivery promise, address). */
  header: { eta: string; address: string };
  sections: Section[];
}

export interface ProductPage {
  id: string;
  title: string;
  products: Product[];
  page: number;
  /** Next page number, or null at the end. */
  next: number | null;
}
