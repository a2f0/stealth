import { type FormEventHandler, type ReactNode, useContext } from "react";
import { cx } from "./cx";
import { InsideSection } from "./sectionContext";

interface CardProps {
  actions?: ReactNode;
  children?: ReactNode;
  className?: string | undefined;
  description?: ReactNode;
  /** Render children edge to edge, for row lists and tables. */
  flush?: boolean | undefined;
  footer?: ReactNode;
  /** Render the card as a form so footer buttons can submit it. */
  onSubmit?: FormEventHandler<HTMLFormElement> | undefined;
  title?: ReactNode;
}

export function Card({
  actions,
  children,
  className,
  description,
  flush = false,
  footer,
  onSubmit,
  title,
}: CardProps) {
  const Title = useContext(InsideSection) ? "h3" : "h2";
  const content = (
    <>
      {(title || actions) && (
        <header className="cardHeader">
          <div className="cardHeading">
            {title && <Title className="cardTitle">{title}</Title>}
            {description && <p className="cardDescription">{description}</p>}
          </div>
          {actions && <div className="cardActions">{actions}</div>}
        </header>
      )}
      {children !== undefined && children !== null && children !== false && (
        <div className={flush ? "cardFlush" : "cardBody"}>{children}</div>
      )}
      {footer && <div className="cardFooter">{footer}</div>}
    </>
  );
  if (onSubmit) {
    return (
      <form className={cx("card", className)} onSubmit={onSubmit}>
        {content}
      </form>
    );
  }
  return <section className={cx("card", className)}>{content}</section>;
}
