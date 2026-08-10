import { describe, expect, it } from "vitest";
import {
  daysBetween,
  runChecks,
  summarizeFindings,
  type ReviewDeployment,
} from "@/lib/biochoco-review-checks";

const TODAY = "2026-06-16";

/** A clean baseline deployment that triggers NO findings. */
function makeDeployment(
  over: Partial<ReviewDeployment> = {}
): ReviewDeployment {
  return {
    deploymentId: "SEC-001_V1",
    siteId: "SEC-001",
    siteName: "Sitio 1",
    habitat: "primary_forest",
    season: "dry",
    lifecycle: "retrieved",
    excluded: false,
    plannedDeployDate: "2026-04-01",
    plannedRetrieveDate: "2026-05-01",
    actualDeployDate: "2026-04-01",
    actualRetrieveDate: "2026-05-01",
    latitude: 0.1,
    longitude: -78.9,
    expectedTypes: ["camera", "audio", "ibutton"],
    expectedTypesSource: "folders",
    counts: { camera: 100, audio: 200, ibutton: 1 },
    countsCheckedAt: 1_700_000_000,
    recountError: null,
    newestUploadDate: "2026-05-01",
    processingStatus: "verified",
    failedJobs: 0,
    failedImages: 0,
    ibuttonRowsImported: 4000,
    ibuttonCoveragePct: 99,
    cameraOutOfWindow: false,
    cameraFilesOutsideWindow: 0,
    fieldNotes: null,
    ...over,
  };
}

const opts = { today: TODAY };

describe("daysBetween", () => {
  it("computes whole-day differences", () => {
    expect(daysBetween("2026-06-16", "2026-05-01")).toBe(46);
    expect(daysBetween("2026-06-16", "2026-06-16")).toBe(0);
    expect(daysBetween("2026-05-01", "2026-06-16")).toBe(-46);
  });
  it("returns null for unparseable input", () => {
    expect(daysBetween("not-a-date", "2026-06-16")).toBeNull();
  });
});

describe("clean deployment", () => {
  it("produces no findings", () => {
    expect(runChecks([makeDeployment()], opts)).toEqual([]);
  });
});

describe("excluded deployments", () => {
  it("are skipped entirely even when broken", () => {
    const d = makeDeployment({
      excluded: true,
      latitude: null,
      longitude: null,
      counts: { camera: 0, audio: 0, ibutton: 0 },
    });
    expect(runChecks([d], opts)).toEqual([]);
  });
});

describe("overdue retrieval (check 1)", () => {
  it("flags installed-but-not-retrieved past the planned date", () => {
    const d = makeDeployment({
      lifecycle: "deployed",
      actualRetrieveDate: null,
      plannedRetrieveDate: "2026-05-12", // 35 days ago
    });
    const f = runChecks([d], opts).find((x) => x.check === "overdue_retrieval");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("error"); // > 14 days
    expect(f!.evidence.daysOverdue).toBe(35);
  });

  it("uses warn within the error-day threshold", () => {
    const d = makeDeployment({
      lifecycle: "deployed",
      actualRetrieveDate: null,
      plannedRetrieveDate: "2026-06-10", // 6 days ago
    });
    const f = runChecks([d], opts).find((x) => x.check === "overdue_retrieval");
    expect(f!.severity).toBe("warn");
  });

  it("does not flag scheduled (never-installed) deployments", () => {
    const d = makeDeployment({
      lifecycle: "scheduled",
      actualDeployDate: null,
      actualRetrieveDate: null,
      plannedRetrieveDate: "2026-05-12",
    });
    expect(
      runChecks([d], opts).some((x) => x.check === "overdue_retrieval")
    ).toBe(false);
  });

  it("does not flag already-retrieved deployments", () => {
    const d = makeDeployment({ plannedRetrieveDate: "2026-05-01" });
    expect(
      runChecks([d], opts).some((x) => x.check === "overdue_retrieval")
    ).toBe(false);
  });
});

describe("overdue installation (check 2)", () => {
  it("flags scheduled deployments past the planned deploy date", () => {
    const d = makeDeployment({
      lifecycle: "scheduled",
      actualDeployDate: null,
      actualRetrieveDate: null,
      plannedDeployDate: "2026-04-01",
      latitude: 0.1,
      longitude: -78.9,
    });
    const f = runChecks([d], opts).find(
      (x) => x.check === "overdue_installation"
    );
    expect(f).toBeDefined();
    expect(f!.severity).toBe("error");
  });
});

