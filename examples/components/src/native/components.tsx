import { implement, useI18n, ZyroxScreen } from '@wishyor/zyrox-react';
import {
  FlatList,
  Pressable,
  Image as RNImage,
  Text as RNText,
  ScrollView,
  Switch,
  TextInput,
  type TextStyle,
  useColorScheme,
  View,
} from 'react-native';
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
  return useColorScheme() === 'dark' ? 'dark' : 'light';
}

const align = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' } as const;
const justify = { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between' } as const;

export const Screen = implement(ScreenDef, ({ title, padding, children, slots, nodeId }) => {
  const p = palette[useScheme()];
  const body = (
    <ScrollView
      testID={nodeId}
      style={{ backgroundColor: p.bg }}
      contentContainerStyle={{ padding: space[padding], gap: space.md }}
    >
      {title ? (
        <RNText
          accessibilityRole="header"
          style={{ fontSize: textSize.title, fontWeight: '700', color: p.text }}
        >
          {title}
        </RNText>
      ) : null}
      {children}
    </ScrollView>
  );
  if (!slots.footer) return body;
  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      {body}
      <View style={{ paddingHorizontal: space[padding], paddingVertical: space.sm }}>{slots.footer}</View>
    </View>
  );
});

export const Stack = implement(StackDef, (props) => (
  <View
    testID={props.nodeId}
    style={{
      flexDirection: props.direction,
      gap: space[props.gap],
      padding: space[props.padding],
      alignItems: align[props.align],
      justifyContent: justify[props.justify],
      flexWrap: props.wrap ? 'wrap' : 'nowrap',
    }}
  >
    {props.children}
  </View>
));

export const Text = implement(TextDef, ({ text, variant, tone, lines, nodeId, a11y }) => {
  const style: TextStyle = {
    fontSize: textSize[variant],
    fontWeight: textWeight[variant],
    color: toneColor(useScheme(), tone),
  };
  return (
    <RNText
      testID={nodeId}
      style={style}
      numberOfLines={lines}
      accessibilityLabel={a11y?.label}
      accessibilityRole={variant === 'title' || variant === 'subtitle' ? 'header' : 'text'}
    >
      {String(text)}
    </RNText>
  );
});

export const Button = implement(ButtonDef, ({ label, variant, disabled, loading, onPress, nodeId, a11y }) => {
  const p = palette[useScheme()];
  const filled = variant === 'primary';
  return (
    <Pressable
      testID={nodeId}
      accessibilityRole="button"
      accessibilityLabel={a11y?.label ?? label}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      disabled={disabled || loading}
      onPress={() => onPress?.()}
      style={{
        paddingVertical: space.sm,
        paddingHorizontal: space.md,
        borderRadius: 10,
        borderWidth: variant === 'secondary' ? 1 : 0,
        borderColor: p.border,
        backgroundColor: filled ? p.primary : 'transparent',
        opacity: disabled ? 0.5 : 1,
        alignItems: 'center',
      }}
    >
      <RNText style={{ color: filled ? p.onPrimary : p.primary, fontSize: textSize.body, fontWeight: '600' }}>
        {loading ? '…' : label}
      </RNText>
    </Pressable>
  );
});

export const TextField = implement(
  TextFieldDef,
  ({ label, placeholder, value, secure, required, error, onChange, onSubmit, onBlur, nodeId }) => {
    const p = palette[useScheme()];
    return (
      <View style={{ gap: space.xs }}>
        {label ? (
          <RNText style={{ fontSize: textSize.caption, fontWeight: '600', color: p.text }}>
            {label}
            {required ? <RNText style={{ color: p.danger }}> *</RNText> : null}
          </RNText>
        ) : null}
        <TextInput
          testID={nodeId}
          accessibilityLabel={label}
          value={value}
          placeholder={placeholder}
          secureTextEntry={secure}
          onChangeText={(text) => onChange?.(text)}
          onSubmitEditing={() => onSubmit?.({})}
          onBlur={() => onBlur?.({})}
          style={{
            padding: space.sm,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: error ? p.danger : p.border,
            fontSize: textSize.body,
            color: p.text,
          }}
        />
        {error ? (
          <RNText accessibilityRole="alert" style={{ color: p.danger, fontSize: textSize.caption }}>
            {error}
          </RNText>
        ) : null}
      </View>
    );
  },
);

