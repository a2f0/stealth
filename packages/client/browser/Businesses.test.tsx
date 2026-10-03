import { expect, it } from "bun:test";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { BusinessListView } from "../src/Businesses";
import type { Business } from "../src/businessesApi";
import {
  type BusinessListState,
  businessListReducer,
  initialBusinessListState,
} from "../src/businessState";

const acme: Business = {
  city: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  ein: null,
  id: "business-1",
  incorporationDate: null,
  name: "Acme, Inc.",
  state: null,
  streetAddress: null,
  updatedAt: "2026-09-01T00:00:00.000Z",
  zip: null,
};

function renderState(state: BusinessListState) {
  const noop = () => {};
  return renderToStaticMarkup(
    <BusinessListView
      {...state}
      onAddingChange={noop}
      onCreated={noop}
      onDeleted={noop}
      onEinCopied={noop}
      onError={noop}
      onNavigate={noop}
      onUpdated={noop}
    />,
  );
}

const { CHROME_PATH } = process.env;
const chrome =
  CHROME_PATH ||
  Bun.which("google-chrome") ||
  Bun.which("chromium") ||
  (existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : null);

interface LayoutMeasurements {
  listDidNotMove: boolean;
  pageHeightUnchanged: boolean;
  pinnedAfterScroll: boolean;
  visibleAfterScroll: boolean;
  scrolled: boolean;
  viewportWidth: number;
}

it("business notification layout stays at the bottom without moving content", async () => {
  expect(chrome).not.toBeNull();
  if (!chrome)
    throw new Error("Chrome is required for the notification layout check.");
  const state = businessListReducer(initialBusinessListState, {
    type: "loaded",
    data: { businesses: [{ ...acme, ein: "123456789" }], canManage: true },
  });
  const before = renderState(state);
  const after = renderState(businessListReducer(state, { type: "einCopied" }));
  const styleRoot = fileURLToPath(
    new URL("../../ui/src/styles/", import.meta.url),
  );
  const css = ["tokens", "base", "surfaces"]
    .map((name) => readFileSync(join(styleRoot, `${name}.css`), "utf8"))
    .join("\n");
  const html = `<!doctype html><html><head><style>${css}</style></head><body><script>
      const filler = '<div style="height:2000px"></div>';
      document.body.innerHTML = ${JSON.stringify(before)} + filler;
      const listTop = document.querySelector('.rowList').getBoundingClientRect().top;
      const pageHeight = document.querySelector('.pageBody').getBoundingClientRect().height;
      document.body.innerHTML = ${JSON.stringify(after)} + filler;
      const toast = document.querySelector('[role="status"]');
      const initialToast = toast.getBoundingClientRect();
      const listDidNotMove = listTop === document.querySelector('.rowList').getBoundingClientRect().top;
      const pageHeightUnchanged = pageHeight === document.querySelector('.pageBody').getBoundingClientRect().height;
      window.scrollTo(0, 600);
      const scrolledToast = toast.getBoundingClientRect();
      const result = {
        listDidNotMove, pageHeightUnchanged,
        pinnedAfterScroll: initialToast.top === scrolledToast.top && Math.abs(window.innerHeight - scrolledToast.bottom - 16) < 1,
        visibleAfterScroll: scrolledToast.top >= 0 && scrolledToast.bottom <= window.innerHeight && scrolledToast.left >= 0 && scrolledToast.right <= window.innerWidth,
        scrolled: window.scrollY > 0,
        viewportWidth: window.innerWidth
      };
      const output = document.createElement('pre'); output.id = 'layout-result';
      output.textContent = JSON.stringify(result); document.body.append(output);
    </script></body></html>`;
  // Chrome's headless window has a minimum width of 500px.
  for (const width of [1200, 500]) {
    const result = await measureBrowserLayout(chrome, html, width);
    expect(result).toEqual({
      listDidNotMove: true,
      pageHeightUnchanged: true,
      pinnedAfterScroll: true,
      visibleAfterScroll: true,
      scrolled: true,
      viewportWidth: width,
    });
  }
}, 30_000);

async function measureBrowserLayout(
  browser: string,
  html: string,
  width: number,
): Promise<LayoutMeasurements> {
  const directory = mkdtempSync(join(tmpdir(), "business-toast-layout-"));
  const input = join(directory, "index.html");
  const output = join(directory, "output.html");
  const errors = join(directory, "errors.log");
  writeFileSync(input, html);
  const descriptor = openSync(output, "w");
  const errorDescriptor = openSync(errors, "w");
  const child = spawn(
    browser,
    [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-breakpad",
      "--disable-crash-reporter",
      "--disable-gpu",
      "--password-store=basic",
      "--use-mock-keychain",
      `--user-data-dir=${join(directory, "profile")}`,
      `--window-size=${width},800`,
      "--virtual-time-budget=1500",
      "--dump-dom",
      pathToFileURL(input).href,
    ],
    { detached: true, stdio: ["ignore", descriptor, errorDescriptor] },
  );
  closeSync(descriptor);
  closeSync(errorDescriptor);
  let launchError: Error | undefined;
  child.on("error", (error) => {
    launchError = error;
  });
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      const match = readFileSync(output, "utf8").match(
        /<pre id="layout-result">(.*?)<\/pre>/,
      );
      if (match?.[1]) return JSON.parse(match[1]) as LayoutMeasurements;
      await Bun.sleep(50);
    }
    throw new Error(
      `Chrome returned no layout measurements at width ${width}: ${readFileSync(errors, "utf8")}`,
    );
  } finally {
    if (child.pid) {
      signalBrowserGroup(child.pid, "SIGTERM");
      await Bun.sleep(200);
      signalBrowserGroup(child.pid, "SIGKILL");
    }
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
}

function signalBrowserGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    // Chrome may have already exited successfully after dumping the page.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
