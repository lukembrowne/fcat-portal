import { Badge } from "@/components/ui/badge";
import type { AuthUser } from "@/lib/types";

interface UserBadgeProps {
  user: AuthUser;
}

export function UserBadge({ user }: UserBadgeProps) {
  const displayName = user.name || user.email.split("@")[0];

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground hidden sm:inline">
        {displayName}
      </span>
      {user.globalRole === "super_admin" && (
        <Badge variant="secondary" className="text-xs">
          Admin
        </Badge>
      )}
    </div>
  );
}
