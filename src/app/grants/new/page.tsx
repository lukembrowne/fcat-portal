import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getFunderOptions } from "../actions";
import { GrantForm } from "../grant-form";

export default async function NewGrantPage() {
  await requirePermission("grants", "editor");
  const funderOptions = await getFunderOptions();

  return (
    <div className="space-y-6">
      <div>
        <Link href="/grants" className="text-sm text-muted-foreground hover:underline">
          ← Grants
        </Link>
        <h2 className="text-xl font-bold mt-1">Add Grant</h2>
      </div>
      <GrantForm
        funderOptions={funderOptions}
        initial={{
          name: "",
          projectTitle: null,
          funderId: null,
          funderNameRaw: null,
          website: null,
          status: "to_research",
          amountRequested: null,
          amountAwarded: null,
          fundingEntity: null,
          dueDate: null,
          startDate: null,
          endDate: null,
          notes: null,
          folderLink: null,
          budgetLink: null,
          proposalLink: null,
        }}
      />
    </div>
  );
}
