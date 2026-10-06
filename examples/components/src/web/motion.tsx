import type { MotionAdapter, MotionItemProps } from '@zyrox/react';
import { useEffect, useState } from 'react';

const presets: Record<string, { from: React.CSSProperties; to: React.CSSProperties }> = {
  fade: { from: { opacity: 0 }, to: { opacity: 1 } },
  slideUp: { from: { opacity: 0, transform: 'translateY(12px)' }, to: { opacity: 1, transform: 'none' } },
  scale: { from: { opacity: 0, transform: 'scale(0.95)' }, to: { opacity: 1, transform: 'none' } },
};

const DURATION = 200;

/** Example CSS-transition adapter. Swap for Framer Motion, React Spring… */
function Item({ motion, visible, children }: MotionItemProps) {
  const [rendered, setRendered] = useState(visible);
  const [shown, setShown] = useState(false);
  const [kept, setKept] = useState(children);
  useEffect(() => {
    if (visible) {
      setKept(children);
      setRendered(true);
      const id = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(id);
    }
    setShown(false);
    const id = setTimeout(() => setRendered(false), motion.exit ? DURATION : 0);
    return () => clearTimeout(id);
  }, [visible, children, motion.exit]);
  if (!rendered) return null;
  const preset =
    presets[(shown ? motion.enter : motion.exit) ?? ''] ?? presets[motion.enter ?? ''] ?? presets.fade!;
  return (
    <div style={{ transition: `all ${DURATION}ms ease`, ...(shown ? preset.to : preset.from) }}>
      {visible ? children : kept}
    </div>
  );
}

export const webMotion: MotionAdapter = { presets: Object.keys(presets), Item };
