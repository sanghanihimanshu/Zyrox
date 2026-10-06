// UI the backend triggers in the app, with @zyrox/actions. Any backend can send the same JSON.
import { trigger, UiChannel, type UiTrigger, ui, uiMessage, withActions } from '@zyrox/actions';
import { ShopError } from './api';

const COUPONS: Record<string, string> = {
  DIWALI30: '30% off festive items',
  FIRST100: '₹100 off your first order',
};

/** `POST /coupons/apply`: the response tells the app what to show. */
export function applyCoupon(code: string) {
  const upper = code.trim().toUpperCase();
  const offer = COUPONS[upper];
  if (!offer)
    throw new ShopError(
      422,
      'Invalid coupon',
      withActions(
        { code: upper },
        ui.alert('Coupon not valid', `${upper || 'This code'} has expired or doesn't exist.`, [
          ui.button('OK', undefined, 'cancel'),
          ui.button('See offers', [ui.navigate('shop-collection', { id: 'festive' })], 'primary'),
        ]),
      ),
    );
  return withActions({ code: upper, offer }, ui.toast(`${upper} applied: ${offer}`, { tone: 'success' }));
}

/**
 * `GET /ui/triggers`: rules the app evaluates on its own events. Change them here (or in your
 * campaign tool) without an app release.
 */
export function uiTriggers(): UiTrigger[] {
  return [
    trigger({
      id: 'welcome',
      on: 'app_open',
      maxPerSession: 1,
      actions: [ui.toast('Delivering to Home · Indiranagar in 10 minutes')],
    }),
    trigger({
      id: 'free-delivery',
      on: 'track',
      name: 'add_to_cart',
      if: '{{ event.props.price < 199 }}',
      once: true,
      actions: [
        ui.message(
          {
            title: 'Free delivery over ₹199',
            message: 'Add ₹{{ 199 - event.props.price }} more to skip the delivery fee.',
            buttons: [
              ui.button(
                'See bestsellers',
                [ui.navigate('shop-collection', { id: 'bestsellers' })],
                'primary',
              ),
              ui.button('Keep shopping', undefined, 'cancel'),
            ],
          },
          { id: 'free-delivery' },
        ),
      ],
    }),
    trigger({
      id: 'mango-season',
      on: 'screen_view',
      name: 'shop-collection',
      if: "{{ event.params.id == 'fruits' }}",
      cooldown: 3600,
      delay: 1200,
      actions: [
        ui.toast('Alphonso mangoes are back 🥭', {
          action: { label: 'Show', actions: [ui.navigate('shop-product', { id: 'mango' })] },
        }),
      ],
    }),
  ];
}

/**
 * Pushes UI to connected apps by user. `server.ts` serves it as server-sent events; the example
 * apps also subscribe to it in-process when they run without a backend.
 */
export const shopEvents = new UiChannel();

/** What an order-status worker would send. */
export function orderUpdate(orderId: string) {
  return uiMessage(
    [
      ui.message(
        {
          title: 'Your order is on the way 🛵',
          message: 'Ravi will reach you in about 6 minutes.',
          buttons: [ui.button('OK', undefined, 'primary')],
        },
        { id: `order-${orderId}` },
      ),
    ],
    { id: `order-${orderId}-out-for-delivery`, expiresIn: 600 },
  );
}
