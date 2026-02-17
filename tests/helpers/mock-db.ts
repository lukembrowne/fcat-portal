/**
 * Shared mock for @/db used by permission guard tests.
 *
 * Moved out of mock-auth.ts to prevent vi.mock("@/db") from being
 * hoisted in test files that only import mock-auth for auth helpers.
 *
 * Usage:
 *   import { setupDbMock } from "../helpers/mock-db";
 *   setupDbMock();  // call at module level
 */

import { vi } from "vitest";

/**
 * Recursive chainable proxy that mimics Drizzle's query builder.
 * Returns itself for any property access or function call.
 * Excludes "then" so `await proxy` resolves immediately instead of hanging.
 */
function chainProxy(): unknown {
  return new Proxy(() => {}, {
    get: (_target, prop) => {
      if (prop === "then") return undefined;
      return chainProxy();
    },
    apply: () => chainProxy(),
  });
}

/**
 * Call at module level to register the @/db mock.
 * Returns a chainable proxy that never throws, so actions can
 * proceed past DB calls (we only care about the permission check).
 */
export function setupDbMock() {
  vi.mock("@/db", () => ({
    db: new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "then") return undefined;
          return (..._args: unknown[]) => chainProxy();
        },
      }
    ),
  }));
}
