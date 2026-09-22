import type { ReactNode } from "react";
import { cx } from "./cx";

/** A labelled control. The label wraps its control, so no id is needed. */
export function Field({
  children,
  className,
  hint,
  label,
  optional = false,
}: {
  children: ReactNode;
  className?: string | undefined;
  hint?: ReactNode;
  label: ReactNode;
  optional?: boolean | undefined;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: callers pass the control as children.
    <label className={cx("field", className)}>
      <span className="fieldLabel">
        {label}
        {optional && (
          <>
            {" "}
            <span className="fieldOptional">Optional</span>
          </>
        )}
      </span>
      {children}
      {hint && <span className="fieldHint">{hint}</span>}
    </label>
  );
}
