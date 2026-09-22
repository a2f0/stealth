import type { ReactNode } from "react";
import { cx } from "./cx";

export type BadgeTone =
  | "accent"
  | "danger"
  | "info"
  | "neutral"
  | "success"
  | "warning";

const toneClass: Record<BadgeTone, string | undefined> = {
  accent: "badgeAccent",
  danger: "badgeDanger",
  info: "badgeInfo",
  neutral: undefined,
  success: "badgeSuccess",
  warning: "badgeWarning",
};

export function Badge({
  children,
  className,
  dot = false,
  tone = "neutral",
}: {
  children: ReactNode;
  className?: string | undefined;
  dot?: boolean | undefined;
  tone?: BadgeTone | undefined;
}) {
  return (
    <span
      className={cx("badge", toneClass[tone], dot && "badgeDot", className)}
    >
      {children}
    </span>
  );
}
