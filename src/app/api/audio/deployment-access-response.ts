/**
 * Maps a failed deployment access check to the right HTTP response for the
 * validation clip/spectrogram routes.
 *
 * A module of its own (not `validation-clip-shared.ts`) so route tests that
 * mock the sample loader still run this mapping for real.
 */

import { NextResponse } from "next/server";

import {
  DeploymentAccessDeniedError,
  DeploymentNotFoundError,
} from "@/lib/deployment-access-errors";
import { log } from "@/lib/log";

/**
 * Run `requireDeploymentAccess` for a clip route and map its failure to the
 * right response: 403 only for an access denial, 404 for a deployment that no
 * longer exists, and anything else (a DB error, say) logged and returned as a
 * 500 — never silently reported as "no access".
 *
 * Returns null when access is granted.
 */
export async function deploymentAccessFailure(
  check: () => Promise<void>,
  logTag: string,
  sampleId: number
): Promise<NextResponse | null> {
  try {
    await check();
    return null;
  } catch (err) {
    if (err instanceof DeploymentAccessDeniedError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof DeploymentNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    log.error({ err, sampleId }, `${logTag} access check failed`);
    return NextResponse.json(
      { error: "Error al verificar el acceso" },
      { status: 500 }
    );
  }
}
