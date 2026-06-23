import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { FunderForm } from "../funder-form";

export default async function NewFunderPage() {
  await requirePermission("grants", "editor");
  return (
    <div className="space-y-6">
      <div>
        <Link href="/grants/funders" className="text-sm text-muted-foreground hover:underline">
          ← Funders
        </Link>
        <h2 className="text-xl font-bold mt-1">Add Funder</h2>
      </div>
      <FunderForm
        initial={{
          name: "",
          website: null,
          priority: null,
          funderType: null,
          focusAreas: null,
          relationshipManager: null,
          relationshipStatus: null,
          nextSteps: null,
          nextStepDue: null,
          contactName: null,
          contactEmail: null,
          fundingHistory: null,
          description: null,
          notes: null,
          irs990Link: null,
          guidestarLink: null,
          foundationDirectoryLink: null,
        }}
      />
    </div>
  );
}
