"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, TreePine, Leaf, Camera, Shield, DollarSign } from "lucide-react";
import type { AuthUser } from "@/lib/types";
import type { IconName, NavItem, NavSection } from "@/components/sidebar-nav";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";

const ICONS: Record<IconName, React.ComponentType<{ className?: string }>> = {
  home: Home,
  "tree-pine": TreePine,
  leaf: Leaf,
  camera: Camera,
  shield: Shield,
  "dollar-sign": DollarSign,
};

function NavIcon({ name }: { name?: IconName }) {
  if (!name) return null;
  const Icon = ICONS[name];
  return Icon ? <Icon /> : null;
}

interface SidebarShellProps {
  sections: NavSection[];
  user: AuthUser;
}

/**
 * Finds the active nav item using longest-prefix matching.
 * For "/" (home), uses exact match only to avoid matching every route.
 */
function findActiveHref(pathname: string, sections: NavSection[]): string | null {
  let bestMatch: string | null = null;
  let bestLength = 0;

  function checkItem(item: NavItem) {
    if (item.href) {
      if (item.href === "/") {
        if (pathname === "/") {
          bestMatch = "/";
          bestLength = Infinity;
        }
      } else if (pathname.startsWith(item.href) && item.href.length > bestLength) {
        bestMatch = item.href;
        bestLength = item.href.length;
      }
    }
    item.children?.forEach(checkItem);
  }

  sections.forEach((section) => section.items.forEach(checkItem));
  return bestMatch;
}

function NavLink({
  item,
  activeHref,
}: {
  item: NavItem;
  activeHref: string | null;
}) {
  const { setOpenMobile, isMobile } = useSidebar();

  function handleClick() {
    if (isMobile) {
      setOpenMobile(false);
    }
  }

  // Top-level item with a direct href
  if (item.href && !item.children) {
    const isActive = activeHref === item.href;
    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          asChild
          isActive={isActive}
          tooltip={item.label}
        >
          <Link href={item.href} onClick={handleClick}>
            <NavIcon name={item.icon} />
            <span>{item.label}</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }

  // Group item with children
  if (item.children) {
    return (
      <SidebarMenuItem>
        {item.href ? (
          <SidebarMenuButton
            asChild
            isActive={false}
            tooltip={item.label}
          >
            <Link href={item.href} onClick={handleClick}>
              <NavIcon name={item.icon} />
              <span>{item.label}</span>
            </Link>
          </SidebarMenuButton>
        ) : (
          <SidebarMenuButton tooltip={item.label}>
            <NavIcon name={item.icon} />
            <span>{item.label}</span>
          </SidebarMenuButton>
        )}
        <SidebarMenuSub>
          {item.children.map((child) => (
            <SubNavItem
              key={child.label}
              item={child}
              activeHref={activeHref}
              onNavigate={handleClick}
            />
          ))}
        </SidebarMenuSub>
      </SidebarMenuItem>
    );
  }

  return null;
}

function SubNavItem({
  item,
  activeHref,
  onNavigate,
}: {
  item: NavItem;
  activeHref: string | null;
  onNavigate: () => void;
}) {
  if (item.href && !item.children) {
    const isActive = activeHref === item.href;
    return (
      <SidebarMenuSubItem>
        <SidebarMenuSubButton asChild isActive={isActive}>
          <Link href={item.href} onClick={onNavigate}>
            <NavIcon name={item.icon} />
            <span>{item.label}</span>
          </Link>
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>
    );
  }

  if (item.children) {
    return (
      <SidebarMenuSubItem>
        <SidebarMenuSubButton className="font-medium text-sidebar-foreground/70 pointer-events-none">
          <NavIcon name={item.icon} />
          <span>{item.label}</span>
        </SidebarMenuSubButton>
        <SidebarMenuSub>
          {item.children.map((child) => (
            <SubNavItem
              key={child.label}
              item={child}
              activeHref={activeHref}
              onNavigate={onNavigate}
            />
          ))}
        </SidebarMenuSub>
      </SidebarMenuSubItem>
    );
  }

  return null;
}

export function SidebarShell({ sections, user }: SidebarShellProps) {
  const pathname = usePathname();
  const activeHref = findActiveHref(pathname, sections);
  const displayName = user.name || user.email.split("@")[0];

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border pb-3">
        <Link href="/" className="flex items-center gap-3 px-1 group-data-[collapsible=icon]:justify-center">
          <Image
            src="/logo-fcat.png"
            alt="FCAT"
            width={36}
            height={36}
            className="shrink-0 group-data-[collapsible=icon]:w-7 group-data-[collapsible=icon]:h-7 transition-all"
          />
          <div className="flex flex-col group-data-[collapsible=icon]:hidden">
            <span className="font-semibold text-sm text-sidebar-foreground leading-tight">
              Portal FCAT
            </span>
            <span className="text-[11px] text-sidebar-foreground/50 leading-tight">
              Plataforma interna
            </span>
          </div>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        {sections.map((section) => (
          <SidebarGroup key={section.title}>
            <SidebarGroupLabel className="uppercase tracking-wider text-xs font-semibold text-sidebar-foreground/60">
              {section.title}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {section.items.map((item) => (
                  <NavLink
                    key={item.label}
                    item={item}
                    activeHref={activeHref}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <div className="flex items-center gap-2 px-1 py-1 group-data-[collapsible=icon]:justify-center">
          <div className="flex items-center justify-center w-7 h-7 rounded-full bg-sidebar-accent text-sidebar-accent-foreground text-xs font-medium shrink-0">
            {displayName.charAt(0).toUpperCase()}
          </div>
          <div className="flex flex-col group-data-[collapsible=icon]:hidden min-w-0">
            <span className="text-sm text-sidebar-foreground truncate">{displayName}</span>
            <span className="text-[11px] text-sidebar-foreground/50 truncate">{user.email}</span>
          </div>
          {user.globalRole === "super_admin" && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 ml-auto group-data-[collapsible=icon]:hidden bg-sidebar-accent text-sidebar-accent-foreground border-0">
              Admin
            </Badge>
          )}
        </div>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
