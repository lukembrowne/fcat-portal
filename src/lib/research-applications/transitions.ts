import type { ResearchApplicationStatus } from "@/db/schema";

/**
 * Valid status transitions for researcher applications.
 *
 * submitted → under_review → accepted | rejected | revisions_requested
 * revisions_requested → under_review (resubmit cycle)
 */
const VALID_TRANSITIONS = {
  submitted: ["under_review"],
  under_review: ["accepted", "rejected", "revisions_requested"],
  accepted: ["under_review"],
  rejected: ["under_review"],
  revisions_requested: ["under_review"],
} as const satisfies Record<ResearchApplicationStatus, readonly ResearchApplicationStatus[]>;

export function getValidTransitions(
  from: ResearchApplicationStatus
): readonly ResearchApplicationStatus[] {
  return VALID_TRANSITIONS[from];
}

export function isValidTransition(
  from: ResearchApplicationStatus,
  to: ResearchApplicationStatus
): boolean {
  return (VALID_TRANSITIONS[from] as readonly string[]).includes(to);
}

export function assertTransition(
  from: ResearchApplicationStatus,
  to: ResearchApplicationStatus
): void {
  if (!isValidTransition(from, to)) {
    throw new Error(
      `Transición inválida: ${from} → ${to}. Transiciones válidas: ${VALID_TRANSITIONS[from].join(", ") || "ninguna"}`
    );
  }
}

/** Spanish labels for display */
export const STATUS_LABELS: Record<ResearchApplicationStatus, string> = {
  submitted: "Enviada",
  under_review: "En revisión",
  accepted: "Aceptada",
  rejected: "Rechazada",
  revisions_requested: "Revisiones solicitadas",
};
