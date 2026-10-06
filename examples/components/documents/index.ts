import type { Document } from '@wishyor/zyrox-protocol';
import counterJson from './counter.json';
import homeJson from './home.json';
import productJson from './product.json';
import registerJson from './register.json';
import festiveSaleJson from './sections/festive-sale.json';
import productRailJson from './sections/product-rail.json';
import shopCollectionJson from './shop-collection.json';
import shopHomeJson from './shop-home.json';
import shopProductJson from './shop-product.json';
import signupJson from './signup.json';

export const counter = counterJson as unknown as Document;
export const home = homeJson as unknown as Document;
export const product = productJson as unknown as Document;
export const signup = signupJson as unknown as Document;
/** Declarative form validation (conditional, cross-field, async, server errors). */
export const register = registerJson as unknown as Document;

/** A quick-commerce home feed: backend-driven sections rendered by Zyrox documents. */
export const shopHome = shopHomeJson as unknown as Document;
export const shopCollection = shopCollectionJson as unknown as Document;
export const shopProduct = shopProductJson as unknown as Document;
export const productRail = productRailJson as unknown as Document;
export const festiveSale = festiveSaleJson as unknown as Document;

export const documents: Record<string, Document> = {
  'shop-home': shopHome,
  'shop-collection': shopCollection,
  'shop-product': shopProduct,
  'sections/product-rail': productRail,
  'sections/festive-sale': festiveSale,
  home,
  product,
  counter,
  signup,
  register,
};
