import { expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, launch } from "puppeteer-core";

it("guarded Back, Forward, and links ask first and keep history entries", async () => {
  const { CHROME_PATH } = process.env;
  const chrome =
    CHROME_PATH ||
    Bun.which("google-chrome") ||
    Bun.which("chromium") ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(chrome))
    throw new Error("Chrome is required for the navigation check.");
  const bundle = await Bun.build({
    entrypoints: [
      fileURLToPath(new URL("../src/navigationGuard.ts", import.meta.url)),
    ],
    target: "browser",
  });
  if (!bundle.success)
    throw new Error(
      `Navigation fixture did not bundle: ${bundle.logs.join("\n")}`,
    );
  const source = await bundle.outputs[0]?.text();
  if (!source) throw new Error("Navigation fixture is empty.");
  const profile = mkdtempSync(join(tmpdir(), "workspace-navigation-"));
  let browser: Browser | undefined;
  try {
    browser = await launch({
      executablePath: chrome,
      headless: true,
      pipe: true,
      userDataDir: profile,
      timeout: 10_000,
      protocolTimeout: 10_000,
      args: ["--no-sandbox", "--password-store=basic", "--use-mock-keychain"],
    });
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      void request.respond({
        contentType: "text/html",
        body: "<!doctype html><html><body></body></html>",
      });
    });
    await page.goto("https://navigation.test/", {
      waitUntil: "domcontentloaded",
    });
    const historyLength = await page.evaluate(() => history.length);
    await page.evaluate(async (code) => {
      const url = URL.createObjectURL(
        new Blob([code], { type: "text/javascript" }),
      );
      const { addNavigationGuard, createWorkspaceNavigation } = await import(
        url
      );
      URL.revokeObjectURL(url);
      const controller = createWorkspaceNavigation(
        window,
        (pathname: string) => {
          document.body.textContent = pathname;
        },
      );
      let removeGuard: (() => void) | undefined;
      // A guard stands in for unsaved work; undefined means nothing unsaved.
      Reflect.set(window, "guard", (answer: boolean | undefined) => {
        removeGuard?.();
        removeGuard =
          answer === undefined
            ? undefined
            : addNavigationGuard(async () => answer);
      });
      Reflect.set(window, "navigation", controller);
      Reflect.set(window, "navigationPops", 0);
      window.addEventListener("popstate", () =>
        Reflect.set(
          window,
          "navigationPops",
          Number(Reflect.get(window, "navigationPops")) + 1,
        ),
      );
      controller.navigate("/activity");
      controller.navigate("/contracts/templates/t1");
    }, source);
    const setGuard = (answer: boolean | undefined) =>
      page.evaluate((value) => {
        (Reflect.get(window, "guard") as (value?: boolean) => void)(
          value ?? undefined,
        );
      }, answer ?? null);
    const pops = () =>
      page.evaluate(() => Number(Reflect.get(window, "navigationPops")));
    const settled = (pathname: string, minimumPops: number) =>
      page.waitForFunction(
        (path, count) =>
          Number(Reflect.get(window, "navigationPops")) >= count &&
          location.pathname === path &&
          document.body.textContent === path,
        { timeout: 5000 },
        pathname,
        minimumPops,
      );

    // A canceled Back returns to its entry without adding one.
    await setGuard(false);
    await page.evaluate(() => history.go(-2));
    await settled("/contracts/templates/t1", 2);
    expect(await page.evaluate(() => history.length)).toBe(historyLength + 2);

    // An allowed Back returns first, then replays the move once allowed.
    await setGuard(true);
    await page.evaluate(() => history.back());
    await settled("/activity", 5);
    expect(await pops()).toBe(5);

    // A canceled Forward also restores the existing entry.
    await setGuard(false);
    await page.evaluate(() => history.forward());
    await page.waitForFunction(
      () => Number(Reflect.get(window, "navigationPops")) >= 7,
      { timeout: 5000 },
    );
    await settled("/activity", 7);
    expect(await page.evaluate(() => history.length)).toBe(historyLength + 2);

    // With nothing unsaved, Forward moves at once.
    await setGuard(undefined);
    await page.evaluate(() => history.forward());
    await settled("/contracts/templates/t1", 8);

    // In-app navigation waits for the guards too.
    await setGuard(false);
    await page.evaluate(() =>
      (
        Reflect.get(window, "navigation") as {
          navigate: (path: string) => void;
        }
      ).navigate("/library"),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await page.evaluate(() => location.pathname)).toBe(
      "/contracts/templates/t1",
    );
    await setGuard(true);
    await page.evaluate(() =>
      (
        Reflect.get(window, "navigation") as {
          navigate: (path: string) => void;
        }
      ).navigate("/library"),
    );
    await settled("/library", 8);
    expect(await page.evaluate(() => history.length)).toBe(historyLength + 3);
  } finally {
    await browser?.close();
    rmSync(profile, { force: true, recursive: true });
  }
}, 20_000);
