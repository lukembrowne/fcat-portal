"use server";

import { headers } from "next/headers";
import { isValidShareToken } from "@/lib/public-tokens";
import { rateLimitAllow } from "@/lib/simple-rate-limit";
import { resolveLandownerForToken } from "@/lib/landowner/site-landowner";
import { sendLandownerContactEmail } from "@/lib/landowner/contact-email";
import { recordEvent } from "@/lib/system-events";
import type { ActionResult } from "@/lib/types";

const MESSAGE_MAX_LENGTH = 2000;
const RATE_LIMIT = 5; // submissions
const RATE_WINDOW_MS = 60_000; // per minute per token+ip

/**
 * Public landowner contact form. No auth — abuse-hardened with a honeypot,
 * a per-token+IP rate limit, and a message-length cap (no captcha, by design).
 * Emails the BioChoco team with a click-to-WhatsApp reply link; landowner
 * identity is resolved server-side and never returned to the client.
 */
export async function submitLandownerContact(
  formData: FormData,
): Promise<ActionResult> {
  // Honeypot — silent fake-success so bots don't learn they were caught.
  if (formData.get("website")) {
    return { success: true, data: undefined };
  }

  const token = formData.get("token");
  if (typeof token !== "string" || !isValidShareToken(token)) {
    return { success: false, error: "Enlace no válido." };
  }

  const headerList = await headers();
  const ip =
    headerList.get("x-real-ip") ??
    headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";

  if (!rateLimitAllow(`contact:${token}:${ip}`, RATE_LIMIT, RATE_WINDOW_MS)) {
    return {
      success: false,
      error: "Has enviado demasiados mensajes. Intenta de nuevo en unos minutos.",
    };
  }

  const rawMessage = formData.get("message");
  const message = typeof rawMessage === "string" ? rawMessage.trim() : "";
  if (!message) {
    return { success: false, error: "Escribe un mensaje antes de enviar." };
  }
  if (message.length > MESSAGE_MAX_LENGTH) {
    return {
      success: false,
      error: `El mensaje es demasiado largo (máximo ${MESSAGE_MAX_LENGTH} caracteres).`,
    };
  }

  const prefersCall = formData.get("prefersCall") === "on";

  // Resolve landowner server-side (also re-validates the token is active).
  const landowner = await resolveLandownerForToken(token);
  if (!landowner) {
    return { success: false, error: "Enlace no válido." };
  }

  const sent = await sendLandownerContactEmail({
    siteId: landowner.siteId,
    message,
    prefersCall,
    landownerName: landowner.landownerName,
    landownerPhone: landowner.landownerPhone,
  });
  if (!sent) {
    return {
      success: false,
      error: "No pudimos enviar tu mensaje. Por favor intenta más tarde.",
    };
  }

  await recordEvent({
    source: "biochoco-resultados",
    eventType: "landowner_contact_submitted",
    summary: `Mensaje de propietario para sitio ${landowner.siteId}`,
    actorEmail: null,
    projectId: "biochoco",
    targetType: "biochoco_site",
    targetId: landowner.siteId,
    details: {
      prefersCall,
      messageLength: message.length,
      hasPhone: Boolean(landowner.landownerPhone),
    },
  });

  return { success: true, data: undefined };
}