describe("retrieved but no data (check 3)", () => {
  it("flags as error when nothing was ever scanned (genuine no-data)", () => {
    const d = makeDeployment({
      counts: { camera: 0, audio: 0, ibutton: 0 },
      processingStatus: "unscanned",
    });
    const f = runChecks([d], opts).find((x) => x.check === "retrieved_no_data");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("error");
    expect(f!.subtype).toBeUndefined();
  });

  it("treats null counts as zero", () => {
    const d = makeDeployment({
      counts: { camera: null, audio: null, ibutton: null },
      processingStatus: "unscanned",
    });
    expect(
      runChecks([d], opts).some((x) => x.check === "retrieved_no_data")
    ).toBe(true);
  });

  it("downgrades to a count/DB mismatch warning when images were already scanned", () => {
    // Stale cached count can read 0 even though the camera pipeline found images.
    for (const status of ["scanned", "processed", "verified", "verified_empty"] as const) {
      const d = makeDeployment({
        counts: { camera: 0, audio: 0, ibutton: 0 },
        processingStatus: status,
      });
      const f = runChecks([d], opts).find(
        (x) => x.check === "retrieved_no_data"
      );
      expect(f, status).toBeDefined();
      expect(f!.severity, status).toBe("warn");
      expect(f!.subtype, status).toBe("count_db_mismatch");
    }
  });

  it("does not fire when re-count failed (that's check 6 instead)", () => {
    const d = makeDeployment({
      counts: { camera: 0, audio: 0, ibutton: 0 },
      recountError: "rate limited",
    });
    const ids = runChecks([d], opts).map((x) => x.check);
    expect(ids).not.toContain("retrieved_no_data");
    expect(ids).toContain("recount_failed");
  });

  it("downgrades to info when the camera was marked 'Sin datos' in the portal", () => {
    const d = makeDeployment({
      counts: { camera: 0, audio: 0, ibutton: 0 },
      processingStatus: "no_data",
    });
    const findings = runChecks([d], opts).filter(
      (x) => x.check === "retrieved_no_data"
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("info");
    expect(findings[0].subtype).toBe("camera_marked_no_data");
  });
});

describe("partial upload (check 4)", () => {
  it("flags when some expected types are present and some missing", () => {
    const d = makeDeployment({
      counts: { camera: 100, audio: 0, ibutton: 1 },
    });
    const f = runChecks([d], opts).find((x) => x.check === "partial_upload");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("warn");
    expect(f!.evidence.missing).toEqual(["audio"]);
  });

  it("does not flag when ALL expected types are missing (that's check 3)", () => {
    const d = makeDeployment({ counts: { camera: 0, audio: 0, ibutton: 0 } });
    expect(runChecks([d], opts).some((x) => x.check === "partial_upload")).toBe(
      false
    );
  });

  it("respects expectedTypes — no finding when the missing type wasn't expected", () => {
    const d = makeDeployment({
      expectedTypes: ["camera", "audio"],
      expectedTypesSource: "folders",
      counts: { camera: 100, audio: 200, ibutton: 0 },
    });
    expect(runChecks([d], opts).some((x) => x.check === "partial_upload")).toBe(
      false
    );
  });

  it("softens to info when expectation is only a fallback guess", () => {
    const d = makeDeployment({
      expectedTypesSource: "fallback-all",
      counts: { camera: 100, audio: 0, ibutton: 0 },
    });
    const f = runChecks([d], opts).find((x) => x.check === "partial_upload");
    expect(f!.severity).toBe("info");
  });
});

describe("missing coordinates (check 5)", () => {
  it("flags null latitude/longitude, error when deployed", () => {
    const d = makeDeployment({ latitude: null, longitude: -78.9 });
    const f = runChecks([d], opts).find(
      (x) => x.check === "missing_coordinates"
    );
    expect(f).toBeDefined();
    expect(f!.severity).toBe("error"); // retrieved → escalated
  });

  it("warns (not errors) for scheduled deployments", () => {
    const d = makeDeployment({
      lifecycle: "scheduled",
      actualDeployDate: null,
      actualRetrieveDate: null,
      latitude: null,
      longitude: null,
    });
    const f = runChecks([d], opts).find(
      (x) => x.check === "missing_coordinates"
    );
    expect(f!.severity).toBe("warn");
  });
});

describe("files outside window (check 7)", () => {
  it("flags camera images outside the deployment window", () => {
    const d = makeDeployment({
      cameraOutOfWindow: true,
      cameraFilesOutsideWindow: 12,
    });
    const f = runChecks([d], opts).find(
      (x) => x.check === "files_outside_window"
    );
    expect(f).toBeDefined();
    expect(f!.summary).toContain("12");
  });
});

describe("processing health (check 8)", () => {
  it("flags failed images", () => {
    const d = makeDeployment({ failedImages: 7 });
    const f = runChecks([d], opts).find(
      (x) => x.subtype === "processing_failures"
    );
    expect(f).toBeDefined();
  });

  it("flags low iButton coverage", () => {
    const d = makeDeployment({ ibuttonCoveragePct: 80 });
    const f = runChecks([d], opts).find(
      (x) => x.subtype === "ibutton_low_coverage"
    );
    expect(f).toBeDefined();
    expect(f!.summary).toContain("80%");
  });

  it("emits info for processed-but-unverified deployments", () => {
    const d = makeDeployment({ processingStatus: "processed" });
    const f = runChecks([d], opts).find(
      (x) => x.subtype === "awaiting_verification"
    );
    expect(f).toBeDefined();
    expect(f!.severity).toBe("info");
  });

  it("does not flag verified_empty as awaiting verification", () => {
    const d = makeDeployment({ processingStatus: "verified_empty" });
    expect(
      runChecks([d], opts).some((x) => x.subtype === "awaiting_verification")
    ).toBe(false);
  });
});

describe("summarizeFindings", () => {
  it("counts by severity and check", () => {
    const deps = [
      makeDeployment({
        counts: { camera: 0, audio: 0, ibutton: 0 },
        processingStatus: "unscanned",
      }), // retrieved_no_data (error)
      makeDeployment({ latitude: null, longitude: null }), // missing_coordinates (error)
    ];
    const s = summarizeFindings(runChecks(deps, opts));
    expect(s.error).toBeGreaterThanOrEqual(2);
    expect(s.byCheck["retrieved_no_data"]).toBe(1);
  });
});
