import { useEffect, useState } from 'react';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils.js';

const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
function Spinner({ className, ...props }: ComponentProps<'span'>) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const timer = window.setInterval(() => { if (!document.hidden && !media.matches) setFrame(value => (value + 1) % frames.length); }, 100);
    return () => window.clearInterval(timer);
  }, []);
  return <span aria-hidden="true" data-slot="spinner" className={cn('braille-spinner', className)} {...props}>{frames[frame]}</span>;
}

export { Spinner }
