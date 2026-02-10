---
title: "feat: Sidebar Navigation Revamp"
type: feat
date: 2026-02-09
---

# Sidebar Navigation Revamp

## Overview

Replace the horizontal header navigation with a collapsible sidebar navigation. The sidebar organizes content by project with always-visible sub-modules, replaces the in-page SubNav tab bars, and nests Camera Trap under BioChocó. A thin top header bar remains for branding, sidebar toggle, and user info.

## Problem Statement / Motivation

The current horizontal header nav is flat — all projects (GIZ, BioChocó, Cámaras Trampa) appear as top-level links, and sub-modules within projects use separate horizontal tab bars inside each section. As the portal grows (more projects, future wiki section), this structure doesn't scale well. The tab-based sub-navigation feels disconnected from the main nav and takes up vertical page space.

A sidebar provides:
- Clear project hierarchy (projects → sub-modules)
- Room for growth (wiki, more projects)
- Persistent navigation context (users always see where they are)
- Less vertical space wasted on per-section tab bars

## Proposed Solution

### Sidebar Structure

```
┌──────────────────────┐
│  PROYECTOS           │  ← section header
│  ● Inicio            │
│  ▾ GIZ               │
│    ├ Siembra de Árb.  │
│    └ Monitoreo Cacao  │
│  ▾ BioChocó          │
│    ├ Resumen          │
│    ├ Herramientas *   │  ← editor/admin only
│    └ ▾ Cámaras Trampa │  ← separate permissions
│      ├ Dashboard      │
│      ├ Resultados     │
│      └ Anotaciones    │
│                       │
│  ADMINISTRACIÓN **    │  ← super_admin only
│  ● Panel de Admin     │
└───────────────────────┘
```

### Visual Layout

**Desktop (≥ lg breakpoint):**
```
┌──────────────────────────────────────────┐
│ [☰] Portal FCAT              [User] [A] │  ← thin top header
├─────────┬────────────────────────────────┤
│ Sidebar │       Content Area             │
│ (240px) │                                │
│  or     │                                │
│ icon    │                                │
│ rail    │                                │
│ (~48px) │                                │
└─────────┴────────────────────────────────┘
```

**Mobile (< lg breakpoint):**
```
┌──────────────────────────────────────────┐
│ [☰] Portal FCAT              [User] [A] │  ← thin top header
├──────────────────────────────────────────┤
│              Content Area                │
│          (full width, no sidebar)        │
│                                          │
│  ┌─────────┐                             │
│  │ Drawer  │ ← slide-over from left     │
│  │ overlay │    on hamburger tap         │
│  └─────────┘                             │
└──────────────────────────────────────────┘
```

### Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Sidebar type | Collapsible | User can toggle open/closed for more content space |
| Collapsed state | Icon-only rail (~48px) | More discoverable than fully hidden; shows tooltips on hover |
| Top header | Thin bar with logo + toggle + user badge | Like GitHub/GitLab — branding stays visible |
| Sub-modules | Always expanded | All items visible under project headings, no extra clicks |
| Mobile | Slide-over drawer from left | Standard mobile pattern, closes on nav or backdrop tap |
| Camera Trap placement | Under BioChocó (nav only) | Routes (`/camera-trap/*`) and permissions stay separate |
| CT-only users | BioChocó as non-clickable heading | BioChocó heading visible but not a link; only CT children shown |
| SubNav tab bars | Remove entirely | Sidebar is sole navigation; avoids duplication |
| State persistence | Cookie (server-readable) | Avoids layout shift on page load vs localStorage flash |
| Default state | Expanded on desktop, drawer on mobile | New users see full navigation on first visit |

## Technical Approach

### Architecture

**Server/Client boundary (composition pattern):**

The CLAUDE.md constraint says Nav must be an Async Server Component, not a Client Component or Context provider. We solve this with composition:

1. **Server Component** (`nav.tsx` or new `sidebar-nav.tsx`): Computes the navigation tree based on user permissions. Renders the tree items as children/props into a Client Component shell.
2. **Client Component** (`sidebar-shell.tsx`): Manages sidebar toggle state, mobile drawer open/close, collapse/expand animations. Uses shadcn/ui `SidebarProvider` internally.
3. **Root layout** passes `user` to the server component, which passes filtered items to the client shell.

