import { defineAction, defineComponent, z, zx } from '@wishyor/zyrox-protocol';

const tone = z.enum(['default', 'muted', 'primary', 'danger', 'success']);
const space = z.enum(['none', 'xs', 'sm', 'md', 'lg', 'xl']);

export const ScreenDef = defineComponent({
  name: 'Screen',
  source: 'examples/components/src/{web,native}/components.tsx#Screen',
  description:
    'Top-level screen container with an optional title. Scrolls its children; the "footer" slot stays pinned to the bottom (cart bars, checkout buttons).',
  props: z.object({ title: z.string().optional(), padding: space.default('md') }),
  children: true,
  slots: ['footer'],
});

export const StackDef = defineComponent({
  name: 'Stack',
  source: 'examples/components/src/{web,native}/components.tsx#Stack',
  description: 'Lays out children in a row or column with consistent spacing.',
  props: z.object({
    direction: z.enum(['row', 'column']).default('column'),
    gap: space.default('sm'),
    padding: space.default('none'),
    align: z.enum(['start', 'center', 'end', 'stretch']).default('stretch'),
    justify: z.enum(['start', 'center', 'end', 'between']).default('start'),
    wrap: z.boolean().default(false),
  }),
  children: true,
});

export const TextDef = defineComponent({
  name: 'Text',
  source: 'examples/components/src/{web,native}/components.tsx#Text',
  description: 'A run of text.',
  props: z.object({
    text: z.union([z.string(), z.number()]),
    variant: z.enum(['title', 'subtitle', 'body', 'caption']).default('body'),
    tone: tone.default('default'),
    lines: z.number().int().min(1).optional(),
  }),
});

export const ButtonDef = defineComponent({
  name: 'Button',
  source: 'examples/components/src/{web,native}/components.tsx#Button',
  description: 'A pressable button.',
  props: z.object({
    label: z.string(),
    variant: z.enum(['primary', 'secondary', 'ghost']).default('primary'),
    disabled: z.boolean().default(false),
    loading: z.boolean().default(false),
  }),
  events: ['press'],
});

export const TextFieldDef = defineComponent({
  name: 'TextField',
  source: 'examples/components/src/{web,native}/components.tsx#TextField',
  description: 'Single-line text input. Bind it to a state path.',
  props: z.object({
    label: z.string().optional(),
    placeholder: z.string().optional(),
    value: z.string().default(''),
    secure: z.boolean().default(false),
    /** Set automatically for fields of a document form (and shown as an asterisk). */
    required: z.boolean().default(false),
    /** Set automatically from the document form's rules once the field is touched. */
    error: z.string().optional(),
  }),
  events: { change: z.string(), submit: z.object({}), blur: z.object({}) },
  bind: { prop: 'value', event: 'change' },
});

export const ToggleDef = defineComponent({
  name: 'Toggle',
  source: 'examples/components/src/{web,native}/components.tsx#Toggle',
  description: 'On/off switch with a label. Bind it to a boolean state path.',
  props: z.object({ label: z.string(), value: z.boolean().default(false) }),
  events: { change: z.boolean() },
  bind: { prop: 'value', event: 'change' },
});

export const ImageDef = defineComponent({
  name: 'Image',
  source: 'examples/components/src/{web,native}/components.tsx#Image',
  description: 'An image with a fixed aspect ratio.',
  props: z.object({
    src: zx.image(),
    alt: z.string().optional(),
    aspectRatio: z.number().positive().default(1),
    radius: space.default('none'),
  }),
});

export const CardDef = defineComponent({
  name: 'Card',
  source: 'examples/components/src/{web,native}/components.tsx#Card',
  description: 'A surface that groups content. Optional footer slot; pressable.',
  props: z.object({ title: z.string().optional(), subtitle: z.string().optional() }),
  events: ['press'],
  children: true,
  slots: ['footer'],
});

export const BadgeDef = defineComponent({
  name: 'Badge',
  source: 'examples/components/src/{web,native}/components.tsx#Badge',
  description: 'Small status label.',
  props: z.object({ label: z.string(), tone: tone.default('primary') }),
});

export const ListDef = defineComponent({
  name: 'List',
  source: 'examples/components/src/{web,native}/components.tsx#List',
  description: 'Virtualized list. Renders the "item" template for each element of items.',
  props: z.object({
    items: z.array(z.unknown()).default([]),
    columns: z.number().int().min(1).max(6).default(1),
    gap: space.default('sm'),
    keyField: z.string().default('id'),
    horizontal: z.boolean().default(false).describe('One scrolling row (rails, carousels)'),
    itemWidth: z.number().positive().optional().describe('Item width in a horizontal list'),
  }),
  events: ['endReached'],
  slots: ['empty'],
  templates: ['item'],
});

export const TileDef = defineComponent({
  name: 'Tile',
  source: 'examples/components/src/{web,native}/components.tsx#Tile',
  description:
    'A colored tile with an emoji or image and a title: promo banners (size "lg") and category shortcuts (size "sm"). Pressable.',
  props: z.object({
    title: z.string(),
    subtitle: z.string().optional(),
    emoji: z.string().optional(),
    image: zx.image().optional(),
    color: zx.color().default('#f4f5f7'),
    size: z.enum(['sm', 'lg']).default('sm'),
  }),
  events: ['press'],
});

export const ProductCardDef = defineComponent({
  name: 'ProductCard',
  source: 'examples/components/src/{web,native}/components.tsx#ProductCard',
  description:
    'Quick-commerce product card: image or emoji, name, unit, price with MRP and discount, delivery time, and an ADD button that becomes a quantity stepper. Bind qty to the cart.',
  props: z.object({
    name: z.string(),
    unit: z.string().optional(),
    price: z.number(),
    mrp: z.number().optional(),
    emoji: z.string().optional(),
    image: zx.image().optional(),
    color: zx.color().default('#f4f5f7'),
    eta: z.number().int().optional().describe('Minutes to delivery'),
    qty: z.number().int().min(0).default(0).describe('Quantity in the cart'),
    currency: z.string().default('INR'),
    width: z.number().positive().optional().describe('Fixed width in rails; fills the cell in grids'),
  }),
  events: ['press', 'add', 'remove'],
});

export const SectionDef = defineComponent({
  name: 'Section',
  source: 'examples/components/src/{web,native}/components.tsx#Section',
  description:
    'Renders another Zyrox document inline by key, with params. Use it for feed sections the backend places (each loads its own data) and for reusable widgets.',
  props: z.object({
    screen: z.string().describe('Document key, e.g. "sections/product-rail"'),
    params: z.record(z.string(), z.unknown()).default({}),
  }),
});

export const AddToCartDef = defineAction({
  name: 'addToCart',
  description: 'Adds a product to the cart.',
  args: z.object({
    productId: z.string(),
    qty: z.number().int().min(1).default(1),
    price: z.number().optional(),
  }),
});

export const RemoveFromCartDef = defineAction({
  name: 'removeFromCart',
  description: 'Removes a quantity of a product from the cart.',
  args: z.object({ productId: z.string(), qty: z.number().int().min(1).default(1) }),
});

export const componentDefs = [
  ScreenDef,
  StackDef,
  TextDef,
  ButtonDef,
  TextFieldDef,
  ToggleDef,
  ImageDef,
  CardDef,
  BadgeDef,
  ListDef,
  TileDef,
  ProductCardDef,
  SectionDef,
] as const;

export const actionDefs = [AddToCartDef, RemoveFromCartDef] as const;

/** Host helpers registered by the example apps (built-ins such as `t` and `format.*` are always available). */
export const helperNames: string[] = [];
