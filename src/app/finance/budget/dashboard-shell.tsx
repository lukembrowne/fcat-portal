"use client";

import { MetricsRow } from "./metrics-row";
import { BudgetTable } from "./budget-table";
import { UnlinkedTables } from "./unlinked-tables";
import type { BudgetData } from "./actions";

export function DashboardShell({ data }: { data: BudgetData }) {
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
      {(data.unlinkedAccounting.length > 0 ||
        data.unlinkedBudget.length > 0) && (
        <UnlinkedTables
          unlinkedAccounting={data.unlinkedAccounting}
          unlinkedBudget={data.unlinkedBudget}
        />
      )}
    </div>
  );
}
