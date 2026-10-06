import type { Product } from './contract';

/** A small in-memory catalog. Emoji stand in for product photos so the demo works offline. */
const p = (
  id: string,
  name: string,
  unit: string,
  price: number,
  mrp: number | undefined,
  emoji: string,
  color: string,
  category: string,
  tags: string[] = [],
): Product => ({
  id,
  name,
  unit,
  price,
  ...(mrp ? { mrp } : {}),
  emoji,
  color,
  category,
  eta: 8 + (id.length % 5),
  tags,
});

export const products: Product[] = [
  p('banana', 'Robusta Banana', '6 pcs', 49, 60, '🍌', '#fef3c7', 'fruits', ['bestseller']),
  p('apple', 'Shimla Apple', '4 pcs', 129, 160, '🍎', '#fee2e2', 'fruits', ['bestseller']),
  p('mango', 'Alphonso Mango', '2 pcs', 199, 249, '🥭', '#ffedd5', 'fruits', ['seasonal']),
  p('grapes', 'Green Grapes', '500 g', 79, undefined, '🍇', '#ecfccb', 'fruits'),
  p('avocado', 'Hass Avocado', '1 pc', 149, 179, '🥑', '#dcfce7', 'fruits'),
  p('tomato', 'Tomato Hybrid', '1 kg', 39, 50, '🍅', '#fee2e2', 'vegetables', ['bestseller']),
  p('onion', 'Onion', '1 kg', 45, undefined, '🧅', '#f5f5f4', 'vegetables'),
  p('carrot', 'Ooty Carrot', '500 g', 42, 55, '🥕', '#ffedd5', 'vegetables'),
  p('broccoli', 'Broccoli', '1 pc', 89, 110, '🥦', '#dcfce7', 'vegetables'),
  p('milk', 'Toned Milk', '500 ml', 28, undefined, '🥛', '#e0f2fe', 'dairy', ['bestseller', 'daily']),
  p('curd', 'Fresh Curd', '400 g', 45, 50, '🍶', '#f1f5f9', 'dairy', ['daily']),
  p('paneer', 'Malai Paneer', '200 g', 95, 110, '🧀', '#fef9c3', 'dairy'),
  p('eggs', 'Farm Eggs', '6 pcs', 66, 72, '🥚', '#fafaf9', 'dairy', ['daily']),
  p('bread', 'Whole Wheat Bread', '400 g', 50, undefined, '🍞', '#fef3c7', 'bakery', ['daily']),
  p('croissant', 'Butter Croissant', '2 pcs', 120, 140, '🥐', '#ffedd5', 'bakery'),
  p('chips', 'Salted Chips', '90 g', 20, undefined, '🥔', '#fef9c3', 'snacks', ['under99']),
  p('cookies', 'Choco Chip Cookies', '150 g', 60, 75, '🍪', '#f5f5f4', 'snacks', ['under99']),
  p('popcorn', 'Butter Popcorn', '70 g', 35, undefined, '🍿', '#fef3c7', 'snacks', ['under99']),
  p('chocolate', 'Dark Chocolate', '100 g', 99, 120, '🍫', '#fae8ff', 'snacks', ['under99', 'festive']),
  p('cola', 'Cola', '750 ml', 40, undefined, '🥤', '#fee2e2', 'drinks', ['under99']),
  p('juice', 'Orange Juice', '1 L', 110, 130, '🧃', '#ffedd5', 'drinks'),
  p('coffee', 'Cold Coffee', '200 ml', 70, 80, '☕', '#f5f5f4', 'drinks', ['under99']),
  p('diya', 'Clay Diyas', '12 pcs', 149, 199, '🪔', '#ffedd5', 'festive', ['festive']),
  p('sweets', 'Kaju Katli', '250 g', 299, 349, '🍬', '#fae8ff', 'festive', ['festive']),
  p('flowers', 'Marigold Garland', '1 pc', 89, undefined, '🌼', '#fef9c3', 'festive', ['festive']),
];

export const categories = [
  { id: 'fruits', name: 'Fruits', emoji: '🍎', color: '#fee2e2' },
  { id: 'vegetables', name: 'Vegetables', emoji: '🥦', color: '#dcfce7' },
  { id: 'dairy', name: 'Dairy & Eggs', emoji: '🥛', color: '#e0f2fe' },
  { id: 'bakery', name: 'Bakery', emoji: '🍞', color: '#fef3c7' },
  { id: 'snacks', name: 'Snacks', emoji: '🍿', color: '#fef9c3' },
  { id: 'drinks', name: 'Drinks', emoji: '🥤', color: '#fee2e2' },
  { id: 'festive', name: 'Festive', emoji: '🪔', color: '#ffedd5' },
];

/** Collections are queries over the catalog; rails and "see all" pages use them. */
export const collections: Record<string, { title: string; match(p: Product): boolean }> = {
  bestsellers: { title: 'Bestsellers', match: (x) => x.tags.includes('bestseller') },
  daily: { title: 'Daily essentials', match: (x) => x.tags.includes('daily') },
  under99: { title: 'Under ₹99', match: (x) => x.price < 99 },
  festive: { title: 'Festive picks', match: (x) => x.tags.includes('festive') },
  ...Object.fromEntries(
    categories.map((c) => [c.id, { title: c.name, match: (x: Product) => x.category === c.id }]),
  ),
};
