// shadcn-standard cn() helper. Merges class names, deduplicating Tailwind
// utility conflicts so `cn("p-2", "p-4")` resolves to `p-4`.
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
