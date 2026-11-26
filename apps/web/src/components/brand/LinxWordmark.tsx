import { cn } from "../../lib/utils";

export type LinxWordmarkProps = {
  readonly className?: string;
};

/**
 * Typeset wordmark: `Linx` in the inherited text color, plus a brand-amber
 * period. The period uses `--linx-accent` rather than `--primary` so it keeps
 * the brand color in every theme.
 */
export function LinxWordmark({ className }: LinxWordmarkProps) {
  return (
    <span className={cn("inline-flex items-baseline font-bold tracking-tight", className)}>
      {/* oxlint-disable-next-line t3code/no-untranslated-copy -- brand wordmark, never translated */}
      Linx
      <span aria-hidden="true" className="text-linx-accent">
        .
      </span>
    </span>
  );
}
