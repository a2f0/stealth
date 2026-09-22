import { productName } from "../brand";
import { cx } from "./cx";

export function Logo({ className }: { className?: string | undefined }) {
  return (
    <span className={cx("brand", className)}>
      <span aria-hidden="true" className="brandMark">
        T
      </span>
      <span>{productName}</span>
    </span>
  );
}

export function Avatar({
  className,
  name,
  size = "md",
}: {
  className?: string | undefined;
  name: string;
  size?: "lg" | "md" | "sm" | undefined;
}) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "avatar",
        size === "sm" && "avatarSm",
        size === "lg" && "avatarLg",
        className,
      )}
    >
      {initialsFor(name)}
    </span>
  );
}

export function initialsFor(name: string) {
  const words = name
    .trim()
    .split(/[\s@._-]+/)
    .filter(Boolean);
  const initials = words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
  return initials || "?";
}
