import { useEffect, useState } from 'react';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils.js';

const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
function Spinner({ className, ...props }: ComponentProps<'span'>) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    let timer: number | undefined;
    const sync = () => {
      window.clearInterval(timer);
      if (!document.hidden && !media.matches) timer = window.setInterval(() => setFrame(value => (value + 1) % frames.length), 90);
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    media.addEventListener('change', sync);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', sync); media.removeEventListener('change', sync); };
  }, []);
  return <span aria-hidden="true" data-slot="spinner" className={cn('braille-spinner', className)} {...props}>{frames[frame]}</span>;
}

export { Spinner }
