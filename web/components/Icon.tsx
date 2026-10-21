import { Plus, X } from 'lucide-react';
export function Icon({ name, className = '' }: {
    name: 'brand' | 'plus' | 'close' | 'google';
    className?: string;
}) {
    if (name === 'brand')
        return <svg className={className} viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M8 22A16 16 0 0 1 40 22Z" fill="var(--signal)" transform="translate(3 -1.5)"/><path d="M8 26A16 16 0 0 0 40 26Z" fill="currentColor" transform="translate(-3 1.5)"/></svg>;
    if (name === 'google')
        return <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.6 12.2c0-.7-.1-1.5-.2-2.2H12v4h5.4a4.7 4.7 0 0 1-2 3.1 5.9 5.9 0 0 1-3.4 1.1A6.2 6.2 0 1 1 16.4 7l3-2.9A10.4 10.4 0 1 0 12 22.4c6 0 9.6-4.2 9.6-10.2Z"/></svg>;
    const Glyph = name === 'plus' ? Plus : X;
    return <Glyph className={className} strokeWidth={1.7} aria-hidden="true" />;
}
