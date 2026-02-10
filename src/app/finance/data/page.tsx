import { requirePermission } from "@/lib/auth";
import { fetchLastUploads } from "./actions";
import { UploadShell } from "./upload-shell";

export default async function FinanceDataPage() {
  await requirePermission("finance", "admin");

  const result = await fetchLastUploads();

  const lastUploads = result.success ? result.data : {};

  return <UploadShell lastUploads={lastUploads} />;
}