```
layout.tsx (Server, async)
  └─ SidebarNav (Server) ← computes nav tree from user.permissions
       └─ SidebarShell (Client) ← toggle, drawer, animations
            ├─ Sidebar content (nav links)
            └─ TopHeader (logo, toggle button, UserBadge)
```

This preserves the constraint: permission-filtering logic stays server-side. The client component is purely presentational.

### Component Structure

**New files:**
- `src/components/sidebar-nav.tsx` — Server Component. Builds nav tree, filters by permissions. Renders `<SidebarShell>` with pre-computed items.
- `src/components/sidebar-shell.tsx` — Client Component. Wraps shadcn `SidebarProvider`, handles toggle/drawer.
- `src/components/top-header.tsx` — Thin header bar with logo, `SidebarTrigger`, and `UserBadge`.
- `src/components/ui/sidebar.tsx` — shadcn/ui sidebar primitive (installed via CLI).

**Modified files:**
- `src/app/layout.tsx` — Replace `<Nav>` + vertical `<main>` with sidebar layout.
- `src/app/globals.css` — Sidebar CSS variables already exist; may need minor adjustments.
- `src/app/giz/layout.tsx` — Remove `<SubNav>` usage.
- `src/app/biochoco/layout.tsx` — Remove `<SubNav>` usage.
- `src/app/page.tsx` — Home page may need layout adjustments (module cards still useful as a dashboard).

**Removed/deprecated files:**
- `src/components/sub-nav.tsx` — No longer needed (can delete after migration).
- `src/components/nav.tsx` — Replaced by `sidebar-nav.tsx` + `top-header.tsx`.

**Shared utility extraction:**
- Extract `hasProjectAccess()` from `nav.tsx` and `page.tsx` into `src/lib/auth.ts` to avoid duplication.

### Active State Highlighting

Use longest-prefix matching:

```
/camera-trap/results/42/images/7 → matches "Resultados" (/camera-trap/results)
/camera-trap/42                  → matches "Dashboard"   (/camera-trap)
/biochoco/tools                  → matches "Herramientas" (/biochoco/tools)
/giz/tree-planting               → matches "Siembra de Árboles" (/giz/tree-planting)
```

Algorithm: For each nav item, check if `pathname.startsWith(item.href)`. Among matches, pick the one with the longest `href`. This is computed client-side via `usePathname()` in `sidebar-shell.tsx`.

### Permission Logic

```typescript
// Server-side nav tree construction (sidebar-nav.tsx)
const navTree = {
  projects: [
    // Always visible
    { label: "Inicio", href: "/", icon: Home },

    // GIZ: visible if hasProjectAccess(user, "giz")
    hasProjectAccess(user, "giz") && {
      label: "GIZ", icon: TreePine,
      children: [
        { label: "Siembra de Árboles", href: "/giz/tree-planting" },
        { label: "Monitoreo de Cacao", href: "/giz/cacao-monitoring" },
      ]
    },

    // BioChocó group: visible if user has biochoco OR camera-trap access
    (hasProjectAccess(user, "biochoco") || hasProjectAccess(user, "camera-trap")) && {
      label: "BioChocó", icon: Leaf,
      // BioChocó heading is non-clickable (group label)
      children: [
        // BioChocó sub-pages: only if biochoco access
        hasProjectAccess(user, "biochoco") && { label: "Resumen", href: "/biochoco/overview" },
        isBiochocoEditor && { label: "Herramientas", href: "/biochoco/tools" },
        // Camera Trap: only if camera-trap access
        hasProjectAccess(user, "camera-trap") && {
          label: "Cámaras Trampa", icon: Camera,
          children: [
            { label: "Dashboard", href: "/camera-trap" },
            { label: "Resultados", href: "/camera-trap/results" },
            { label: "Anotaciones", href: "/camera-trap/annotate" },
          ]
        },
      ].filter(Boolean)
    },
  ].filter(Boolean),

  // Admin section: super_admin only
  admin: user.globalRole === "super_admin" ? [
    { label: "Panel de Admin", href: "/admin", icon: Shield }
  ] : []
};
```

### Sidebar Route Mapping

