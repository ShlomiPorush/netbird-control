import { useState } from 'react';
import { Globe } from 'lucide-react';
import { cn } from '@/lib/cn';

// 2-letter ISO country code → a small flag image (falls back to a globe glyph when the code
// is unknown or the image is missing). Shared by the Peers and IP History tables.
export function FlagIcon({ cc, className }: { cc?: string; className?: string }) {
  const [err, setErr] = useState(false);
  const code = (cc || '').toLowerCase();
  if (!err && /^[a-z]{2}$/.test(code)) {
    return (
      <img
        src={`/images/flags/16x12/${code}.png`}
        alt={code.toUpperCase()}
        width={16}
        height={12}
        loading="lazy"
        onError={() => setErr(true)}
        className={cn('inline-block rounded-[2px] object-cover shadow-sm', className)}
      />
    );
  }
  return <Globe size={14} className={cn('text-nb-gray-400', className)} />;
}
