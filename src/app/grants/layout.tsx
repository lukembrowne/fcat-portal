import { TooltipProvider } from "@/components/ui/tooltip";
import { GrantsNav } from "./grants-nav";

export default function GrantsLayout({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Grant Tracking</h1>
          <p className="text-muted-foreground">Grants pipeline, funders, and deadlines</p>
        </div>
        <GrantsNav />
        {children}
      </div>
    </TooltipProvider>
  );
}
