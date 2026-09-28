import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readdir } from "node:fs/promises";
import { Hono } from "hono";
import type { AuthSession } from "./auth";
import type { AuthVariables } from "./authMiddleware";
import { libraryFolders } from "./libraryFolders";
import { objects } from "./objects";
import { createTestD1 } from "./testDatabase";
import type { Bindings } from "./types";

const timestamp = "2026-09-20T12:00:00.000Z";

interface Folder {
  emailCount: number;
  fileCount: number;
  id: string;
  name: string;
}

interface StoredObject {
  filename: string;
  folderId: string | null;
  id: string;
}

describe("library folders", () => {
  it("creates, renames, and lists organization folders", async () => {
    const fixture = await createFixture();

    const created = await fixture.json<{ folder: Folder }>(
      "POST",
      "/api/library/folders",
      { name: "  Tax   returns " },
    );
    expect(created.status).toBe(201);
    expect(created.body.folder).toMatchObject({
      emailCount: 0,
      fileCount: 0,
      name: "Tax returns",
    });
    const folderId = created.body.folder.id;

    expect(
      (
        await fixture.json("POST", "/api/library/folders", {
          name: "TAX RETURNS",
        })
      ).status,
    ).toBe(409);
    expect(
      (await fixture.json("POST", "/api/library/folders", { name: " " }))
        .status,
    ).toBe(400);
    expect(
      (
        await fixture.json("POST", "/api/library/folders", {
          name: "x".repeat(81),
        })
      ).status,
    ).toBe(400);
    await fixture.json("POST", "/api/library/folders", { name: "Contracts" });

    const renamed = await fixture.json(
      "PATCH",
      `/api/library/folders/${folderId}`,
      { name: "Taxes" },
    );
    expect(renamed.status).toBe(200);
    expect(
      (
        await fixture.json("PATCH", `/api/library/folders/${folderId}`, {
          name: "contracts",
        })
      ).status,
    ).toBe(409);

    const listing = await fixture.json<{ folders: Folder[] }>(
      "GET",
      "/api/library/folders",
    );
    expect(listing.body.folders.map(({ name }) => name)).toEqual([
      "Contracts",
      "Taxes",
    ]);

    const other = fixture.as("org-2");
    const otherListing = await other.json<{ folders: Folder[] }>(
      "GET",
      "/api/library/folders",
    );
    expect(otherListing.body.folders.map(({ name }) => name)).toEqual([
      "Other",
    ]);
    expect(
      (await other.json("GET", `/api/library/folders/${folderId}`)).status,
    ).toBe(404);
    expect(
      (
        await other.json("PATCH", `/api/library/folders/${folderId}`, {
          name: "Mine",
        })
      ).status,
    ).toBe(404);
    expect(
      (await other.json("DELETE", `/api/library/folders/${folderId}`)).status,
    ).toBe(404);
  });

  it("uploads into folders and moves documents between them", async () => {
    const fixture = await createFixture();
    const folder = await fixture.json<{ folder: Folder }>(
      "POST",
      "/api/library/folders",
      { name: "Receipts" },
    );
    const folderId = folder.body.folder.id;

    const rootFile = await fixture.upload("root.txt");
    expect(rootFile.body.object.folderId).toBeNull();
    const filedFile = await fixture.upload("filed.txt", folderId);
    expect(filedFile.status).toBe(201);
    expect(filedFile.body.object.folderId).toBe(folderId);
    expect((await fixture.upload("elsewhere.txt", "folder-other")).status).toBe(
      404,
    );
    expect(fixture.stored.size).toBe(2);

    expect(await fixture.filenames()).toEqual(["root.txt"]);
    expect(await fixture.filenames(folderId)).toEqual(["filed.txt"]);
    expect(
      (await fixture.json("GET", "/api/objects?folder=folder-other")).status,
    ).toBe(404);

    const moved = await fixture.json<{ object: StoredObject }>(
      "PATCH",
      `/api/objects/${rootFile.body.object.id}`,
      { folderId },
    );
    expect(moved.status).toBe(200);
    expect(moved.body.object.folderId).toBe(folderId);
    expect(await fixture.filenames()).toEqual([]);
    expect((await fixture.filenames(folderId)).sort()).toEqual([
      "filed.txt",
      "root.txt",
    ]);
    expect(
      (
        await fixture.json<{ folder: Folder }>(
          "GET",
          `/api/library/folders/${folderId}`,
        )
      ).body.folder.fileCount,
    ).toBe(2);

    const unfiled = await fixture.json<{ object: StoredObject }>(
      "PATCH",
      `/api/objects/${filedFile.body.object.id}`,
      { folderId: null },
    );
    expect(unfiled.body.object.folderId).toBeNull();
    expect(await fixture.filenames()).toEqual(["filed.txt"]);

    expect(
      (
        await fixture.json("PATCH", `/api/objects/${rootFile.body.object.id}`, {
          folderId: "folder-other",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fixture.json("PATCH", `/api/objects/${rootFile.body.object.id}`, {
          folder: folderId,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fixture
          .as("org-2")
          .json("PATCH", `/api/objects/${rootFile.body.object.id}`, {
            folderId: null,
          })
      ).status,
    ).toBe(404);
  });

  it("returns documents to the root and drops email links on delete", async () => {
    const fixture = await createFixture();
    const folder = await fixture.json<{ folder: Folder }>(
      "POST",
      "/api/library/folders",
      { name: "Leases" },
    );
    const folderId = folder.body.folder.id;
    await fixture.upload("lease.pdf", folderId);
    fixture.database
      .query(
        `INSERT INTO inbound_email_links
         (id, organization_id, email_id, target_type, target_id, created_by,
          created_at)
         VALUES ('link-1', 'org-1', 'email-1', 'library_folder', ?, 'user-1',
                 ?)`,
      )
      .run(folderId, timestamp);
    expect(
      (
        await fixture.json<{ folder: Folder }>(
          "GET",
          `/api/library/folders/${folderId}`,
        )
      ).body.folder,
    ).toMatchObject({ emailCount: 1, fileCount: 1 });

    const deleted = await fixture.json(
      "DELETE",
      `/api/library/folders/${folderId}`,
    );
    expect(deleted.status).toBe(204);
    expect(await fixture.filenames()).toEqual(["lease.pdf"]);
    expect(
      fixture.database.query("SELECT id FROM inbound_email_links").all(),
    ).toEqual([]);
    expect(
      (await fixture.json("GET", `/api/library/folders/${folderId}`)).status,
    ).toBe(404);
  });
});

async function createFixture() {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  await applyMigrations(database);
  seed(database);
  const stored = new Map<string, Uint8Array>();
  const bindings = {
    AUTH_EMAIL_FROM: "security@auth.tearleads.de",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    BETTER_AUTH_URL: "https://api.test",
    CORS_ORIGIN: "https://app.test",
    DB: createTestD1(database),
    EMAIL: {} as SendEmail,
    IMAGES: {} as ImagesBinding,
    INBOUND_EMAIL_DOMAIN: "inbox.tearleads.de",
    STORAGE: storageFor(stored),
  } satisfies Bindings;

  function client(organizationId: string) {
    const app = testApp(organizationId);
    const request = (path: string, init?: RequestInit) =>
      app.request(path, init, bindings);
    const json = async <T = unknown>(
      method: string,
      path: string,
      body?: unknown,
    ) => {
      const init: RequestInit = { method };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers = { "content-type": "application/json" };
      }
      const response = await request(path, init);
      const text = await response.text();
      return {
        body: (text ? JSON.parse(text) : null) as T,
        status: response.status,
      };
    };
    return { json, request };
  }

  const primary = client("org-1");
  return {
    ...primary,
    as: client,
    database,
    filenames: async (folderId?: string) => {
      const query = folderId ? `?folder=${folderId}` : "";
      const listing = await primary.json<{ objects: StoredObject[] }>(
        "GET",
        `/api/objects${query}`,
      );
      return listing.body.objects.map(({ filename }) => filename);
    },
    stored,
    upload: async (filename: string, folderId?: string) => {
      const form = new FormData();
      form.set("file", new File(["contents"], filename));
      if (folderId) form.set("folderId", folderId);
      const response = await primary.request("/api/objects", {
        body: form,
        method: "POST",
      });
      return {
        body: (await response.json()) as { object: StoredObject },
        status: response.status,
      };
    },
  };
}

function seed(database: Database) {
  for (const [id, organizationId] of [
    ["user-1", "org-1"],
    ["user-2", "org-2"],
  ] as const) {
    database
      .query(
        `INSERT INTO user
         (id, name, email, emailVerified, createdAt, updatedAt, role, banned)
         VALUES (?, ?, ?, 1, ?, ?, 'user', 0)`,
      )
      .run(id, id, `${id}@example.com`, timestamp, timestamp);
    database
      .query(
        `INSERT INTO organization (id, name, slug, createdAt)
         VALUES (?, ?, ?, ?)`,
      )
      .run(organizationId, organizationId, organizationId, timestamp);
  }
  database
    .query(
      `INSERT INTO library_folders
       (id, organization_id, name, created_at, updated_at)
       VALUES ('folder-other', 'org-2', 'Other', ?, ?)`,
    )
    .run(timestamp, timestamp);
  database
    .query(
      `INSERT INTO inbound_emails
       (id, organization_id, envelope_from, envelope_to, subject,
        raw_object_key, raw_size, received_at)
       VALUES ('email-1', 'org-1', 'sender@example.com',
               'upload@inbox.tearleads.de', 'Lease', 'raw/email-1', 1, ?)`,
    )
    .run(timestamp);
}

function testApp(organizationId: string) {
  const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  app.use("*", async (context, next) => {
    context.set("organizationId", organizationId);
    context.set("authSession", {
      user: { id: "user-1", role: "user" },
    } as unknown as AuthSession);
    await next();
  });
  app.route("/api/library/folders", libraryFolders);
  app.route("/api/objects", objects);
  return app;
}

async function applyMigrations(database: Database) {
  const directory = `${import.meta.dir}/../migrations`;
  for (const filename of (await readdir(directory)).sort()) {
    database.exec(await Bun.file(`${directory}/${filename}`).text());
  }
}

function storageFor(stored: Map<string, Uint8Array>) {
  return {
    delete: async (key: string) => stored.delete(key),
    put: async (key: string, value: Blob) => {
      stored.set(key, new Uint8Array(await value.arrayBuffer()));
    },
  } as unknown as R2Bucket;
}
