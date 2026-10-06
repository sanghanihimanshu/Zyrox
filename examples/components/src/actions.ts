import { implementAction } from '@wishyor/zyrox-react';
import { AddToCartDef, RemoveFromCartDef } from './defs';

export interface ExampleActionHandlers {
  addToCart?(productId: string, qty: number, price?: number): unknown;
  removeFromCart?(productId: string, qty: number): unknown;
}

/** Example host actions. Your app decides what they do. */
export function exampleActions(handlers: ExampleActionHandlers = {}) {
  return [
    implementAction(AddToCartDef, async ({ productId, qty, price }) => {
      await (price === undefined
        ? handlers.addToCart?.(productId, qty)
        : handlers.addToCart?.(productId, qty, price));
    }),
    implementAction(RemoveFromCartDef, async ({ productId, qty }) => {
      await handlers.removeFromCart?.(productId, qty);
    }),
  ];
}