| Sidebar Item | Route | Permission Gate |
|---|---|---|
| Inicio | `/` | All authenticated users |
| GIZ > Siembra de Árboles | `/giz/tree-planting` | `giz` project access |
| GIZ > Monitoreo de Cacao | `/giz/cacao-monitoring` | `giz` project access |
| BioChocó > Resumen | `/biochoco/overview` | `biochoco` project access |
| BioChocó > Herramientas | `/biochoco/tools` | `biochoco` editor/admin |
| BioChocó > Cámaras Trampa > Dashboard | `/camera-trap` | `camera-trap` project access |
| BioChocó > Cámaras Trampa > Resultados | `/camera-trap/results` | `camera-trap` project access |
| BioChocó > Cámaras Trampa > Anotaciones | `/camera-trap/annotate` | `camera-trap` project access |
| Panel de Admin | `/admin` | `super_admin` global role |

**Routes NOT in sidebar** (reached via in-page links, parent highlighted):
- `/camera-trap/[id]` — Deployment detail (highlights "Dashboard")
- `/camera-trap/process` — Processing (highlights "Dashboard")
- `/camera-trap/results/[id]` — Job results (highlights "Resultados")
- `/camera-trap/results/[id]/images/[imageId]` — Image detail (highlights "Resultados")

### Icons for Rail View

When collapsed to icon-only rail, each section needs an icon. Using Lucide icons (already in the project):

| Item | Icon |
|---|---|
| Inicio | `Home` |
| GIZ | `TreePine` |
| BioChocó | `Leaf` |
| Cámaras Trampa | `Camera` |
| Panel de Admin | `Shield` |

Section headers ("PROYECTOS", "ADMINISTRACIÓN") are hidden in rail view. Only top-level group icons show. Tooltips display the full label on hover.

### Content Area Migration

The root layout `<main className="container mx-auto px-4 py-6">` must change. With a sidebar, the content should fill the remaining space:

```tsx
// Before (root layout)
<Nav user={user} />
<main className="container mx-auto px-4 py-6">{children}</main>

// After (root layout)
<SidebarProvider defaultOpen={true}>
  <SidebarNav user={user} />
  <SidebarInset>
    <TopHeader user={user} />
    <main className="flex-1 px-4 py-6 overflow-auto">
      <div className="mx-auto max-w-7xl">
        {children}
      </div>
    </main>
  </SidebarInset>
</SidebarProvider>
```

Individual pages can override the max-width as needed. The `container mx-auto` class on existing pages may need updating to work within the new layout context.

## Acceptance Criteria

### Functional Requirements

- [ ] Sidebar renders with correct project hierarchy and sub-modules
- [ ] Navigation items are permission-filtered server-side (same rules as current nav)
- [ ] BioChocó heading appears as non-clickable group when user has only camera-trap access
- [ ] "Herramientas" only visible to biochoco editors/admins
- [ ] Active route is correctly highlighted using longest-prefix matching
- [ ] Desktop: sidebar toggles between expanded (240px) and icon-only rail (~48px)
- [ ] Desktop: collapse state persists via cookie across page loads
- [ ] Mobile (< lg): sidebar appears as slide-over drawer from left
- [ ] Mobile: drawer auto-closes on navigation
- [ ] Mobile: drawer closes on backdrop tap
- [ ] Thin top header shows logo, sidebar toggle button, and user badge
- [ ] SubNav tab bars removed from GIZ and BioChocó layouts
- [ ] All existing routes continue to work (no URL changes)
- [ ] Camera Trap routes still use `/camera-trap/*` paths (nav-only reorganization)
- [ ] Home page still functional (module cards remain useful as dashboard overview)

### Non-Functional Requirements

- [ ] No layout shift on page load (cookie-based state, not localStorage)
- [ ] Sidebar transition/animation is smooth (CSS transitions, not layout thrash)
- [ ] Keyboard navigation: Tab through items, Escape closes mobile drawer
- [ ] Proper ARIA landmarks (`role="navigation"`, `aria-label`)
- [ ] Focus management: focus moves into drawer on open, returns to trigger on close

### Quality Gates

- [ ] All existing Vitest tests pass
- [ ] All existing Playwright E2E tests pass (may need selector updates)
- [ ] No regressions in page layouts (spot-check all pages with sidebar open and collapsed)
- [ ] Mobile responsive: test at 375px, 768px, 1024px, 1440px widths
- [ ] Permission filtering verified: super_admin, biochoco-only, camera-trap-only, giz-only, multi-project

## Implementation Phases

### Phase 1: Foundation (Sidebar Shell + Top Header)

**Goal:** Get the sidebar rendering with correct layout, toggle working, mobile drawer working. No navigation items yet — just the structural shell.

