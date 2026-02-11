---
title: "Biochoco Overview: Horizontal Scroll and Map Overlapping Sidebar"
type: bugfix
date: 2026-02-11
category: ui-bugs
tags: [css, overflow, leaflet, layout, tailwind, table, flexbox, min-w-0, sidebar]
module: biochoco
symptoms: ["Entire main content area scrolls horizontally", "Leaflet map overlaps sidebar when scrolling", "Wide ScheduleTable overflows viewport", "SiteSummaryTable overflows container", "Bug only appears when sidebar is open"]
---

# Biochoco Overview: Horizontal Scroll and Map Overlapping Sidebar

## Problem

The biochoco overview page (`/biochoco/overview`) had content overflowing over the left sidebar:

1. The Leaflet map overlapped the sidebar
2. Wide tables (ScheduleTable with 14 columns) pushed the page wider than the viewport
3. The bug only appeared **when the sidebar was open** — closing the sidebar gave enough room

## Root Cause

Three compounding issues in the flex layout chain:

```
SidebarProvider (flex container)
  SidebarNav (sidebar, ~256px when open)
  SidebarInset (flex-1, flex-col) ← missing min-w-0!
    <main> (flex-1, overflow-y-auto) ← overflow-y-auto alone doesn't prevent horizontal overflow
      <div max-w-7xl>
        DashboardShell
          OverviewMap (Leaflet, width: 100%)
          ScheduleTable (14 columns)
```

### 1. Missing `min-w-0` on `SidebarInset` (primary cause)

`SidebarInset` is a flex child with `flex-1` but no `min-w-0`. In CSS flexbox, the default `min-width` is `auto`, which means the element **will not shrink below its content's intrinsic width**. When the sidebar is open (~256px), the remaining space is ~viewport-256px. But wide content (Leaflet map, 14-column table) has an intrinsic width larger than that remaining space, so `SidebarInset` refuses to shrink and overflows.

When the sidebar is closed, there's enough room, so the bug disappears.

### 2. `overflow-y-auto` alone doesn't prevent horizontal overflow

Per CSS spec: **if one overflow axis is set to a non-`visible` value, the other axis computes to `auto`** (not `visible`). So `overflow-y: auto` on `<main>` still allows horizontal scrolling. You must explicitly set `overflow-x: hidden`.

### 3. Wide table content

The shadcn/ui `Table` component applies `whitespace-nowrap` by default. With 14 columns of non-wrapping text, the ScheduleTable exceeds available width. The table wrapper has `overflow-auto` but it only works if the wrapper itself is width-constrained.

## Solution

### 1. Add `min-w-0` to `SidebarInset` — `src/app/layout.tsx`

```tsx
// Before
<SidebarInset>

// After
<SidebarInset className="min-w-0">
```

This allows the flex child to shrink below its content's intrinsic width when the sidebar is open.

### 2. Fix main area overflow — `src/app/layout.tsx`

```tsx
// Before
<main className="flex-1 overflow-auto px-4 py-6">

// After
<main className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-6 min-w-0">
```

Explicit `overflow-x-hidden` clips horizontal overflow. `min-w-0` on `<main>` too since it's also a flex child.

### 3. `overflow-hidden` on DashboardShell — `dashboard-shell.tsx`

```tsx
// Before
<div className="space-y-6">

// After
<div className="space-y-6 overflow-hidden">
```

Belt-and-suspenders: ensures all child content (map, tables) is clipped at the dashboard level.

### 4. Compact tables

- `text-xs` on `<Table>` elements for smaller text
- `whitespace-normal` on text-heavy cells (siteName, habitat, habitatAssessed)
- Shortened "Habitat Evaluado" header to "Hab. Evaluado"
- Table wrapper `overflow-auto` provides horizontal scrollbar within the table container

## Key Insight

**`min-w-0` on flex children is essential in sidebar layouts.** Without it, flex items with `flex-1` refuse to shrink below their content's intrinsic width. This is invisible when there's enough viewport space (sidebar closed) but breaks immediately when the sidebar takes away ~256px. The fix must be applied at **every flex child in the chain** — `SidebarInset` AND `<main>`.

The `overflow-y-auto` vs `overflow-x-hidden` distinction is a separate but related trap: the CSS spec says setting one axis to non-`visible` forces the other to `auto`, so `overflow-y-auto` alone does NOT prevent horizontal overflow.

## Prevention

- Always add `min-w-0` to flex children in sidebar layouts
- Use `overflow-y-auto overflow-x-hidden` (not just `overflow-y-auto`) on scrollable main content areas
- Test dashboard pages **with the sidebar open** — that's the narrowest content width
- For wide data tables, use `text-xs` and allow wrapping on text-heavy columns
- Table wrappers with `overflow-auto` only work if their parent chain is width-constrained

## Files Changed

- `src/app/layout.tsx` — `min-w-0` on `SidebarInset`, `overflow-x-hidden min-w-0` on `<main>`
- `src/app/biochoco/overview/dashboard-shell.tsx` — `overflow-hidden` on root div
- `src/app/biochoco/overview/schedule-table.tsx` — `text-xs` on table, `whitespace-normal` on text cells, shortened headers
- `src/app/biochoco/overview/site-summary-table.tsx` — `text-xs` on table, `whitespace-normal` on siteName
