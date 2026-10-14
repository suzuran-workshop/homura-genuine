import * as React from 'react'

import { cn } from '@/lib/utils'

/** 提示框：default / destructive 两种变体，图标靠 has-[>svg] 自适应排版 */
function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & { variant?: 'default' | 'destructive' }) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(
        'relative w-full rounded-lg border px-4 py-3 text-sm grid has-[>svg]:grid-cols-[calc(var(--spacing)*5)_1fr] grid-cols-[0_1fr] has-[>svg]:gap-x-3 gap-y-2 items-start [&>svg]:size-5 [&>svg]:translate-y-1 [&>svg]:text-current',
        variant === 'destructive' &&
          'text-destructive bg-card *:data-[slot=alert-description]:text-destructive/90',
        className,
      )}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-title"
      className={cn('col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight', className)}
      {...props}
    />
  )
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        'text-muted-foreground col-start-2 grid justify-items-start gap-1 text-sm [&_p]:leading-relaxed',
        className,
      )}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription }
