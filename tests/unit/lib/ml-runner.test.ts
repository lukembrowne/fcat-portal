/**
 * Tests for ML Runner — model server bridge.
 *
 * Mocks child_process, fs, and @/db to verify:
 * - checkPytorchWildlife Python discovery and version detection
 * - shutdownModelServer cleanup
 * - cancelModelServerJob state check
 * - Error paths for missing Python, missing PytorchWildlife
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// Mock child_process
const mockExecFile = vi.fn();
const mockSpawn = vi.fn();

vi.mock("child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock("util", () => ({
  promisify: (fn: Function) => {
    // Properly wrap callback-based function into promise
    return (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        fn(...args, (err: Error | null, result: unknown) => {
          if (err) reject(err);
          else resolve(result);
        });
      });
  },
}));

// Mock fs (used for PID file management)
vi.mock("fs", () => ({
  default: {
    readFileSync: vi.fn(() => {
      throw new Error("ENOENT");
    }),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
  readFileSync: vi.fn(() => {
    throw new Error("ENOENT");
  }),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Mock readline (used for NDJSON parsing)
vi.mock("readline", () => ({
  createInterface: vi.fn(() => ({
    on: vi.fn(),
  })),
}));

// Mock DB and schema
vi.mock("@/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          all: vi.fn(() => []),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => []),
      })),
    })),
  },
}));

vi.mock("@/db/schema", () => ({
  processingJobs: "processingJobs",
  images: "images",
  detections: "detections",
  identifications: "identifications",
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
}));

vi.mock("@/lib/ml-defaults", () => ({
  ML_DEFAULTS: {
    detectorModel: "MDV6-yolov9-c",
    classifierModel: "AI4GAmazonRainforest",
    confidenceThreshold: 0.1,
  },
}));

const {
  checkPytorchWildlife,
  shutdownModelServer,
  cancelModelServerJob,
} = await import("@/lib/ml-runner");

beforeEach(() => {
  vi.clearAllMocks();
  // Reset env for each test
  delete process.env.ML_PYTHON_PATH;
});

// === checkPytorchWildlife ===

describe("checkPytorchWildlife", () => {
  it("returns available=true when Python and PytorchWildlife are found", async () => {
    // findPython: python3 --version succeeds
    mockExecFile
      .mockImplementationOnce(
        (_cmd: string, _args: string[], cb: Function) => {
          cb(null, { stdout: "Python 3.11.5\n" });
        }
      )
      // checkPytorchWildlife: import PytorchWildlife succeeds
      .mockImplementationOnce(
        (_cmd: string, _args: string[], cb: Function) => {
          cb(null, { stdout: "1.0.3\n" });
        }
      );

    // Mock spawn for the pre-warm ensureModelServer call
    // It will call findPython again, then try to spawn
    mockSpawn.mockReturnValue({
      pid: 12345,
      stdin: { writable: false },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
    });

    const result = await checkPytorchWildlife();
    expect(result.available).toBe(true);
    expect(result.python).toBe("python3");
    expect(result.message).toContain("pytorch-wildlife");
    expect(result.message).toContain("1.0.3");
  });

  it("returns available=false when Python is not found", async () => {
    // All Python candidates fail
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], cb: Function) => {
        cb(new Error("ENOENT: python3 not found"));
      }
    );

    const result = await checkPytorchWildlife();
    expect(result.available).toBe(false);
    expect(result.python).toBeNull();
    expect(result.message).toContain("Python 3 no encontrado");
  });

  it("returns available=false when PytorchWildlife is not installed", async () => {
    // findPython: python3 works
    mockExecFile
      .mockImplementationOnce(
        (_cmd: string, _args: string[], cb: Function) => {
          cb(null, { stdout: "Python 3.11.5\n" });
        }
      )
      // PytorchWildlife import fails
      .mockImplementationOnce(
        (_cmd: string, _args: string[], cb: Function) => {
          cb(
            Object.assign(new Error("ModuleNotFoundError"), {
              stderr: "ModuleNotFoundError: No module named 'PytorchWildlife'",
            })
          );
        }
      );

    const result = await checkPytorchWildlife();
    expect(result.available).toBe(false);
    expect(result.python).toBe("python3");
    expect(result.message).toContain("pytorch-wildlife no encontrado");
  });

  it("uses ML_PYTHON_PATH env var when set", async () => {
    process.env.ML_PYTHON_PATH = "/custom/venv/bin/python";

    // Custom python path works
    mockExecFile
      .mockImplementationOnce(
        (cmd: string, _args: string[], cb: Function) => {
          expect(cmd).toBe("/custom/venv/bin/python");
          cb(null, { stdout: "Python 3.10.12\n" });
        }
      )
      .mockImplementationOnce(
        (_cmd: string, _args: string[], cb: Function) => {
          cb(null, { stdout: "1.0.2\n" });
        }
      );

    mockSpawn.mockReturnValue({
      pid: 12345,
      stdin: { writable: false },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
    });

    const result = await checkPytorchWildlife();
    expect(result.available).toBe(true);
    expect(result.python).toBe("/custom/venv/bin/python");
  });
});

// === shutdownModelServer ===

describe("shutdownModelServer", () => {
  it("does not throw when no server is running", () => {
    expect(() => shutdownModelServer()).not.toThrow();
  });
});

// === cancelModelServerJob ===

describe("cancelModelServerJob", () => {
  it("does not throw when no server is running", () => {
    expect(() => cancelModelServerJob()).not.toThrow();
  });
});
