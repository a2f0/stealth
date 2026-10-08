import type { Appearance } from "@stripe/stripe-js";

/**
 * Maps the app's theme tokens onto Stripe's Appearance API for the inline
 * Payment Element.
 *
 * The element renders in a cross-origin iframe that cannot read this
 * document's custom properties, so every value must arrive concrete. Color,
 * font, and radius tokens are literal values and are read straight from
 * `host`. The text size (`rem`) and focus ring (modern `rgb()` syntax) are
 * applied to a hidden probe and read back computed, as `px` and legacy
 * `rgba()`, which Stripe parses. Reading through `host` follows the active
 * theme, including a region pinned with `data-theme`.
 */
export function readCheckoutAppearance(host: HTMLElement): Appearance {
  const theme =
    host.closest("[data-theme]")?.getAttribute("data-theme") === "dark"
      ? "night"
      : "stripe";
  const view = host.ownerDocument.defaultView;
  if (!view) return { theme };
  const styles = view.getComputedStyle(host);
  const token = (name: string) => styles.getPropertyValue(name).trim();
  const surface = token("--color-surface");
  // Without the app's styles there is nothing to match; keep Stripe's theme.
  if (!surface) return { theme };

  const probe = host.ownerDocument.createElement("div");
  probe.hidden = true;
  probe.style.fontSize = "var(--text-md)";
  probe.style.boxShadow = "var(--focus-ring)";
  host.append(probe);
  const computed = view.getComputedStyle(probe);
  const fontSize = computed.fontSize;
  const focusRing = computed.boxShadow;
  probe.remove();

  const border = token("--color-border");
  const borderStrong = token("--color-border-strong");
  const danger = token("--color-danger");
  const emphasis = token("--color-emphasis");
  const text = token("--color-text");
  const textSubtle = token("--color-text-subtle");
  return {
    rules: {
      ".Input": { border: `1px solid ${borderStrong}`, boxShadow: "none" },
      ".Input--invalid": { borderColor: danger },
      ".Input:focus": { borderColor: emphasis, boxShadow: focusRing },
      ".Input:hover": { borderColor: textSubtle },
      ".Label": { color: text, fontWeight: "600" },
      ".Tab": { border: `1px solid ${border}`, boxShadow: "none" },
      ".Tab--selected": {
        borderColor: emphasis,
        boxShadow: `0 0 0 1px ${emphasis}`,
      },
      ".Tab:hover": { borderColor: textSubtle },
    },
    theme,
    variables: {
      borderRadius: token("--radius-md"),
      colorBackground: surface,
      colorDanger: danger,
      colorPrimary: emphasis,
      colorText: text,
      colorTextPlaceholder: textSubtle,
      colorTextSecondary: token("--color-text-muted"),
      focusBoxShadow: focusRing,
      fontFamily: token("--font-sans"),
      fontSizeBase: fontSize,
    },
  };
}
