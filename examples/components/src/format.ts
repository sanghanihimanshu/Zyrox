/** Price label in the user's language, without decimals for whole amounts (₹49, ₹129.50). */
export function formatPrice(value: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale || 'en', {
      style: 'currency',
      currency,
      minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${value}`;
  }
}

/** Whole-percent discount from MRP, or 0. */
export function discount(price: number, mrp: number | undefined): number {
  return mrp && mrp > price ? Math.round((1 - price / mrp) * 100) : 0;
}
