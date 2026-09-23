import { createReadStream } from "node:fs";
import { cp } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

export default defineConfig({
  plugins: [react(), pdfjsAssets()],
});

/**
 * pdf.js fetches its image decoders (JBIG2, JPEG 2000), colour profiles,
 * character maps, and standard fonts at runtime from a base URL, so they are
 * served from /pdfjs/ rather than bundled. Keep the list in sync with the
 * URLs passed to getDocument in pdfDocument.ts.
 */
function pdfjsAssets(): Plugin {
  const root = dirname(
    createRequire(import.meta.url).resolve("pdfjs-dist/package.json"),
  );
  const directories = ["cmaps", "iccs", "standard_fonts", "wasm"];
  return {
    name: "tearleads-pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/pdfjs", (request, response, next) => {
        const path = decodeURIComponent(request.url?.split("?")[0] ?? "");
        const [directory, file, ...rest] = path.split("/").filter(Boolean);
        if (
          !directory ||
          !directories.includes(directory) ||
          !file ||
          file.startsWith(".") ||
          rest.length > 0
        ) {
          next();
          return;
        }
        createReadStream(join(root, directory, file))
          .on("error", () => next())
          .on("open", () => {
            if (file.endsWith(".wasm")) {
              response.setHeader("Content-Type", "application/wasm");
            }
          })
          .pipe(response);
      });
    },
    async writeBundle({ dir }) {
      if (!dir) return;
      for (const directory of directories) {
        await cp(join(root, directory), join(dir, "pdfjs", directory), {
          recursive: true,
        });
      }
    },
  };
}
