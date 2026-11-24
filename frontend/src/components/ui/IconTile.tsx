import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

// Brand is a shade darker than the Remote Access tile, so a white icon keeps at least 3:1 contrast.
type IconTileTone = 'brand' | 'neutral';

export const ICON_TILE_TONE: Record<IconTileTone, string> = {
  brand: 'bg-linear-to-br from-netbird-600 to-netbird-700 text-white shadow-[0_6px_16px_-6px_rgba(229,83,17,0.65)]',
  neutral: 'bg-nb-gray-100 text-nb-gray-600 dark:bg-nb-gray-800/70 dark:text-nb-gray-200',
};

export const ICON_TILE_BOX = 'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl';

export function IconTile({ icon, tone = 'brand', className }: { icon: ReactNode; tone?: IconTileTone; className?: string }) {
  return <div aria-hidden className={cn(ICON_TILE_BOX, ICON_TILE_TONE[tone], className)}>{icon}</div>;
}
