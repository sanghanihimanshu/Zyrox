import type { MotionAdapter, MotionItemProps } from '@wishyor/zyrox-react';
import { useEffect, useRef, useState } from 'react';
import { Animated } from 'react-native';

const DURATION = 200;
const presets = ['fade', 'slideUp', 'scale'] as const;

/** Example adapter built on React Native's Animated. Swap for Reanimated layout animations. */
function Item({ motion, visible, children }: MotionItemProps) {
  const progress = useRef(new Animated.Value(visible ? 0 : 1)).current;
  const [rendered, setRendered] = useState(visible);
  const [kept, setKept] = useState(children);
  useEffect(() => {
    if (visible) {
      setKept(children);
      setRendered(true);
      Animated.timing(progress, { toValue: 1, duration: DURATION, useNativeDriver: true }).start();
    } else {
      Animated.timing(progress, {
        toValue: 0,
        duration: motion.exit ? DURATION : 0,
        useNativeDriver: true,
      }).start(() => setRendered(false));
    }
  }, [visible, children, motion.exit, progress]);
  if (!rendered) return null;
  const preset = (visible ? motion.enter : motion.exit) ?? 'fade';
  const transform =
    preset === 'slideUp'
      ? [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }]
      : preset === 'scale'
        ? [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.95, 1] }) }]
        : [];
  return <Animated.View style={{ opacity: progress, transform }}>{visible ? children : kept}</Animated.View>;
}

export const nativeMotion: MotionAdapter = { presets, Item };
