/**
 * Cloudflare Turnstile verification for public forms.
 *
 * In dev without TURNSTILE_SECRET, bypasses verification.
 */

interface TurnstileResult {
  success: boolean;
  error?: string;
}

export async function verifyTurnstile(
  token: string | null,
  remoteIp: string | null
): Promise<TurnstileResult> {
  const secret = process.env.TURNSTILE_SECRET;

  // Dev bypass: no secret configured
  if (!secret) {
    return { success: true };
  }

  if (!token) {
    return { success: false, error: "Verificación requerida" };
  }

  const body = new URLSearchParams({
    secret,
    response: token,
    ...(remoteIp ? { remoteip: remoteIp } : {}),
  });

  try {
    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body }
    );

    const data = (await res.json()) as { success: boolean; "error-codes"?: string[] };

    if (!data.success) {
      return {
        success: false,
        error: "Verificación fallida",
      };
    }

    return { success: true };
  } catch {
    return { success: false, error: "Error de verificación" };
  }
}
