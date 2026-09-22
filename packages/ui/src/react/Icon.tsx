import { createElement, type SVGProps } from "react";
import { type IconName, icons } from "../icons";
import { cx } from "./cx";

interface IconProps extends Omit<SVGProps<SVGSVGElement>, "children" | "name"> {
  /** Accessible name; omit for decorative icons. */
  label?: string | undefined;
  name: IconName;
  size?: number | undefined;
}

export function Icon({
  className,
  label,
  name,
  size = 18,
  strokeWidth = 1.75,
  ...rest
}: IconProps) {
  return (
    <svg
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={cx("icon", className)}
      fill="none"
      focusable="false"
      height={size}
      role={label ? "img" : undefined}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
      viewBox="0 0 24 24"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      {icons[name].map(([tag, attributes]) =>
        createElement(tag, {
          ...attributes,
          key: JSON.stringify(attributes),
        }),
      )}
    </svg>
  );
}
