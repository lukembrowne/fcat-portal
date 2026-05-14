/**
 * Temporary redirect — the species browser ("Explorar por especie") lands here
 * in Phase 2 of the species-detection-browser plan. Until then, redirect to
 * the moved CRUD page so existing bookmarks still work.
 *
 * Replace this file with the real index page when Phase 2 ships.
 */

import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth";

export default async function SpeciesPage() {
  await requirePermission("camera-trap", "viewer");
  redirect("/camera-trap/species/manage");
}
