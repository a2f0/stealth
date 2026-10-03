import type { ComponentProps } from "react";
import { Banner } from "./Banner";
import { cx } from "./cx";

/** Floating feedback that stays at the bottom of the viewport without moving content. */
export function Toast({ className, ...props }: ComponentProps<typeof Banner>) {
  return <Banner {...props} className={cx("toast", className)} />;
}