- [x] Install shadcn/ui sidebar component (`npx shadcn@latest add sidebar`)
- [x] Install any missing dependencies (sheet, tooltip, etc.)
- [x] Extract `hasProjectAccess()` to `src/lib/auth.ts`
- [x] Create `src/components/top-header.tsx` — thin header with logo, `SidebarTrigger`, `UserBadge`
- [x] Create `src/components/sidebar-shell.tsx` (Client Component) — sidebar + drawer wrapper
- [x] Modify `src/app/layout.tsx` — replace `<Nav>` with new sidebar layout structure
- [x] Verify: sidebar opens/closes, mobile drawer works, content area fills remaining space

### Phase 2: Navigation Tree + Permissions

**Goal:** Populate the sidebar with all navigation items, permission-filtered.

- [x] Create `src/components/sidebar-nav.tsx` (Server Component) — builds nav tree from user permissions
- [x] Implement BioChocó group logic (shows if user has biochoco OR camera-trap access)
- [x] Implement Herramientas editor-only visibility
- [x] Wire nav items into `sidebar-shell.tsx` as props/children
- [x] Implement section headers (PROYECTOS, ADMINISTRACIÓN)
- [x] Add Lucide icons to nav groups

### Phase 3: Active State + Icon Rail

**Goal:** Highlight the active route, implement collapsed icon-only rail with tooltips.

- [x] Implement longest-prefix active state matching in `sidebar-shell.tsx`
- [x] Style active item (highlight, bold, accent color)
- [x] Implement icon-only rail collapsed view
- [x] Add tooltips on hover in rail mode
- [x] Persist collapse state via cookie
- [x] Server-read cookie in layout for default open/closed state (no layout shift)

### Phase 4: Cleanup + Polish

**Goal:** Remove old nav, remove SubNav tabs, fix content layouts.

- [x] Remove `<SubNav>` from `src/app/giz/layout.tsx`
- [x] Remove `<SubNav>` from `src/app/biochoco/layout.tsx`
- [x] Delete `src/components/sub-nav.tsx`
- [x] Delete `src/components/nav.tsx`
- [x] Audit all pages for `container mx-auto` / `max-w-*` layout issues with sidebar
- [x] Fix any content area width issues
- [x] Remove redirect pages (`/giz/page.tsx`, `/biochoco/page.tsx`) or update them
- [x] Update E2E test selectors if needed
- [x] Verify all permission scenarios (super_admin, single-project, multi-project, no-permissions)
- [x] Test mobile drawer close-on-navigate behavior
- [x] Accessibility pass: keyboard nav, ARIA labels, focus management

## Dependencies & Risks

**Dependencies:**
- shadcn/ui sidebar component (install via CLI — well-maintained, already in the ecosystem)
- Lucide icons (already in the project)

**Risks:**
- **Content area width regression:** Pages designed for full-width content may look cramped with 240px sidebar. Mitigation: audit all pages in Phase 4, adjust max-widths as needed.
- **E2E test breakage:** Navigation selectors will change. Mitigation: update selectors in Phase 4.
- **Cookie-based state:** Cookies add a small header to every request. Mitigation: single small cookie, negligible overhead.
- **Icon selection for rail:** Need appropriate icons for each project group. Mitigation: Lucide has good coverage; fallback to generic icons if needed.

## References & Research

### Internal References
- Current nav: `src/components/nav.tsx`
- Current sub-nav: `src/components/sub-nav.tsx`
- User badge: `src/components/user-badge.tsx`
- Root layout: `src/app/layout.tsx`
- GIZ layout: `src/app/giz/layout.tsx`
- BioChocó layout: `src/app/biochoco/layout.tsx`
- Auth types: `src/lib/types.ts` (AuthUser, UserPermission)
- Permission check: `src/lib/auth.ts` (requirePermission, requireAdmin)
- Sidebar CSS variables: `src/app/globals.css` (lines with `--sidebar-*`)
- shadcn config: `components.json`
- Existing filter sidebar pattern: `src/app/giz/tree-planting/dashboard-shell.tsx` (240px grid)

### Conventions (from CLAUDE.md)
- Nav: Async Server Component. NOT a Client Component. NOT a React Context provider.
- Spanish UI strings, English routes.
- Auth: `getCurrentUser()` server-side, passed via props.
- Permissions: `requirePermission()` on all server actions.
