import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'md' | 'sm';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const base =
  'relative inline-flex items-center justify-center gap-2 font-medium whitespace-nowrap rounded-md border ' +
  'transition-colors focus:outline-hidden focus:ring-2 focus:ring-offset-1 dark:ring-offset-nb-gray-950/50 ' +
  'disabled:opacity-40 disabled:cursor-not-allowed';

const variants: Record<Variant, string> = {
  primary:
    'border-transparent bg-netbird text-white hover:bg-netbird-500 focus:ring-netbird-400/50 ' +
    'dark:bg-netbird dark:text-white dark:hover:bg-netbird-500/80 shadow-xs',
  secondary:
    'shadow-xs bg-white text-nb-gray-900 border-nb-gray-200 hover:bg-nb-gray-100 focus:ring-nb-gray-300/50 ' +
    'dark:bg-nb-gray-920 dark:text-nb-gray-400 dark:border-nb-gray-700/40 dark:hover:text-white dark:hover:bg-nb-gray-910 dark:focus:ring-nb-gray-500/20',
  danger:
    'border-transparent bg-red-600 text-white hover:bg-red-500 focus:ring-red-400/50 shadow-xs',
  ghost:
    'border-transparent bg-transparent text-nb-gray-500 hover:bg-nb-gray-200/60 hover:text-nb-gray-900 ' +
    'dark:text-nb-gray-400 dark:hover:bg-nb-gray-900/40 dark:hover:text-white focus:ring-nb-gray-500/20',
};

const sizes: Record<Size, string> = {
  md: 'text-sm py-2.5 px-4 h-[42px]',
  sm: 'text-xs py-2 px-3 h-[34px]',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'secondary', size = 'md', className, type = 'button', ...rest }, ref) => (
    <button ref={ref} type={type} className={cn(base, variants[variant], sizes[size], className)} {...rest} />
  ),
);
Button.displayName = 'Button';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  size?: number;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, type = 'button', ...rest }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex items-center justify-center h-8 w-8 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 ',
        'text-nb-gray-500 dark:text-nb-gray-400 hover:text-nb-gray-900 dark:hover:text-nb-gray-100 ',
        'hover:bg-nb-gray-100 dark:hover:bg-nb-gray-900 transition-colors focus:outline-hidden',
        className,
      )}
      {...rest}
    />
  ),
);
IconButton.displayName = 'IconButton';
