import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

const fieldColors =
  'rounded-md border px-3 text-sm outline-hidden transition-colors ' +
  'bg-white border-nb-gray-200 text-nb-gray-900 placeholder:text-nb-gray-500 ' +
  'dark:bg-nb-gray-900 dark:border-nb-gray-700 dark:text-nb-gray-100 dark:placeholder:text-nb-gray-400/70 ' +
  'focus:ring-2 focus:ring-netbird-400/30 focus:border-netbird/60';
const fieldBase = `h-[42px] ${fieldColors}`;

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...rest }, ref) => <input ref={ref} className={cn(fieldBase, className)} autoComplete="off" {...rest} />,
);
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...rest }, ref) => <textarea ref={ref} className={cn(fieldColors, 'min-h-[84px] py-2.5 leading-relaxed resize-y', className)} {...rest} />,
);
Textarea.displayName = 'Textarea';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...rest }, ref) => (
    <select ref={ref} className={cn(fieldBase, 'cursor-pointer', className)} {...rest}>
      {children}
    </select>
  ),
);
Select.displayName = 'Select';

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('text-[0.8rem] font-semibold text-nb-gray-600 dark:text-nb-gray-400', className)}>{children}</span>;
}

export function FieldHint({ children }: { children: ReactNode }) {
  return <span className="text-[0.72rem] text-nb-gray-500 dark:text-nb-gray-500">{children}</span>;
}

/** A labelled form field (label + control + optional hint), stacked.
 *
 *  Deliberately a <div>, NOT a <label>: a label forwards any click inside it to its first
 *  labelable descendant (a <button>/<input>). With more than one control in a Field - e.g.
 *  a SelectMenu button followed by a div-based multi-select - clicking the second control
 *  ALSO synthetically clicked the first, popping its dropdown over the one you clicked. */
export function Field({ label, hint, children, className }: { label?: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && <Label>{label}</Label>}
      {children}
      {hint && <FieldHint>{hint}</FieldHint>}
    </div>
  );
}

export function Checkbox({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="checkbox"
      className={cn('h-4 w-4 rounded-sm border-nb-gray-300 dark:border-nb-gray-700 text-netbird accent-netbird focus:ring-netbird/40', className)}
      {...rest}
    />
  );
}
