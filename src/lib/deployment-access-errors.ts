/**
 * Typed failures of `requireDeploymentAccess` (`@/lib/camera-trap-auth`).
 *
 * Kept in a dependency-free module so a route can tell "no such deployment"
 * (404) from "not your project" (403) from anything else (500) by type, and so
 * tests that mock `camera-trap-auth` still get the real classes. The messages
 * are unchanged from the plain `Error`s they replace, so existing callers that
 * surface `error.message` read the same Spanish text.
 */

export class DeploymentNotFoundError extends Error {
  constructor() {
    super("Instalación no encontrada");
    this.name = "DeploymentNotFoundError";
  }
}

export class DeploymentAccessDeniedError extends Error {
  constructor() {
    super("No tienes acceso a este proyecto");
    this.name = "DeploymentAccessDeniedError";
  }
}
