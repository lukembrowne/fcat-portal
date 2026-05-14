/**
 * `replaceFileContentAndRename` filename sanitization — unit test.
 *
 * Verifies that path-traversal attempts in the `newName` argument are rejected
 * before any Drive call is made.
 */

import { describe, it, expect, vi } from "vitest";

// Block the googleapis import path so the module loads cleanly without a real
// service account. We never hit a Drive call in these tests — the sanitization
// throws first.
vi.mock("googleapis", () => ({
  google: {
    drive: () => ({
      files: { update: vi.fn(), get: vi.fn() },
      revisions: { update: vi.fn() },
    }),
    auth: { GoogleAuth: class {} },
  },
}));

process.env.GOOGLE_SERVICE_ACCOUNT_KEY = Buffer.from(
  JSON.stringify({ type: "service_account" }),
).toString("base64");

const { replaceFileContentAndRename } = await import("@/lib/drive-client");

describe("replaceFileContentAndRename filename sanitization", () => {
  it("rejects path-traversal '..' in the newName", async () => {
    await expect(
      replaceFileContentAndRename(
        "fileId123",
        Buffer.from("hi"),
        "../escape.flac",
        "audio/flac",
      ),
    ).rejects.toThrow(/unsafe/i);
  });

  it("rejects names containing a slash separator", async () => {
    await expect(
      replaceFileContentAndRename(
        "fileId123",
        Buffer.from("hi"),
        "subdir/file.flac",
        "audio/flac",
      ),
    ).rejects.toThrow(/unsafe/i);
  });

  it("rejects empty name", async () => {
    await expect(
      replaceFileContentAndRename(
        "fileId123",
        Buffer.from("hi"),
        "",
        "audio/flac",
      ),
    ).rejects.toThrow(/unsafe/i);
  });
});
