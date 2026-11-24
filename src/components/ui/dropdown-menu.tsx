'use client';
import * as React from 'react';
import * as DM from '@radix-ui/react-dropdown-menu';
import { cn } from '@/lib/utils';

export const DropdownMenu = DM.Root;
export const DropdownMenuTrigger = DM.Trigger;
export function DropdownMenuContent({ className, sideOffset = 4, ...props }: React.ComponentPropsWithoutRef<typeof DM.Content>) {
  return (
    <DM.Portal>
      <DM.Content
        sideOffset={sideOffset}
        className={cn('z-50 min-w-[10rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md', className)}
        {...props}
      />
    </DM.Portal>
  );
}
export function DropdownMenuItem({ className, ...props }: React.ComponentPropsWithoutRef<typeof DM.Item>) {
  return (
    <DM.Item
      className={cn('relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50', className)}
      {...props}
    />
  );
}
export const DropdownMenuLabel = ({ className, ...p }: React.ComponentPropsWithoutRef<typeof DM.Label>) => (
  <DM.Label className={cn('px-2 py-1.5 text-xs font-semibold text-muted-foreground', className)} {...p} />
);
export const DropdownMenuSeparator = ({ className, ...p }: React.ComponentPropsWithoutRef<typeof DM.Separator>) => (
  <DM.Separator className={cn('-mx-1 my-1 h-px bg-muted', className)} {...p} />
);
export function DropdownMenuCheckboxItem({ className, children, ...props }: React.ComponentPropsWithoutRef<typeof DM.CheckboxItem>) {
  return (
    <DM.CheckboxItem className={cn('relative flex cursor-default select-none items-center gap-2 rounded-sm py-1.5 pe-2 ps-7 text-sm outline-none focus:bg-accent', className)} {...props}>
      <span className="absolute start-2 flex size-3.5 items-center justify-center">
        <DM.ItemIndicator>✓</DM.ItemIndicator>
      </span>
      {children}
    </DM.CheckboxItem>
  );
}
