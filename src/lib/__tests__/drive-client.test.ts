import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractFolderId, isValidFolderId } from "../drive-client";

// Mock googleapis before importing functions that use getDrive()
const mockFilesList = vi.fn();
const mockFilesGet = vi.fn();

vi.mock("googleapis", () => {
  class MockGoogleAuth {}
  return {
    google: {
      auth: { GoogleAuth: MockGoogleAuth },
      drive: () => ({
        files: {
          list: (...args: unknown[]) => mockFilesList(...args),
          get: (...args: unknown[]) => mockFilesGet(...args),
        },
      }),
    },
  };
});

// Set env var so getDrive() doesn't throw
vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_KEY", Buffer.from(JSON.stringify({
  type: "service_account",
  project_id: "test",
  private_key_id: "test",
  private_key: "test",
  client_email: "test@test.iam.gserviceaccount.com",
  client_id: "123",
})).toString("base64"));

// Import after mocks are set up
const {
  listDeploymentFolders,
  listImagesRecursive,
  downloadDeploymentImages,
} = await import("../drive-client");

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

describe("isValidFolderId", () => {
  it("accepts alphanumeric IDs with hyphens and underscores", () => {
    expect(isValidFolderId("1abc2def3ghi")).toBe(true);
    expect(isValidFolderId("a-b_c")).toBe(true);
    expect(isValidFolderId("ABC123")).toBe(true);
  });

  it("rejects IDs with special characters", () => {
    expect(isValidFolderId("abc/def")).toBe(false);
    expect(isValidFolderId("abc def")).toBe(false);
    expect(isValidFolderId("abc..def")).toBe(false);
    expect(isValidFolderId("")).toBe(false);
    expect(isValidFolderId("abc'def")).toBe(false);
  });
});

describe("listDeploymentFolders", () => {
  beforeEach(() => {
    mockFilesList.mockReset();
  });

  it("lists top-level folders from root", async () => {
    mockFilesList.mockResolvedValueOnce({
      data: {
        files: [
          { id: "folder1", name: "DeploymentA" },
          { id: "folder2", name: "DeploymentB" },
        ],
        nextPageToken: null,
      },
    });

    const folders = await listDeploymentFolders("root123");
    expect(folders).toHaveLength(2);
    expect(folders[0]).toEqual({ id: "folder1", name: "DeploymentA" });
    expect(folders[1]).toEqual({ id: "folder2", name: "DeploymentB" });
  });

  it("handles pagination with nextPageToken", async () => {
    mockFilesList
      .mockResolvedValueOnce({
        data: {
          files: [{ id: "folder1", name: "A" }],
          nextPageToken: "token123",
        },
      })
      .mockResolvedValueOnce({
        data: {
          files: [{ id: "folder2", name: "B" }],
          nextPageToken: null,
        },
      });

    const folders = await listDeploymentFolders("root123");
    expect(folders).toHaveLength(2);
    expect(mockFilesList).toHaveBeenCalledTimes(2);
  });

  it("includes supportsAllDrives in API calls", async () => {
    mockFilesList.mockResolvedValueOnce({
      data: { files: [], nextPageToken: null },
    });

    await listDeploymentFolders("root123");

    expect(mockFilesList).toHaveBeenCalledWith(
      expect.objectContaining({
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      })
    );
  });

  it("throws on invalid folder ID", async () => {
    await expect(listDeploymentFolders("invalid/id")).rejects.toThrow(
      "Invalid folder ID format"
    );
  });

  it("returns sorted folders", async () => {
    mockFilesList.mockResolvedValueOnce({
      data: {
        files: [
          { id: "f2", name: "Zebra" },
          { id: "f1", name: "Alpha" },
        ],
        nextPageToken: null,
      },
    });

    const folders = await listDeploymentFolders("root123");
    expect(folders[0].name).toBe("Alpha");
    expect(folders[1].name).toBe("Zebra");
  });
});

describe("listImagesRecursive", () => {
  beforeEach(() => {
    mockFilesList.mockReset();
  });

  it("lists images in a flat folder layout", async () => {
    mockFilesList.mockResolvedValueOnce({
      data: {
        files: [
          { id: "img1", name: "IMG_001.jpg", mimeType: "image/jpeg", size: "1000", modifiedTime: "2025-01-01T00:00:00Z" },
          { id: "img2", name: "IMG_002.png", mimeType: "image/png", size: "2000", modifiedTime: "2025-01-02T00:00:00Z" },
        ],
        nextPageToken: null,
      },
    });

    const images = await listImagesRecursive("deploy1");
    expect(images).toHaveLength(2);
    expect(images[0].relativePath).toBe("IMG_001.jpg");
    expect(images[0].size).toBe(1000);
  });

  it("recursively scans subfolders", async () => {
    // Root folder: one subfolder, no direct images
    mockFilesList.mockResolvedValueOnce({
      data: {
        files: [
          { id: "sub1", name: "camaras_trampas", mimeType: "application/vnd.google-apps.folder" },
        ],
        nextPageToken: null,
      },
    });

    // Subfolder contents
    mockFilesList.mockResolvedValueOnce({
      data: {
        files: [
          { id: "img1", name: "IMG_001.jpg", mimeType: "image/jpeg", size: "5000", modifiedTime: "2025-06-01T00:00:00Z" },
        ],
        nextPageToken: null,
      },
    });

    const images = await listImagesRecursive("deploy1");
    expect(images).toHaveLength(1);
    expect(images[0].relativePath).toBe("camaras_trampas/IMG_001.jpg");
  });

  it("filters out non-image files", async () => {
    mockFilesList.mockResolvedValueOnce({
      data: {
        files: [
          { id: "img1", name: "photo.jpg", mimeType: "image/jpeg", size: "1000", modifiedTime: "" },
          { id: "aud1", name: "audio.wav", mimeType: "audio/wav", size: "5000", modifiedTime: "" },
          { id: "doc1", name: "readme.txt", mimeType: "text/plain", size: "100", modifiedTime: "" },
        ],
        nextPageToken: null,
      },
    });

    const images = await listImagesRecursive("deploy1");
    expect(images).toHaveLength(1);
    expect(images[0].name).toBe("photo.jpg");
  });

  it("filters out unsupported image extensions", async () => {
    mockFilesList.mockResolvedValueOnce({
      data: {
        files: [
          { id: "img1", name: "photo.jpg", mimeType: "image/jpeg", size: "1000", modifiedTime: "" },
          { id: "img2", name: "raw.cr2", mimeType: "image/x-canon-cr2", size: "5000", modifiedTime: "" },
        ],
        nextPageToken: null,
      },
    });

    const images = await listImagesRecursive("deploy1");
    expect(images).toHaveLength(1);
    expect(images[0].name).toBe("photo.jpg");
  });

  it("handles pagination in subfolder listing", async () => {
    mockFilesList
      .mockResolvedValueOnce({
        data: {
          files: [{ id: "img1", name: "A.jpg", mimeType: "image/jpeg", size: "100", modifiedTime: "" }],
          nextPageToken: "page2",
        },
      })
      .mockResolvedValueOnce({
        data: {
          files: [{ id: "img2", name: "B.jpg", mimeType: "image/jpeg", size: "200", modifiedTime: "" }],
          nextPageToken: null,
        },
      });

    const images = await listImagesRecursive("deploy1");
    expect(images).toHaveLength(2);
  });
});
