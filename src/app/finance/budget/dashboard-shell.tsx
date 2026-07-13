"use client";

import { MetricsRow } from "./metrics-row";
import { BudgetTable } from "./budget-table";
import { UnlinkedBudgetCard } from "./unlinked-tables";
import { CategoryLinkEditor } from "./category-link-editor";
import type { BudgetData, CategoryLinkEditorData } from "./actions";

export function DashboardShell({
  data,
  editor,
}: {
  data: BudgetData;
  editor: CategoryLinkEditorData | null;
}) {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Presupuesto</h1>
      <MetricsRow
        totalSpent={data.totalSpent}
        totalBudgetProrated={data.totalBudgetProrated}
        totalBudgetAnnual={data.totalBudgetAnnual}
        isOverBudget={data.isOverBudget}
        overUnderAmount={data.overUnderAmount}
      />
      <BudgetTable rows={data.budgetRows} />
      {editor && (
        <CategoryLinkEditor
          rows={editor.rows}
          budgetCategoryOptions={editor.budgetCategoryOptions}
        />
      )}
      {data.unlinkedBudget.length > 0 && (
        <UnlinkedBudgetCard unlinkedBudget={data.unlinkedBudget} />
      )}
    </div>
  );
}
