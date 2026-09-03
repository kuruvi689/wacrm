'use client';

import { cn } from '@/lib/utils';

const sizes = {
  sm: 'h-6 w-6 text-[10px]',
  md: 'h-8 w-8 text-xs',
  lg: 'h-12 w-12 text-base',
} as const;

export function BrandMark({ size = 'md', className }: { size?: keyof typeof sizes; className?: string }) {
  return (
    <div className={cn(
      'flex items-center justify-center rounded-lg bg-primary font-bold text-primary-foreground',
      sizes[size],
      className,
    )}>
      {/* Crown + R SVG */}
      <svg viewBox="0 0 32 32" fill="currentColor" className="h-[70%] w-[70%]">
        {/* Crown */}
        <path d="M8 10l4-4 4 3 4-3 4 4v2H8v-2z" opacity="0.9" />
        {/* R letter */}
        <path d="M11 14h6c2.2 0 4 1.3 4 3s-1.8 3-4 3l4 6h-3.5l-3.5-5.5V26h-3V14zm3 2.5v3h3c1.1 0 1.5-.6 1.5-1.5s-.4-1.5-1.5-1.5h-3z" />
      </svg>
    </div>
  );
}
