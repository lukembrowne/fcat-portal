"use server";

import { eq, desc, asc, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
  researchApplications,
  researchReports,
  type ResearchApplicationStatus,
} from "@/db/schema";
import { requirePermission } from "@/lib/auth";


export interface ApplicationListItem {
  id: number;
  referenceCode: string | null;
  projectTitle: string;
  piFullName: string;
  piInstitution: string | null;
  status: ResearchApplicationStatus;
  primaryReviewerEmail: string | null;
  finalReportDueDate: string | null;
  hasReport: boolean;
  createdAt: Date;
}

const SORTABLE_COLUMNS = {
  code: researchApplications.referenceCode,
  project: researchApplications.projectTitle,
  researcher: researchApplications.piFullName,
  status: researchApplications.status,
  reviewer: researchApplications.primaryReviewerEmail,
  report: researchApplications.finalReportDueDate,
  date: researchApplications.createdAt,
} as const;

export type SortColumn = keyof typeof SORTABLE_COLUMNS;
export type SortDirection = "asc" | "desc";

export async function getApplications(filters?: {
  status?: string;
  search?: string;
  sortBy?: string;
  sortDir?: string;
}): Promise<ApplicationListItem[]> {
  await requirePermission("researcher-applications", "viewer");

  let query = db
    .select({
      id: researchApplications.id,
      referenceCode: researchApplications.referenceCode,
      projectTitle: researchApplications.projectTitle,
      piFullName: researchApplications.piFullName,
      piInstitution: researchApplications.piInstitution,
      status: researchApplications.status,
      primaryReviewerEmail: researchApplications.primaryReviewerEmail,
      finalReportDueDate: researchApplications.finalReportDueDate,
      createdAt: researchApplications.createdAt,
    })
    .from(researchApplications)
    .$dynamic();

  if (filters?.status && filters.status !== "all") {
    query = query.where(
      eq(researchApplications.status, filters.status as ResearchApplicationStatus)
    );
  }

  if (filters?.search) {
    const term = `%${filters.search}%`;
    query = query.where(
      sql`(${researchApplications.projectTitle} LIKE ${term} OR ${researchApplications.piFullName} LIKE ${term} OR ${researchApplications.referenceCode} LIKE ${term})`
    );
  }

  const sortCol = filters?.sortBy as SortColumn | undefined;
  const sortDir = filters?.sortDir === "asc" ? "asc" : "desc";
  const column = sortCol && sortCol in SORTABLE_COLUMNS
    ? SORTABLE_COLUMNS[sortCol]
    : researchApplications.createdAt;
  const orderFn = sortDir === "asc" ? asc : desc;

  const rows = query.orderBy(orderFn(column)).all();

  // Check which applications have reports
  const reportAppIds = new Set(
    db
      .select({ applicationId: researchReports.applicationId })
      .from(researchReports)
      .all()
      .map((r: { applicationId: number }) => r.applicationId)
  );

  return rows.map((r) => ({
    ...r,
    hasReport: reportAppIds.has(r.id),
  }));
}
