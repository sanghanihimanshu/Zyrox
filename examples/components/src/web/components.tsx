import { implement, useI18n, useZyrox, ZyroxScreen } from '@zyrox/react';
import type { CSSProperties } from 'react';
import {
  BadgeDef,
  ButtonDef,
  CardDef,
  ImageDef,
  ListDef,
  ProductCardDef,
  ScreenDef,
  SectionDef,
  StackDef,
  TextDef,
  TextFieldDef,
  TileDef,
  ToggleDef,
} from '../defs';
import { discount, formatPrice } from '../format';
import { palette, type Scheme, space, textSize, textWeight, toneColor } from '../tokens';

function useScheme(): Scheme {
  // Example only: a real app reads its own theme.
  useZyrox();
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

const align = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' } as const;
const justify = { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between' } as const;

export const Screen = implement(ScreenDef, ({ title, padding, children, slots, nodeId }) => {
  const p = palette[useScheme()];
  return (
    <main
      data-zyrox-id={nodeId}
      style={{
        padding: space[padding],
        background: p.bg,
        color: p.text,
        minHeight: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: space.md,
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      {title ? <h1 style={{ margin: 0, fontSize: textSize.title }}>{title}</h1> : null}
      {children}
      {slots.footer ? (
        <div style={{ position: 'sticky', bottom: 0, marginTop: 'auto', paddingBottom: space.sm }}>
          {slots.footer}
        </div>
      ) : null}
    </main>
  );
});

export const Stack = implement(StackDef, (props) => (
  <div
    data-zyrox-id={props.nodeId}
    style={{
      display: 'flex',
      flexDirection: props.direction,
      gap: space[props.gap],
      padding: space[props.padding],
      alignItems: align[props.align],
      justifyContent: justify[props.justify],
      flexWrap: props.wrap ? 'wrap' : 'nowrap',
    }}
  >
    {props.children}
  </div>
));

export const Text = implement(TextDef, ({ text, variant, tone, lines, nodeId, a11y }) => {
  const scheme = useScheme();
  const style: CSSProperties = {
    margin: 0,
    fontSize: textSize[variant],
    fontWeight: textWeight[variant],
    color: toneColor(scheme, tone),
  };
  if (lines)
    Object.assign(style, {
      display: '-webkit-box',
      WebkitLineClamp: lines,
      WebkitBoxOrient: 'vertical',
      overflow: 'hidden',
    });
  const Tag = variant === 'title' ? 'h2' : variant === 'subtitle' ? 'h3' : 'p';
  return (
    <Tag data-zyrox-id={nodeId} style={style} aria-label={a11y?.label}>
      {String(text)}
    </Tag>
  );
});

export const Button = implement(ButtonDef, ({ label, variant, disabled, loading, onPress, nodeId, a11y }) => {
  const p = palette[useScheme()];
  const filled = variant === 'primary';
  return (
    <button
      type="button"
      data-zyrox-id={nodeId}
      aria-label={a11y?.label}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      onClick={() => onPress?.()}
      style={{
        padding: `${space.sm}px ${space.md}px`,
        borderRadius: 10,
        border: variant === 'secondary' ? `1px solid ${p.border}` : 'none',
        background: filled ? p.primary : 'transparent',
        color: filled ? p.onPrimary : p.primary,
        fontSize: textSize.body,
        fontWeight: 600,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {loading ? '…' : label}
    </button>
  );
});

export const TextField = implement(
  TextFieldDef,
  ({ label, placeholder, value, secure, required, error, onChange, onSubmit, onBlur, nodeId }) => {
    const p = palette[useScheme()];
    return (
      <label
        data-zyrox-id={nodeId}
        style={{ display: 'flex', flexDirection: 'column', gap: space.xs, color: p.text }}
      >
        {label ? (
          <span style={{ fontSize: textSize.caption, fontWeight: 600 }}>
            {label}
            {required ? (
              <span aria-hidden style={{ color: p.danger }}>
                {' *'}
              </span>
            ) : null}
          </span>
        ) : null}
        <input
          type={secure ? 'password' : 'text'}
          value={value}
          placeholder={placeholder}
          aria-label={label}
          aria-required={required || undefined}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange?.(e.target.value)}
          onBlur={() => onBlur?.({})}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit?.({});
          }}
          style={{
            padding: space.sm,
            borderRadius: 8,
            border: `1px solid ${error ? p.danger : p.border}`,
            fontSize: textSize.body,
            background: p.bg,
            color: p.text,
          }}
        />
        {error ? (
          <span role="alert" style={{ color: p.danger, fontSize: textSize.caption }}>
            {error}
          </span>
        ) : null}
      </label>
    );
  },
);

export const Toggle = implement(ToggleDef, ({ label, value, onChange, nodeId }) => (
  <label data-zyrox-id={nodeId} style={{ display: 'flex', alignItems: 'center', gap: space.sm }}>
    <input
      type="checkbox"
      role="switch"
      aria-checked={value}
      aria-label={label}
      checked={value}
      onChange={(e) => onChange?.(e.target.checked)}
    />
    <span>{label}</span>
  </label>
));

export const Image = implement(ImageDef, ({ src, alt, aspectRatio, radius, nodeId }) => (
  <img
    data-zyrox-id={nodeId}
    src={src}
    alt={alt ?? ''}
    style={{
      width: '100%',
      aspectRatio: String(aspectRatio),
      objectFit: 'cover',
      borderRadius: space[radius],
      display: 'block',
    }}
  />
));

export const Card = implement(CardDef, ({ title, subtitle, onPress, children, slots, nodeId }) => {
  const p = palette[useScheme()];
  const style: CSSProperties = {
    background: p.surface,
    border: `1px solid ${p.border}`,
    borderRadius: 14,
    padding: space.md,
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
    textAlign: 'start',
    font: 'inherit',
    color: p.text,
    width: '100%',
    boxSizing: 'border-box',
  };
  const body = (
    <>
      {children}
      {title ? <strong>{title}</strong> : null}
      {subtitle ? <span style={{ color: p.muted, fontSize: textSize.caption }}>{subtitle}</span> : null}
      {slots.footer}
    </>
  );
  return onPress ? (
    <button
      type="button"
      data-zyrox-id={nodeId}
      aria-label={title}
      onClick={() => onPress()}
      style={{ ...style, cursor: 'pointer' }}
    >
      {body}
    </button>
  ) : (
    <div data-zyrox-id={nodeId} style={style}>
      {body}
    </div>
  );
});

export const Badge = implement(BadgeDef, ({ label, tone, nodeId }) => {
  const color = toneColor(useScheme(), tone);
  return (
    <span
      data-zyrox-id={nodeId}
      style={{
        display: 'inline-block',
        alignSelf: 'flex-start',
        padding: `2px ${space.sm}px`,
        borderRadius: 999,
        border: `1px solid ${color}`,
        color,
        fontSize: textSize.caption,
        fontWeight: 600,
      }}
    >
      {label}
    </span>
  );
});

export const List = implement(
  ListDef,
  ({ items, columns, gap, keyField, horizontal, itemWidth, templates, slots, nodeId }) => {
    if (!items.length) return <>{slots.empty}</>;
    const style: CSSProperties = horizontal
      ? {
          display: 'flex',
          gap: space[gap],
          overflowX: 'auto',
          scrollSnapType: 'x mandatory',
          paddingBottom: 4,
          scrollbarWidth: 'none',
        }
      : { display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: space[gap] };
    return (
      <ul data-zyrox-id={nodeId} style={{ listStyle: 'none', margin: 0, padding: 0, ...style }}>
        {items.map((item, index) => {
          const key =
            item && typeof item === 'object' && keyField in item
              ? String((item as Record<string, unknown>)[keyField])
              : index;
          return (
            <li
              key={key}
              style={
                horizontal
                  ? { flex: `0 0 ${itemWidth ? `${itemWidth}px` : 'auto'}`, scrollSnapAlign: 'start' }
                  : undefined
              }
            >
              {templates.item(item, index)}
            </li>
          );
        })}
      </ul>
    );
  },
);

export const Tile = implement(
  TileDef,
  ({ title, subtitle, emoji, image, color, size, onPress, nodeId, a11y }) => {
    const large = size === 'lg';
    return (
      <button
        type="button"
        data-zyrox-id={nodeId}
        aria-label={a11y?.label ?? title}
        onClick={() => onPress?.()}
        disabled={!onPress}
        style={{
          all: 'unset',
          boxSizing: 'border-box',
          cursor: onPress ? 'pointer' : 'default',
          display: 'flex',
          flexDirection: large ? 'row' : 'column',
          alignItems: 'center',
          justifyContent: large ? 'space-between' : 'center',
          gap: space.sm,
          width: '100%',
          minHeight: large ? 120 : 92,
          padding: large ? space.md : space.sm,
          borderRadius: 16,
          background: color,
          color: '#14161a',
          textAlign: large ? 'start' : 'center',
        }}
      >
        <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <strong style={{ fontSize: large ? textSize.subtitle : textSize.caption }}>{title}</strong>
          {subtitle ? <span style={{ fontSize: textSize.caption, opacity: 0.75 }}>{subtitle}</span> : null}
        </span>
        {image ? (
          <img
            src={image}
            alt=""
            style={{ width: large ? 72 : 44, height: large ? 72 : 44, objectFit: 'cover' }}
          />
        ) : emoji ? (
          <span aria-hidden style={{ fontSize: large ? 52 : 32, order: large ? 0 : -1 }}>
            {emoji}
          </span>
        ) : null}
      </button>
    );
  },
);

export const ProductCard = implement(
  ProductCardDef,
  ({
    name,
    unit,
    price,
    mrp,
    emoji,
    image,
    color,
    eta,
    qty,
    currency,
    width,
    onPress,
    onAdd,
    onRemove,
    nodeId,
  }) => {
    const p = palette[useScheme()];
    const { locale } = useI18n();
    const off = discount(price, mrp);
    const stepper: CSSProperties = {
      all: 'unset',
      cursor: 'pointer',
      padding: '4px 10px',
      color: '#fff',
      fontWeight: 700,
    };
    return (
      <div
        data-zyrox-id={nodeId}
        style={{
          width: width ?? '100%',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          padding: space.sm,
          borderRadius: 14,
          border: `1px solid ${p.border}`,
          background: p.bg,
          color: p.text,
          position: 'relative',
        }}
      >
        {off ? (
          <span
            style={{
              position: 'absolute',
              top: 0,
              left: 8,
              background: '#2563eb',
              color: '#fff',
              fontSize: 10,
              fontWeight: 700,
              padding: '2px 5px',
              borderRadius: '0 0 6px 6px',
            }}
          >
            {off}% OFF
          </span>
        ) : null}
        <button
          type="button"
          aria-label={name}
          onClick={() => onPress?.()}
          style={{
            all: 'unset',
            cursor: onPress ? 'pointer' : 'default',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <span
            style={{
              display: 'grid',
              placeItems: 'center',
              aspectRatio: '1',
              borderRadius: 10,
              background: color,
              fontSize: 44,
              overflow: 'hidden',
            }}
          >
            {image ? (
              <img src={image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              emoji
            )}
          </span>
          {eta !== undefined ? (
            <span style={{ fontSize: 10, fontWeight: 700, color: p.muted }}>⏱ {eta} MINS</span>
          ) : null}
          <span style={{ fontSize: textSize.caption, fontWeight: 600, minHeight: 34, lineHeight: '17px' }}>
            {name}
          </span>
          {unit ? <span style={{ fontSize: 12, color: p.muted }}>{unit}</span> : null}
        </button>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 4,
            marginTop: 'auto',
          }}
        >
          <span style={{ display: 'flex', flexDirection: 'column' }}>
            <strong style={{ fontSize: textSize.caption }}>{formatPrice(price, currency, locale)}</strong>
            {off ? (
              <s style={{ fontSize: 11, color: p.muted }}>{formatPrice(mrp!, currency, locale)}</s>
            ) : null}
          </span>
          {qty > 0 ? (
            <fieldset
              style={{
                display: 'flex',
                alignItems: 'center',
                background: p.success,
                borderRadius: 8,
                border: 0,
                margin: 0,
                padding: 0,
                minWidth: 0,
              }}
              aria-label={`${qty} in cart`}
            >
              <button
                type="button"
                aria-label={`Remove ${name}`}
                style={stepper}
                onClick={() => onRemove?.()}
              >
                −
              </button>
              <span style={{ color: '#fff', fontWeight: 700, minWidth: 14, textAlign: 'center' }}>{qty}</span>
              <button type="button" aria-label={`Add ${name}`} style={stepper} onClick={() => onAdd?.()}>
                +
              </button>
            </fieldset>
          ) : (
            <button
              type="button"
              aria-label={`Add ${name}`}
              onClick={() => onAdd?.()}
              style={{
                all: 'unset',
                cursor: 'pointer',
                padding: '5px 14px',
                borderRadius: 8,
                border: `1px solid ${p.success}`,
                color: p.success,
                fontWeight: 700,
                fontSize: textSize.caption,
              }}
            >
              ADD
            </button>
          )}
        </div>
      </div>
    );
  },
);

/** Another Zyrox document, rendered inline with its own state and data. */
export const Section = implement(SectionDef, ({ screen, params, nodeId }) => (
  <div data-zyrox-id={nodeId}>
    <ZyroxScreen
      screen={screen}
      params={params}
      loading={<div style={{ height: 120, borderRadius: 14, background: '#f4f5f7' }} aria-busy />}
      fallback={null}
    />
  </div>
));

export const webComponents = [
  Screen,
  Stack,
  Text,
  Button,
  TextField,
  Toggle,
  Image,
  Card,
  Badge,
  List,
  Tile,
  ProductCard,
  Section,
];
