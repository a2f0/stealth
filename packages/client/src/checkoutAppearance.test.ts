import { afterAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { readCheckoutAppearance } from "./checkoutAppearance";

const dom = new Window();

afterAll(async () => {
  await dom.happyDOM.close();
});

// happy-dom does not inherit custom properties into computed styles, so the
// tokens sit on the host itself rather than on :root as they do in the app.
const tokens = [
  "--color-surface: #fdfdfb",
  "--color-text: #1c1d19",
  "--color-text-muted: #5a5b53",
  "--color-text-subtle: #686961",
  "--color-border: #e1e0d8",
  "--color-border-strong: #c9c8bf",
  "--color-emphasis: #181916",
  "--color-danger: #b3402c",
  '--font-sans: "Manrope", sans-serif',
  "--radius-md: 8px",
  "--text-md: 15px",
  "--focus-ring: 0 0 0 3px rgba(183, 255, 91, 0.55)",
].join("; ");

function host(style = "", theme = "light") {
  dom.document.body.innerHTML = `<main data-theme="${theme}"><div style='${style}'></div></main>`;
  return dom.document.querySelector("div") as unknown as HTMLElement;
}

describe("checkout appearance", () => {
  it("keeps Stripe's theme when the app styles are missing", () => {
    expect(readCheckoutAppearance(host())).toEqual({ theme: "stripe" });
    expect(readCheckoutAppearance(host("", "dark"))).toEqual({
      theme: "night",
    });
  });

  it("maps theme tokens to concrete Stripe values", () => {
    const element = host(tokens);
    const appearance = readCheckoutAppearance(element);
    expect(appearance).toEqual({
      rules: {
        ".Input": { border: "1px solid #c9c8bf", boxShadow: "none" },
        ".Input--invalid": { borderColor: "#b3402c" },
        ".Input:focus": {
          borderColor: "#181916",
          boxShadow: "0 0 0 3px rgba(183, 255, 91, 0.55)",
        },
        ".Input:hover": { borderColor: "#686961" },
        ".Label": { color: "#1c1d19", fontWeight: "600" },
        ".Tab": { border: "1px solid #e1e0d8", boxShadow: "none" },
        ".Tab--selected": {
          borderColor: "#181916",
          boxShadow: "0 0 0 1px #181916",
        },
        ".Tab:hover": { borderColor: "#686961" },
      },
      theme: "stripe",
      variables: {
        borderRadius: "8px",
        colorBackground: "#fdfdfb",
        colorDanger: "#b3402c",
        colorPrimary: "#181916",
        colorText: "#1c1d19",
        colorTextPlaceholder: "#686961",
        colorTextSecondary: "#5a5b53",
        focusBoxShadow: "0 0 0 3px rgba(183, 255, 91, 0.55)",
        fontFamily: '"Manrope", sans-serif',
        fontSizeBase: "15px",
      },
    });
    expect(element.children).toHaveLength(0);
  });

  it("uses Stripe's night theme inside a dark region", () => {
    expect(readCheckoutAppearance(host(tokens, "dark")).theme).toBe("night");
  });
});
