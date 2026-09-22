import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ReactNode,
} from "react";
import type { IconName } from "../icons";
import { cx } from "./cx";
import { Icon } from "./Icon";

type ButtonVariant =
  | "accent"
  | "danger"
  | "ghost"
  | "link"
  | "primary"
  | "secondary";
type ButtonSize = "lg" | "md" | "sm";

interface ButtonStyle {
  block?: boolean | undefined;
  className?: string | undefined;
  iconOnly?: boolean | undefined;
  size?: ButtonSize | undefined;
  variant?: ButtonVariant | undefined;
}

const variantClass: Record<ButtonVariant, string | undefined> = {
  accent: "buttonAccent",
  danger: "buttonDanger",
  ghost: "buttonGhost",
  link: "buttonLink",
  primary: "buttonPrimary",
  secondary: undefined,
};

const sizeClass: Record<ButtonSize, string | undefined> = {
  lg: "buttonLg",
  md: undefined,
  sm: "buttonSm",
};

/** Class list for elements that look like buttons but are not <button>. */
export function buttonClass({
  block,
  className,
  iconOnly,
  size = "md",
  variant = "secondary",
}: ButtonStyle = {}) {
  return cx(
    "button",
    variantClass[variant],
    sizeClass[size],
    block && "buttonBlock",
    iconOnly && "buttonIconOnly",
    className,
  );
}

interface ButtonContentProps {
  busy?: boolean | undefined;
  icon?: IconName | undefined;
  iconEnd?: IconName | undefined;
}

type ButtonProps = ButtonContentProps &
  ButtonStyle &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className">;

export function Button({
  block,
  busy = false,
  children,
  className,
  disabled,
  icon,
  iconEnd,
  iconOnly,
  size,
  type = "button",
  variant,
  ...rest
}: ButtonProps) {
  return (
    <button
      aria-busy={busy || undefined}
      className={buttonClass({ block, className, iconOnly, size, variant })}
      disabled={disabled || busy}
      type={type}
      {...rest}
    >
      <ButtonContent busy={busy} icon={icon} iconEnd={iconEnd} size={size}>
        {children}
      </ButtonContent>
    </button>
  );
}

type ButtonLinkProps = ButtonContentProps &
  ButtonStyle &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className">;

export function ButtonLink({
  block,
  children,
  className,
  icon,
  iconEnd,
  iconOnly,
  size,
  variant,
  ...rest
}: ButtonLinkProps) {
  return (
    <a
      className={buttonClass({ block, className, iconOnly, size, variant })}
      {...rest}
    >
      <ButtonContent icon={icon} iconEnd={iconEnd} size={size}>
        {children}
      </ButtonContent>
    </a>
  );
}

function ButtonContent({
  busy,
  children,
  icon,
  iconEnd,
  size,
}: ButtonContentProps & {
  children: ReactNode;
  size: ButtonSize | undefined;
}) {
  const iconSize = size === "sm" ? 16 : 18;
  return (
    <>
      {busy ? (
        <span aria-hidden="true" className="spinner" />
      ) : (
        icon && <Icon name={icon} size={iconSize} />
      )}
      {children}
      {iconEnd && <Icon name={iconEnd} size={iconSize} />}
    </>
  );
}
