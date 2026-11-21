import * as React from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/shadcn/utils';

/**
 * Viventium's button look on the base's `Button` (CP-CMP-049): a pill with small, bold,
 * wide-spaced capitals. Use it for actions on the call screen; variants and sizes are the base's.
 */
export function CallButton({ className, ...props }: React.ComponentProps<typeof Button>) {
  return (
    <Button
      className={cn('rounded-full text-xs font-bold tracking-wider uppercase', className)}
      {...props}
    />
  );
}
