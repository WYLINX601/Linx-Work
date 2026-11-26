import { cn } from "../../lib/utils";
import { LinxMark, type LinxMarkTone } from "./LinxMark";
import { LinxWordmark } from "./LinxWordmark";

export type LinxLockupProps = {
  /** Mark size in pixels; also selects the gap between mark and wordmark. */
  readonly size?: number;
  readonly tone?: LinxMarkTone;
  readonly className?: string;
  readonly wordmarkClassName?: string;
};

export function LinxLockup({
  size = 20,
  tone = "auto",
  className,
  wordmarkClassName,
}: LinxLockupProps) {
  return (
    <span
      className={cn("inline-flex min-w-0 items-center", size < 24 ? "gap-1.5" : "gap-2", className)}
    >
      <LinxMark decorative size={size} tone={tone} />
      <LinxWordmark className={cn("min-w-0 truncate", wordmarkClassName)} />
    </span>
  );
}