export const Toggle = implement(ToggleDef, ({ label, value, onChange, nodeId }) => (
  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
    <Switch testID={nodeId} accessibilityLabel={label} value={value} onValueChange={(v) => onChange?.(v)} />
    <RNText>{label}</RNText>
  </View>
));

export const Image = implement(ImageDef, ({ src, alt, aspectRatio, radius, nodeId }) => (
  <RNImage
    testID={nodeId}
    source={{ uri: src }}
    accessibilityLabel={alt}
    accessibilityIgnoresInvertColors
    style={{ width: '100%', aspectRatio, borderRadius: space[radius] }}
  />
));

export const Card = implement(CardDef, ({ title, subtitle, onPress, children, slots, nodeId }) => {
  const p = palette[useScheme()];
  const body = (
    <>
      {children}
      {title ? <RNText style={{ fontWeight: '700', color: p.text }}>{title}</RNText> : null}
      {subtitle ? <RNText style={{ color: p.muted, fontSize: textSize.caption }}>{subtitle}</RNText> : null}
      {slots.footer}
    </>
  );
  const style = {
    backgroundColor: p.surface,
    borderColor: p.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: space.md,
    gap: space.sm,
  };
  return onPress ? (
    <Pressable
      testID={nodeId}
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={() => onPress()}
      style={style}
    >
      {body}
    </Pressable>
  ) : (
    <View testID={nodeId} style={style}>
      {body}
    </View>
  );
});

export const Badge = implement(BadgeDef, ({ label, tone, nodeId }) => {
  const color = toneColor(useScheme(), tone);
  return (
    <View
      testID={nodeId}
      style={{
        alignSelf: 'flex-start',
        paddingHorizontal: space.sm,
        paddingVertical: 2,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: color,
      }}
    >
      <RNText style={{ color, fontSize: textSize.caption, fontWeight: '600' }}>{label}</RNText>
    </View>
  );
});

export const List = implement(
  ListDef,
  ({ items, columns, gap, keyField, horizontal, itemWidth, templates, slots, onEndReached, nodeId }) => (
    <FlatList
      testID={nodeId}
      data={items}
      key={horizontal ? 'h' : columns}
      horizontal={horizontal}
      showsHorizontalScrollIndicator={false}
      numColumns={horizontal ? undefined : columns}
      scrollEnabled={horizontal}
      initialNumToRender={horizontal ? 4 : 10}
      keyExtractor={(item, index) =>
        item && typeof item === 'object' && keyField in item
          ? String((item as Record<string, unknown>)[keyField])
          : String(index)
      }
      columnWrapperStyle={!horizontal && columns > 1 ? { gap: space[gap] } : undefined}
      contentContainerStyle={{ gap: space[gap] }}
      renderItem={({ item, index }) => (
        <View style={horizontal ? { width: itemWidth } : { flex: 1 }}>{templates.item(item, index)}</View>
      )}
      ListEmptyComponent={slots.empty ? <View>{slots.empty}</View> : undefined}
      onEndReached={onEndReached ? () => onEndReached() : undefined}
    />
  ),
);

