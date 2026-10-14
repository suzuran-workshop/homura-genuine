import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** shadcn/ui 标准 cn：合并 class 并去冲突（tailwind-merge） */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
