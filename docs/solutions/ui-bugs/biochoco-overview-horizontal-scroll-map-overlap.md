---
title: "Biochoco Overview: Horizontal Scroll and Map Overlapping Sidebar"
type: bugfix
date: 2026-02-10
category: ui-bugs
tags: [css, overflow, leaflet, layout, tailwind, table]
module: biochoco
symptoms: ["Entire main content area scrolls horizontally", "Leaflet map overlaps sidebar when scrolling", "12-column ScheduleTable wider than viewport", "SiteSummaryTable overflows container"]
---

# Biochoco Overview: Horizontal Scroll and Map Overlapping Sidebar

## Problem

The biochoco overview page (`/biochoco/overview`) had three related visual bugs:

1. The entire main content area scrolled horizontally
2. When scrolling, the Leaflet map overlapped the fixed sidebar
3. Wide tables (ScheduleTable with 12 columns, SiteSummaryTable with 10 columns) forced the page wider than the viewport

## Root Cause

Three compounding issues:

### 1. `overflow-auto` on `<main>` (primary cause)

In `src/app/layout.tsx`, the `<main>` element had `overflow-auto`, which enables **both** horizontal and vertical scrolling. When table content exceeded the viewport width, the entire main area scrolled horizontally — and the Leaflet map (which uses `position: absolute/fixed` internally) scrolled with it, overlapping the sidebar.

### 2. Redundant container padding (space waste)

`DashboardShell` had `container mx-auto px-4 py-6` while the root layout already provided `mx-auto max-w-7xl` + `px-4 py-6`. This double-padding wasted ~32px of horizontal space, making it easier for wide tables to overflow.

### 3. `whitespace-nowrap` on table cells (table width)

The shadcn/ui `Table` component applies `whitespace-nowrap` to both `TableHead` and `TableCell` by default. With 12 columns of non-wrapping text, the ScheduleTable exceeded the available width.

## Solution

### 1. Fix main area overflow — `src/app/layout.tsx`

```tsx
// Before
<main className="flex-1 overflow-auto px-4 py-6">

// After
<main className="flex-1 overflow-y-auto px-4 py-6">
```

`overflow-y-auto` allows vertical scrolling while preventing horizontal scroll. This fixes both the page-level horizontal scroll and the map/sidebar overlap.

### 2. Remove redundant padding — `dashboard-shell.tsx`

```tsx
// Before
<div className="container mx-auto px-4 py-6 space-y-6">

// After
<div className="space-y-6">
```

The root layout already provides the container constraints and padding.

### 3. Compact ScheduleTable — `schedule-table.tsx`

- Added `text-xs` class to the `<Table>` element for smaller text across all columns
- Added `whitespace-normal` to text-heavy cells (siteName, habitat, habitatAssessed) to allow wrapping
- The table wrapper already has `overflow-x-auto`, so any remaining overflow scrolls within the table container, not the page

### 4. Compact SiteSummaryTable — `site-summary-table.tsx`

- Added `text-xs` class to the `<Table>` element
- Added `whitespace-normal` to the siteName cell

## Key Insight

The `overflow-auto` vs `overflow-y-auto` distinction is critical in layouts with fixed/absolute-positioned elements like Leaflet maps. `overflow-auto` creates a new scroll context in both axes, which can cause positioned children to scroll out of their intended bounds and overlap adjacent layout elements (like sidebars).

## Prevention

- Use `overflow-y-auto` (not `overflow-auto`) on main content areas in sidebar layouts
- Avoid nesting `container` classes — check if a parent already provides max-width constraints
- For wide data tables, use `text-xs` and allow wrapping on text-heavy columns rather than relying solely on `overflow-x-auto` wrappers
- Test dashboard pages at the sidebar's narrowest content width (~768px minus sidebar)

## Files Changed

- `src/app/layout.tsx` — `overflow-auto` → `overflow-y-auto`
- `src/app/biochoco/overview/dashboard-shell.tsx` — removed redundant container/padding
- `src/app/biochoco/overview/schedule-table.tsx` — `text-xs` on table, `whitespace-normal` on text cells
- `src/app/biochoco/overview/site-summary-table.tsx` — `text-xs` on table, `whitespace-normal` on siteName
