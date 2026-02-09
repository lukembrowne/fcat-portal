import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";

export function TopHeader() {
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-4 bg-background">
      <SidebarTrigger className="-ml-1 text-muted-foreground hover:text-foreground" />
      <Separator orientation="vertical" className="mr-2 h-4! bg-border/60" />
      <span className="text-sm text-muted-foreground">
        Portal FCAT
      </span>
    </header>
  );
}