export const Tile = implement(
  TileDef,
  ({ title, subtitle, emoji, image, color, size, onPress, nodeId, a11y }) => {
    const large = size === 'lg';
    const art = image ? (
      <RNImage source={{ uri: image }} style={{ width: large ? 72 : 44, height: large ? 72 : 44 }} />
    ) : emoji ? (
      <RNText style={{ fontSize: large ? 48 : 30 }} importantForAccessibility="no">
        {emoji}
      </RNText>
    ) : null;
    return (
      <Pressable
        testID={nodeId}
        accessibilityRole="button"
        accessibilityLabel={a11y?.label ?? title}
        disabled={!onPress}
        onPress={() => onPress?.()}
        style={{
          flexDirection: large ? 'row' : 'column',
          alignItems: 'center',
          justifyContent: large ? 'space-between' : 'center',
          gap: space.sm,
          minHeight: large ? 120 : 92,
          padding: large ? space.md : space.sm,
          borderRadius: 16,
          backgroundColor: color,
        }}
      >
        {large ? null : art}
        <View style={{ gap: 4, flexShrink: 1 }}>
          <RNText
            style={{
              fontSize: large ? textSize.subtitle : textSize.caption,
              fontWeight: '700',
              color: '#14161a',
              textAlign: large ? 'left' : 'center',
            }}
          >
            {title}
          </RNText>
          {subtitle ? (
            <RNText style={{ fontSize: textSize.caption, color: '#3f3f46' }}>{subtitle}</RNText>
          ) : null}
        </View>
        {large ? art : null}
      </Pressable>
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
    return (
      <View
        testID={nodeId}
        style={{
          width,
          gap: 4,
          padding: space.sm,
          borderRadius: 14,
          borderWidth: 1,
          borderColor: p.border,
          backgroundColor: p.bg,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={name}
          disabled={!onPress}
          onPress={() => onPress?.()}
        >
          <View
            style={{
              aspectRatio: 1,
              borderRadius: 10,
              backgroundColor: color,
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
            }}
          >
            {image ? (
              <RNImage source={{ uri: image }} style={{ width: '100%', height: '100%' }} />
            ) : (
              <RNText style={{ fontSize: 40 }}>{emoji}</RNText>
            )}
          </View>
          {off ? (
            <RNText
              style={{
                position: 'absolute',
                top: 0,
                left: 6,
                backgroundColor: '#2563eb',
                color: '#fff',
                fontSize: 10,
                fontWeight: '700',
                paddingHorizontal: 5,
                paddingVertical: 2,
              }}
            >
              {off}% OFF
            </RNText>
          ) : null}
          {eta !== undefined ? (
            <RNText style={{ fontSize: 10, fontWeight: '700', color: p.muted, marginTop: 4 }}>
              ⏱ {eta} MINS
            </RNText>
          ) : null}
          <RNText
            numberOfLines={2}
            style={{ fontSize: textSize.caption, fontWeight: '600', color: p.text, minHeight: 34 }}
          >
            {name}
          </RNText>
          {unit ? <RNText style={{ fontSize: 12, color: p.muted }}>{unit}</RNText> : null}
        </Pressable>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
          <View>
            <RNText style={{ fontSize: textSize.caption, fontWeight: '700', color: p.text }}>
              {formatPrice(price, currency, locale)}
            </RNText>
            {off ? (
              <RNText style={{ fontSize: 11, color: p.muted, textDecorationLine: 'line-through' }}>
                {formatPrice(mrp!, currency, locale)}
              </RNText>
            ) : null}
          </View>
          {qty > 0 ? (
            <View
              accessibilityLabel={`${qty} in cart`}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: p.success,
                borderRadius: 8,
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove ${name}`}
                onPress={() => onRemove?.()}
                style={{ paddingHorizontal: 9, paddingVertical: 4 }}
              >
                <RNText style={{ color: '#fff', fontWeight: '700' }}>−</RNText>
              </Pressable>
              <RNText style={{ color: '#fff', fontWeight: '700' }}>{qty}</RNText>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Add ${name}`}
                onPress={() => onAdd?.()}
                style={{ paddingHorizontal: 9, paddingVertical: 4 }}
              >
                <RNText style={{ color: '#fff', fontWeight: '700' }}>+</RNText>
              </Pressable>
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Add ${name}`}
              onPress={() => onAdd?.()}
              style={{
                borderWidth: 1,
                borderColor: p.success,
                borderRadius: 8,
                paddingHorizontal: 12,
                paddingVertical: 4,
              }}
            >
              <RNText style={{ color: p.success, fontWeight: '700', fontSize: textSize.caption }}>ADD</RNText>
            </Pressable>
          )}
        </View>
      </View>
    );
  },
);

/** Another Zyrox document, rendered inline with its own state and data. */
export const Section = implement(SectionDef, ({ screen, params, nodeId }) => (
  <View testID={nodeId}>
    <ZyroxScreen
      screen={screen}
      params={params}
      loading={<View style={{ height: 120, borderRadius: 14, backgroundColor: '#f4f5f7' }} />}
      fallback={null}
    />
  </View>
));

export const nativeComponents = [
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
