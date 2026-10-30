import { ChevronLeft, ChevronRight } from 'lucide-react';
import { DayPicker, type DayPickerProps } from 'react-day-picker';
import { cn } from '@/lib/cn';

const navBtn = 'inline-flex items-center justify-center h-7 w-7 rounded-md border border-nb-gray-200 dark:border-nb-gray-700 bg-transparent text-nb-gray-600 dark:text-nb-gray-300 opacity-60 hover:opacity-100';

// Port of NetBird's Calendar (styled react-day-picker v9).
export function Calendar({ className, classNames, showOutsideDays = true, ...props }: DayPickerProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn('p-3', className)}
      classNames={{
        months: 'flex flex-col sm:flex-row gap-4 relative',
        month: 'space-y-4 sm:pr-4 last:pr-0',
        month_caption: 'flex justify-center pt-1 relative items-center',
        caption_label: 'text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100',
        nav: 'space-x-1 flex items-center',
        button_previous: cn(navBtn, 'absolute left-1 top-1 z-10'),
        button_next: cn(navBtn, 'absolute right-1 top-1 z-10'),
        month_grid: 'w-full border-collapse space-y-1',
        weekdays: 'flex',
        weekday: 'text-nb-gray-500 dark:text-nb-gray-400 rounded-md w-9 font-normal text-[0.8rem]',
        week: 'flex w-full mt-2',
        day: 'h-9 w-9 text-center text-sm p-0 relative text-nb-gray-700 dark:text-nb-gray-200 has-aria-[selected]:bg-netbird/10 first:has-aria-[selected]:rounded-l-md last:has-aria-[selected]:rounded-r-md focus-within:relative focus-within:z-20',
        day_button: 'h-9 w-9 p-0 font-normal rounded-md hover:bg-nb-gray-100 dark:hover:bg-nb-gray-800 aria-selected:opacity-100',
        range_end: 'day-range-end rounded-r-md',
        range_start: 'day-range-start rounded-l-md',
        selected: 'bg-netbird text-white hover:bg-netbird hover:text-white focus:bg-netbird focus:text-white rounded-md',
        today: 'text-netbird font-semibold',
        outside: 'day-outside text-nb-gray-400 opacity-50',
        disabled: 'text-nb-gray-400 opacity-50',
        range_middle: 'aria-selected:bg-netbird/10 aria-selected:text-nb-gray-800 dark:aria-selected:text-nb-gray-100 rounded-none',
        hidden: 'invisible',
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) => (orientation === 'left' ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />),
      }}
      {...props}
    />
  );
}
