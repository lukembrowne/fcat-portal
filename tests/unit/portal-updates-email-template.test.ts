/**
 * Unit tests for the "Instalaciones verificadas" block in the portal-updates
 * email template. Pure rendering — no DB.
 */

import { describe, it, expect } from "vitest";
import {
  buildPortalActivityDetail,
  buildPortalUpdatesBody,
} from "@/lib/portal-updates/email-template";
import type {
  PortalUpdatesPayload,
  VerifiedDeploymentRow,
} from "@/lib/portal-updates/types";

const WINDOW_START = new Date("2026-06-27T05:00:00Z");
const WINDOW_END = new Date("2026-06-28T05:00:00Z");

function payload(
  overrides: Partial<PortalUpdatesPayload> = {},
): PortalUpdatesPayload {
  return {
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    projects: [],
    verifiedDeployments: [],
    totalCtJobs: 0,
    totalAudioJobs: 0,
    totalCtVerifiedImages: 0,
    totalAudioVerifiedFiles: 0,
    ...overrides,
  };
}

const verified: VerifiedDeploymentRow[] = [
  {
    deploymentId: 121,
    deploymentName: "CCN-013_V1",
    actorEmail: "monitoreo@fcat-ecuador.org",
    empty: false,
    occurredAt: new Date("2026-06-27T16:58:00Z"),
  },
  {
    deploymentId: 98,
    deploymentName: "GIZ-004_V1",
    actorEmail: null,
    empty: true,
    occurredAt: new Date("2026-06-27T18:00:00Z"),
  },
];

describe("renderVerifiedDeploymentsBlock (via buildPortalActivityDetail)", () => {
  it("renders a table with deployment, actor, and type", () => {
    const html = buildPortalActivityDetail(payload({ verifiedDeployments: verified }));
    expect(html).toContain("Instalaciones verificadas (2)");
    expect(html).toContain("CCN-013_V1");
    // deployment name links to the camera-trap annotation page
    expect(html).toContain(
      'href="https://portal.fcat-ecuador.org/camera-trap/121"',
    );
    expect(html).toContain("monitoreo@fcat-ecuador.org");
    expect(html).toContain("Verificada");
    // verified_empty row: muted "Vacía" label + "—" actor fallback
    expect(html).toContain("GIZ-004_V1");
    expect(html).toContain("Vacía");
    expect(html).toContain("—");
  });

  it("omits the block (and returns empty detail) when nothing is verified and no projects", () => {
    expect(buildPortalActivityDetail(payload())).toBe("");
  });

  it("falls back to #id when the deployment name is missing", () => {
    const html = buildPortalActivityDetail(
      payload({
        verifiedDeployments: [
          { deploymentId: 7, deploymentName: "", actorEmail: "a@x.com", empty: false, occurredAt: WINDOW_END },
        ],
      }),
    );
    expect(html).toContain("#7");
    // still links even when falling back to the #id label
    expect(html).toContain(
      'href="https://portal.fcat-ecuador.org/camera-trap/7"',
    );
  });

  it("includes the block in the standalone activity body too", () => {
    const html = buildPortalUpdatesBody(payload({ verifiedDeployments: verified }));
    expect(html).toContain("Instalaciones verificadas (2)");
  });
});
