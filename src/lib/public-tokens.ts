/**
 * Shared validation for public share tokens.
 *
 * Public share links (camera-trap deployment shares and biochoco site
 * shares) are addressed by a UUID v4. Centralizing the regex avoids
 * three slightly-different copies drifting across route handlers.
 */

export const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidShareToken(token: unknown): token is string {
  return typeof token === "string" && UUID_V4_REGEX.test(token);
}
