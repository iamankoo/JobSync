import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost";

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60";
const VARIANTS: Record<ButtonVariant, string> = {
  // Uses the signed-in member's accent colour (see [data-member] in globals.css).
  primary: "bg-accent-strong text-on-accent hover:brightness-110",
  secondary: "border border-line bg-navy-900 text-ink hover:border-electric-soft hover:bg-navy-800",
  ghost: "text-muted hover:bg-navy-800 hover:text-ink",
};

/** Class names so links can look like buttons. */
export function buttonClass(variant: ButtonVariant = "secondary", extra = ""): string {
  return `${BASE} ${VARIANTS[variant]} ${extra}`.trim();
}

export function Button({
  variant = "secondary",
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <button type={type} className={buttonClass(variant, className)} {...props} />;
}
