import Image from "next/image";
import { cn } from "@/lib/utils";

export const BRAND_NAME = "Teddy³ CRM";
export const BRAND_TAGLINE = "Not readymade. It's Teddymade.";

interface TeddyMarkProps {
  /** Rendered width/height in px. */
  size?: number;
  className?: string;
  /** Pass true above the fold (auth pages) so the mark isn't lazy-loaded. */
  priority?: boolean;
}

/** The round Teddy³ bear emblem. Decorative: pair it with visible text. */
export function TeddyMark({ size = 32, className, priority = false }: TeddyMarkProps) {
  return (
    <Image
      src="/brand/teddy-mark.png"
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      priority={priority}
      className={cn("shrink-0 rounded-full", className)}
    />
  );
}

interface TeddyWordmarkProps {
  className?: string;
}

/** "Teddy³ CRM" set in the brand's bold weight. */
export function TeddyWordmark({ className }: TeddyWordmarkProps) {
  return (
    <span className={cn("font-extrabold tracking-tight text-foreground", className)}>
      Teddy<sup className="text-[0.6em] font-bold">3</sup>
      <span className="ml-1 font-semibold text-muted-foreground">CRM</span>
    </span>
  );
}
