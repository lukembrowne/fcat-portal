import { requirePermission } from "@/lib/auth";
import { fetchLastClimateUploads } from "./actions";
import { ClimateUploadShell } from "./upload-shell";

export default async function ClimateUploadPage() {
  await requirePermission("climate", "editor");

  const result = await fetchLastClimateUploads();
  const lastUploads = result.success
    ? result.data
    : { hourly: null, "15min": null };

  return <ClimateUploadShell lastUploads={lastUploads} />;
}
