import { expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, launch } from "puppeteer-core";

it("canceling Back and Forward preserves the browser's history entries", async () => {
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
      const { createWorkspaceNavigation } = await import(url);
      URL.revokeObjectURL(url);
      const controller = createWorkspaceNavigation(
        window,
        (pathname: string) => {
          document.body.textContent = pathname;
        },
      );
      Reflect.set(window, "navigation", controller);
      Reflect.set(window, "allowNavigation", true);
      Reflect.set(window, "navigationPops", 0);
      window.addEventListener("popstate", () =>
        Reflect.set(
          window,
          "navigationPops",
          Number(Reflect.get(window, "navigationPops")) + 1,
        ),
      );
      window.addEventListener("workspace:navigate", (event) => {
        if (!Reflect.get(window, "allowNavigation")) event.preventDefault();
      });
      controller.navigate("/activity");
      controller.navigate("/contracts/templates/t1");
      Reflect.set(window, "allowNavigation", false);
      history.go(-2);
    }, source);
    await page.waitForFunction(
      () =>
        Number(Reflect.get(window, "navigationPops")) >= 2 &&
        location.pathname === "/contracts/templates/t1",
      { timeout: 5000 },
    );
    expect(await page.evaluate(() => history.length)).toBe(historyLength + 2);
    await page.evaluate(() => {
      Reflect.set(window, "allowNavigation", true);
      history.back();
    });
    await page.waitForFunction(() => location.pathname === "/activity", {
      timeout: 5000,
    });
    // A canceled Forward also restores the existing entry instead of adding one.
    await page.evaluate(() => {
      Reflect.set(window, "allowNavigation", false);
      history.forward();
    });
    await page.waitForFunction(
      () =>
        Number(Reflect.get(window, "navigationPops")) >= 5 &&
        location.pathname === "/activity",
      {
        timeout: 5000,
      },
    );
    expect(await page.evaluate(() => history.length)).toBe(historyLength + 2);
    await page.evaluate(() => {
      Reflect.set(window, "allowNavigation", true);
      history.forward();
    });
    await page.waitForFunction(
      () => location.pathname === "/contracts/templates/t1",
      { timeout: 5000 },
    );
    expect(await page.evaluate(() => document.body.textContent)).toBe(
      "/contracts/templates/t1",
    );
  } finally {
    await browser?.close();
    rmSync(profile, { force: true, recursive: true });
  }
}, 20_000);
