import { type ReactNode, useEffect, useRef } from 'react';
import {
  Animated,
  Image,
  Modal,
  Alert as NativeAlert,
  Pressable,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from 'react-native';
import type { AlertProps, MessageProps, OverlayComponents, SheetProps, ToastsProps } from './overlay-host';
import { type OverlayTheme, type OverlayThemeInput, themeHook } from './overlay-theme';

export type { OverlayComponents, OverlayTheme, OverlayThemeInput };

/**
 * Sheets (Modal + spring), native alerts (`Alert.alert`) and toasts for React Native. Pass the
 * result to `<ZyroxProvider overlays>`, or replace any of them with your own components.
 */
export function createOverlays(theme: OverlayThemeInput = {}): OverlayComponents {
  const useTheme = themeHook(theme);

  const buttonStyle = (t: OverlayTheme, style: string): { box: ViewStyle; text: TextStyle } => ({
    box: {
      paddingVertical: 12,
      paddingHorizontal: 16,
      borderRadius: Math.min(t.radius, 12),
      alignItems: 'center',
      borderWidth: style === 'primary' ? 0 : 1,
      borderColor: t.border,
      backgroundColor: style === 'primary' ? t.primary : 'transparent',
    },
    text: {
      fontWeight: '600',
      fontSize: 16,
      color: style === 'primary' ? t.primaryText : style === 'destructive' ? t.danger : t.text,
    },
  });

  function Sheet({ title, size, dismissible, onDismiss, children }: SheetProps): ReactNode {
    const t = useTheme();
    const progress = useRef(new Animated.Value(0)).current;
    useEffect(() => {
      Animated.spring(progress, { toValue: 1, useNativeDriver: true, bounciness: 0, speed: 14 }).start();
    }, [progress]);
    const close = dismissible ? onDismiss : undefined;
    return (
      <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={() => close?.()}>
        <View style={{ flex: 1, justifyContent: 'flex-end' }}>
          <Animated.View
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: progress }}
          >
            <Pressable
              accessibilityLabel="Close"
              onPress={close}
              style={{ flex: 1, backgroundColor: t.backdrop }}
            />
          </Animated.View>
          <Animated.View
            accessibilityViewIsModal
            accessibilityLabel={title}
            style={{
              maxHeight: '92%',
              height: size === 'half' ? '50%' : size === 'full' ? '92%' : undefined,
              backgroundColor: t.background,
              borderTopLeftRadius: t.radius,
              borderTopRightRadius: t.radius,
              padding: 16,
              paddingBottom: 32,
              transform: [
                { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [600, 0] }) },
              ],
            }}
          >
            {title || dismissible ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                <Text
                  style={{
                    flex: 1,
                    fontSize: 17,
                    fontWeight: '700',
                    color: t.text,
                    fontFamily: t.fontFamily,
                  }}
                >
                  {title}
                </Text>
                {dismissible ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Close"
                    onPress={onDismiss}
                    hitSlop={12}
                  >
                    <Text style={{ fontSize: 18, color: t.muted }}>✕</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
            {children}
          </Animated.View>
        </View>
      </Modal>
    );
  }

  /** The platform's own dialog. */
  function Alert({ title, message, buttons, onPress, onDismiss }: AlertProps): ReactNode {
    const latest = useRef({ onPress, onDismiss });
    latest.current = { onPress, onDismiss };
    // biome-ignore lint/correctness/useExhaustiveDependencies: shown once per alert (keyed)
    useEffect(() => {
      NativeAlert.alert(
        title,
        message,
        buttons.map((button, i) => ({
          text: button.label,
          style:
            button.style === 'destructive' ? 'destructive' : button.style === 'cancel' ? 'cancel' : 'default',
          onPress: () => latest.current.onPress(i),
        })),
        { cancelable: true, onDismiss: () => latest.current.onDismiss() },
      );
    }, []);
    return null;
  }

  function Toast({
    toast,
    onPress,
    onDismiss,
  }: {
    toast: ToastsProps['toasts'][number];
    onPress(): void;
    onDismiss(): void;
  }): ReactNode {
    const t = useTheme();
    const opacity = useRef(new Animated.Value(0)).current;
    useEffect(() => {
      Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    }, [opacity]);
    return (
      <Animated.View
        accessibilityLiveRegion="polite"
        accessibilityRole="alert"
        style={{
          opacity,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          maxWidth: '92%',
          paddingVertical: 10,
          paddingHorizontal: 14,
          borderRadius: Math.min(t.radius, 12),
          backgroundColor: t.tones[toast.tone],
        }}
      >
        <Pressable onPress={onDismiss} style={{ flexShrink: 1 }}>
          <Text style={{ color: '#fff', fontSize: 15, fontFamily: t.fontFamily }}>{toast.message}</Text>
        </Pressable>
        {toast.action ? (
          <Pressable accessibilityRole="button" onPress={onPress} hitSlop={8}>
            <Text style={{ color: '#fff', fontWeight: '700', textDecorationLine: 'underline' }}>
              {toast.action.label}
            </Text>
          </Pressable>
        ) : null}
      </Animated.View>
    );
  }

  function Toasts({ toasts, onPress, onDismiss }: ToastsProps): ReactNode {
    return (
      <View
        pointerEvents="box-none"
        style={{ position: 'absolute', left: 0, right: 0, bottom: 48, alignItems: 'center', gap: 8 }}
      >
        {toasts.map((toast) => (
          <Toast
            key={toast.key}
            toast={toast}
            onPress={() => onPress(toast.key)}
            onDismiss={() => onDismiss(toast.key)}
          />
        ))}
      </View>
    );
  }

  function Message({ title, message, image, buttons, onPress }: MessageProps): ReactNode {
    const t = useTheme();
    return (
      <View style={{ gap: 12 }}>
        {image ? (
          <Image
            source={{ uri: image }}
            accessibilityIgnoresInvertColors
            style={{ width: '100%', height: 180, borderRadius: 12 }}
          />
        ) : null}
        {title ? (
          <Text style={{ fontSize: 20, fontWeight: '700', textAlign: 'center', color: t.text }}>{title}</Text>
        ) : null}
        {message ? (
          <Text style={{ fontSize: 15, textAlign: 'center', color: t.muted }}>{message}</Text>
        ) : null}
        {buttons.map((button, i) => {
          const s = buttonStyle(t, button.style);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: buttons are static per sheet
            <Pressable key={i} accessibilityRole="button" onPress={() => onPress(i)} style={s.box}>
              <Text style={s.text}>{button.label}</Text>
            </Pressable>
          );
        })}
      </View>
    );
  }

  return { Sheet, Alert, Toasts, Message };
}

export const defaultOverlays: OverlayComponents = createOverlays();
