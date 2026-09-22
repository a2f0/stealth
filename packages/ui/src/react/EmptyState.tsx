import type { ReactNode } from "react";
import type { IconName } from "../icons";
import { cx } from "./cx";
import { Icon } from "./Icon";

export function EmptyState({
  actions,
  children,
  className,
  compact = false,
  icon = "info",
  plain = false,
  title,
}: {
  actions?: ReactNode;
  children?: ReactNode;
  className?: string | undefined;
  compact?: boolean | undefined;
  icon?: IconName | undefined;
  /** Drop the dashed frame, for use inside a card. */
  plain?: boolean | undefined;
  title: ReactNode;
}) {
  return (
    <div
      className={cx(
        "emptyState",
        compact && "emptyStateCompact",
        plain && "emptyStatePlain",
        className,
      )}
    >
      <span className="emptyStateIcon">
        <Icon name={icon} size={22} />
      </span>
      <p className="emptyStateTitle">{title}</p>
      {children && <div className="emptyStateText">{children}</div>}
      {actions && <div className="emptyStateActions">{actions}</div>}
    </div>
  );
}

export function LoadingState({
  className,
  label = "Loading…",
}: {
  className?: string | undefined;
  label?: string | undefined;
}) {
  return (
    <div
      className={cx("emptyState emptyStatePlain emptyStateCompact", className)}
      role="status"
    >
      <span aria-hidden="true" className="spinner textSubtle" />
      <p className="emptyStateText">{label}</p>
    </div>
  );
}
