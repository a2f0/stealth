import { expect, test } from "bun:test";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { readBodyWithLimit } from "./auditIssueImages";

test.skipIf(Reflect.get(process.env, "TEARLEADS_PREFLIGHT_OFFLINE") === "1")(
  "workerd accepts the bounded known-length upload body",
  async () => {
    const miniflare = new Miniflare(
      convertV4MiniflareOptions({
        compatibilityDate: "2026-08-17",
        modules: true,
        r2Buckets: ["STORAGE"],
        script: "export default { fetch() { return new Response('ok'); } };",
      }),
    );
    try {
      const storage = await miniflare.getR2Bucket("STORAGE");
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.from([1, 2, 3]));
          controller.close();
        },
      });
      const bytes = await readBodyWithLimit(source, 10, 1_000);
      expect(bytes).not.toBeNull();

      await storage.put("known-length", bytes as Uint8Array);
      expect(await (await storage.get("known-length"))?.bytes()).toEqual(
        Uint8Array.from([1, 2, 3]),
      );

      const unknownLength = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.from([1, 2, 3]));
          controller.close();
        },
      }).pipeThrough(new TransformStream<Uint8Array, Uint8Array>());
      await expect(
        // Exercise the runtime rejection even though the host and workerd stream
        // types intentionally differ at this negative-test boundary.
        storage.put("unknown-length", unknownLength as never),
      ).rejects.toThrow(/known length/i);
    } finally {
      await miniflare.dispose();
    }
  },
);
