import { describe, it, expect } from "vitest";
import { extractFolderId } from "../drive-client";

describe("extractFolderId", () => {
  it("extracts ID from standard folder URL", () => {
    expect(
      extractFolderId("https://drive.google.com/drive/folders/1abc2def3ghi")
    ).toBe("1abc2def3ghi");
  });

  it("extracts ID from URL with query parameters", () => {
    expect(
      extractFolderId(
        "https://drive.google.com/drive/folders/1abc2def3ghi?usp=sharing"
      )
    ).toBe("1abc2def3ghi");
  });

  it("extracts ID from URL with /u/0/ path", () => {
    expect(
      extractFolderId(
        "https://drive.google.com/drive/u/0/folders/1abc2def3ghi"
      )
    ).toBe("1abc2def3ghi");
  });

  it("handles IDs with hyphens and underscores", () => {
    expect(
      extractFolderId(
        "https://drive.google.com/drive/folders/1a-b_c2D3E"
      )
    ).toBe("1a-b_c2D3E");
  });

  it("returns null for empty string", () => {
    expect(extractFolderId("")).toBeNull();
  });

  it("returns null for non-URL string", () => {
    expect(extractFolderId("not a url")).toBeNull();
  });

  it("returns null for URL without folders path", () => {
    expect(
      extractFolderId("https://drive.google.com/drive/my-drive")
    ).toBeNull();
  });
});
