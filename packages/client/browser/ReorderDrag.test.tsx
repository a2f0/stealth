import { expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, launch } from "puppeteer-core";

// Three tall entries in a 600px viewport. The first is lifted and held at the
// bottom edge, where the page scrolls a frame at a time. Its transform grows
// the page as it follows the pointer, so only the limit taken when the drag
// began keeps the scroll from running on into empty space.
const harness = (hook: string) => `
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { moveEntry, useReorderDrag } from ${JSON.stringify(hook)};

function App() {
  const [entries, setEntries] = useState(["a", "b", "c"]);
  const drag = useReorderDrag(entries, (from, to) =>
    setEntries(moveEntry(entries, from, to)),
  );
  return (
    <div>
      {entries.map((entry, index) => {
        const state = drag.entryState(index);
        return (
          <div
            data-reorder-item=""
            key={entry}
            style={{
              height: 1200,
              position: "relative",
              transform: state.dragging
                ? \`translateY(\${state.offset}px)\`
                : undefined,
            }}
          >
            <button
              {...drag.handleProps(index)}
              id={\`handle-\${entry}\`}
              style={{ touchAction: "none" }}
              type="button"
            >
              {entry}
            </button>
          </div>
        );
      })}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
`;

it("never scrolls past the page while a lifted entry rests at the edge", async () => {
  const { CHROME_PATH } = process.env;
  const chrome =
    CHROME_PATH ||
    Bun.which("google-chrome") ||
    Bun.which("chromium") ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(chrome))
    throw new Error("Chrome is required for the reorder check.");
  // Inside the package, so the fixture resolves React like the app does.
  const fixture = mkdtempSync(
    join(fileURLToPath(new URL(".", import.meta.url)), ".reorder-"),
  );
  const profile = mkdtempSync(join(tmpdir(), "reorder-drag-"));
  let browser: Browser | undefined;
  try {
    const entry = join(fixture, "entry.tsx");
    writeFileSync(
      entry,
      harness(
        fileURLToPath(new URL("../src/useReorderDrag.ts", import.meta.url)),
      ),
    );
    const bundle = await Bun.build({
      define: { "process.env.NODE_ENV": '"production"' },
      entrypoints: [entry],
      target: "browser",
    });
    if (!bundle.success)
      throw new Error(
        `Reorder fixture did not bundle: ${bundle.logs.join("\n")}`,
      );
    const source = await bundle.outputs[0]?.text();
    if (!source) throw new Error("Reorder fixture is empty.");

    browser = await launch({
      executablePath: chrome,
      headless: true,
      pipe: true,
      userDataDir: profile,
      timeout: 10_000,
      protocolTimeout: 20_000,
      args: ["--no-sandbox", "--password-store=basic", "--use-mock-keychain"],
    });
    const page = await browser.newPage();
    await page.setViewport({ height: 600, width: 800 });
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      void request.respond({
        body: '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>',
        contentType: "text/html",
      });
    });
    await page.goto("https://reorder.test/", { waitUntil: "domcontentloaded" });
    await page.evaluate(async (code) => {
      const url = URL.createObjectURL(
        new Blob([code], { type: "text/javascript" }),
      );
      await import(url);
      URL.revokeObjectURL(url);
    }, source);
    const handle = await page.waitForSelector("#handle-a");
    const bounds = await handle?.boundingBox();
    if (!bounds) throw new Error("The first handle has no box.");
    const limit = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    );

    await page.mouse.move(bounds.x + 4, bounds.y + 4);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 4, 595, { steps: 5 });
    // At 16px a frame, four seconds would pass the limit without the clamp.
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const scrolled = await page.evaluate(() => window.scrollY);
    await page.mouse.up();

    expect(limit).toBe(3000);
    expect(scrolled).toBeGreaterThan(limit - 32);
    expect(scrolled).toBeLessThanOrEqual(limit);
  } finally {
    await browser?.close();
    rmSync(fixture, { force: true, recursive: true });
    rmSync(profile, { force: true, recursive: true });
  }
}, 30_000);
