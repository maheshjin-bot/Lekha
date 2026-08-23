import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind class lists, letting a later conflicting class win. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
