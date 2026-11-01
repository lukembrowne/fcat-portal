/**
 * Nightly ODK re-link: a retrieve_sensors form submitted AFTER a deployment
 * was first linked must still reach `date_end`.
 *
 * Linking used to run only when a deployment's Drive folder was discovered —
 * at installation — so 56 BioChoco retrievals sat in ODK without ever reaching
 * the portal, and every deployment-window consumer undercounted.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  createTestDb,
  setupIntegrationDbMock,
  testDbRef,
  type TestDb,
} from "../helpers/test-db";

setupIntegrationDbMock();

vi.mock("server-only", () => ({}));

const odk = vi.hoisted(() => ({
  installs: [] as Array<Record<string, unknown>>,
  retrievals: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/odk-client", () => ({
  fetchEntities: vi.fn(async () => []),
  fetchSubmissions: vi.fn(async (_project: string, form: string) =>
    form === "retrieve_sensors" ? odk.retrievals : odk.installs
  ),
}));

let db: TestDb;

function seedDeployment(
  name: string,
  values: Partial<typeof schema.deployments.$inferInsert> = {}
): number {
  return db
    .insert(schema.deployments)
    .values({ projectId: "camera-trap", name, status: "scanned", ...values })
    .returning()
    .all()[0].id;
}

function dateEndOf(id: number): string | null {
  return db
    .select({ dateEnd: schema.deployments.dateEnd })
    .from(schema.deployments)
    .where(eq(schema.deployments.id, id))
    .all()[0].dateEnd;
}

function install(deploymentId: string, deployDate: string) {
  return {
    __id: `uuid:${deploymentId}`,
    site_selection: { deployment_id: deploymentId, site_id: "S1" },
    deployment_info: { deploy_date: deployDate },
  };
}

function retrieval(deploymentId: string, date: string) {
  return {
    __id: `uuid:ret-${deploymentId}`,
    site_selection: { deployment_id: deploymentId },
    retrieval_info: { retrieval_date: date },
  };
}

async function relink() {
  const { relinkIncompleteOdkDeploymentsInternal } = await import(
    "@/lib/camera-trap-sync-internals"
  );
  return relinkIncompleteOdkDeploymentsInternal();
}

beforeEach(() => {
  db = createTestDb();
  testDbRef.current = db;
  odk.installs = [];
  odk.retrievals = [];
});

describe("relinkIncompleteOdkDeploymentsInternal", () => {
  it("fills date_end on a deployment linked before its retrieval was submitted", async () => {
    // Linked at install time: submission id and start date set, no end.
    const id = seedDeployment("CCN-006_V1", {
      odkSubmissionId: "uuid:CCN-006_V1",
      dateStart: "2026-06-21",
      metadataSource: "odk",
    });
    odk.installs = [install("CCN-006_V1", "2026-06-21")];
    odk.retrievals = [retrieval("CCN-006_V1", "2026-07-21T10:00:00-05:00")];

    const result = await relink();

    expect(dateEndOf(id)).toBe("2026-07-21");
    expect(result).toEqual({ checked: 1, matched: 1, datesFilled: 1 });
  });

  it("leaves a deployment with no retrieval in ODK open", async () => {
    const id = seedDeployment("CCN-004_V2", {
      odkSubmissionId: "uuid:CCN-004_V2",
      dateStart: "2026-09-22",
    });
    odk.installs = [install("CCN-004_V2", "2026-09-22")];

    const result = await relink();

    expect(dateEndOf(id)).toBeNull();
    expect(result.datesFilled).toBe(0);
  });

  it("never touches a complete deployment, even one with a manual date ODK disagrees with", async () => {
    const id = seedDeployment("CCN-001_V1", {
      odkSubmissionId: "uuid:CCN-001_V1",
      dateStart: "2026-02-18",
      dateEnd: "2026-03-20",
      metadataSource: "manual",
    });
    odk.retrievals = [retrieval("CCN-001_V1", "2026-03-19")];

    const result = await relink();

    expect(dateEndOf(id)).toBe("2026-03-20");
    expect(result).toEqual({ checked: 0, matched: 0, datesFilled: 0 });
  });

  it("is a no-op the second night", async () => {
    seedDeployment("CCN-006_V1", {
      odkSubmissionId: "uuid:CCN-006_V1",
      dateStart: "2026-06-21",
    });
    odk.installs = [install("CCN-006_V1", "2026-06-21")];
    odk.retrievals = [retrieval("CCN-006_V1", "2026-07-21")];

    await relink();
    expect(await relink()).toEqual({ checked: 0, matched: 0, datesFilled: 0 });
  });
});
