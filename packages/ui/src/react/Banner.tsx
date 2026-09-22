import type { ReactNode } from "react";
import type { IconName } from "../icons";
import { cx } from "./cx";
import { Icon } from "./Icon";

type BannerTone = "danger" | "info" | "neutral" | "success" | "warning";

const toneStyle: Record<BannerTone, { className?: string; icon: IconName }> = {
  danger: { className: "bannerDanger", icon: "error" },
  info: { icon: "info" },
  neutral: { className: "bannerNeutral", icon: "info" },
  success: { className: "bannerSuccess", icon: "success" },
  warning: { className: "bannerWarning", icon: "alert" },
};

/**
 * Inline feedback. Danger banners are announced assertively and the rest
 * politely; pass `announce={false}` for static notices that are not feedback.
 */
export function Banner({
  actions,
  announce = true,
  children,
  className,
  icon,
  title,
  tone = "info",
}: {
  actions?: ReactNode;
  announce?: boolean | undefined;
  children?: ReactNode;
  className?: string | undefined;
  icon?: IconName | undefined;
  title?: ReactNode;
  tone?: BannerTone | undefined;
}) {
  const style = toneStyle[tone];
  const role = tone === "danger" ? "alert" : "status";
  return (
    <div
      className={cx("banner", style.className, className)}
      role={announce ? role : undefined}
    >
      <Icon name={icon ?? style.icon} size={18} />
      <div className="bannerBody">
        {title && <p className="bannerTitle">{title}</p>}
        {children && <div>{children}</div>}
      </div>
      {actions && <div className="bannerActions">{actions}</div>}
    </div>
  );
}
