---
title: Cascade species rename to identifications
type: feat
date: 2026-02-15
---

# Cascade Species Rename to Identifications

## Overview

When a species' `scientificName` is updated in the `biochoco_species` lookup table, automatically cascade the rename to all matching records in the `biochoco_identifications` table — both the `species` and `corrected_species` columns.

Currently, renaming a species in the lookup table leaves stale names in identifications, causing display inconsistencies and broken species counts.

## Problem Statement

The `biochoco_identifications` table stores species names as plain text (not foreign keys to `biochoco_species.id`). When a user edits a species' scientific name via the Species management page, existing identifications retain the old name. This means:

- Species counts become fragmented (old name and new name appear as separate species)
- Human corrections (`corrected_species`) reference a name that no longer exists in the lookup table
- The results page shows stale names

## Proposed Solution

Modify the existing `updateSpecies` server action in `src/app/camera-trap/actions.ts` to:

1. Detect when `scientificName` has changed (compare old vs new)
2. Cascade the rename to `biochoco_identifications` in a transaction
3. Log the cascading update to the activity log with before/after values and affected row counts

### Implementation

In `src/app/camera-trap/actions.ts`, the `updateSpecies` function (line ~1949):

```typescript
export async function updateSpecies(
  id: number,
  data: { scientificName?: string; commonName?: string; ... }
): Promise<ActionResult<Species>> {
  const user = await requirePermission("camera-trap", "editor");

  try {
    // 1. Fetch old record to detect scientificName change
    const [old] = await db
      .select()
      .from(species)
      .where(eq(species.id, id));

    if (!old) {
      return { success: false, error: "Especie no encontrada" };
    }

    const updates: Record<string, unknown> = {};
    if (data.scientificName !== undefined) updates.scientificName = data.scientificName.trim();
    if (data.commonName !== undefined) updates.commonName = data.commonName.trim();
    if (data.spanishName !== undefined) updates.spanishName = data.spanishName?.trim() || null;
    if (data.taxonomicRank !== undefined) updates.taxonomicRank = data.taxonomicRank;
    if (data.type !== undefined) updates.type = data.type;

    const newName = (updates.scientificName as string) ?? old.scientificName;
    const nameChanged = newName !== old.scientificName;

    // 2. Use transaction if name changed (atomicity for cascade)
    if (nameChanged) {
      const result = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(species)
          .set(updates)
          .where(eq(species.id, id))
          .returning();

        // Cascade to identifications.species
        const speciesResult = await tx
          .update(identifications)
          .set({ species: newName })
          .where(eq(identifications.species, old.scientificName));

        // Cascade to identifications.correctedSpecies
        const correctedResult = await tx
          .update(identifications)
          .set({ correctedSpecies: newName })
          .where(eq(identifications.correctedSpecies, old.scientificName));

        // 3. Activity log
        await tx.insert(activityLog).values({
          userEmail: user.email,
          action: "rename_species",
          projectId: "camera-trap",
          targetType: "species",
          targetId: String(id),
          details: JSON.stringify({
            oldName: old.scientificName,
            newName,
            identificationsUpdated: speciesResult.changes,
            correctionsUpdated: correctedResult.changes,
          }),
        });

        return updated;
      });

      revalidatePath("/camera-trap/species");
      revalidatePath("/camera-trap/results");
      return { success: true, data: result };
    } else {
      // No name change — simple update, no cascade needed
      const [result] = await db
        .update(species)
        .set(updates)
        .where(eq(species.id, id))
        .returning();

      revalidatePath("/camera-trap/species");
      return { success: true, data: result! };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error al actualizar especie";
    if (msg.includes("UNIQUE constraint")) {
      return { success: false, error: "Ya existe una especie con ese nombre científico" };
    }
    return { success: false, error: msg };
  }
}
```

## Acceptance Criteria

- [ ] Renaming a species' `scientificName` updates all matching `identifications.species` values
- [ ] Renaming a species' `scientificName` updates all matching `identifications.corrected_species` values
- [ ] Both updates happen atomically in a single transaction
- [ ] Activity log records the rename with old name, new name, and affected row counts
- [ ] Non-name changes (commonName, spanishName, type, rank) do NOT trigger a cascade
- [ ] Results page revalidates after a rename so species counts reflect the new name
- [ ] UNIQUE constraint errors still handled gracefully

## Context

- **File to modify**: `src/app/camera-trap/actions.ts` — `updateSpecies` function (line ~1949)
- **Schema**: `src/db/schema.ts` — `identifications` table (line 269), `species` table (line 297)
- **No schema migration needed** — no new columns or tables
- **Activity log pattern**: follows `deleteSpecies` convention (action, targetType, targetId, details JSON)
- **Transaction pattern**: follows finance/climate upload convention with `db.transaction()`

## References

- Existing `updateSpecies`: `src/app/camera-trap/actions.ts:1949`
- Activity log pattern: `src/app/camera-trap/actions.ts:2018` (deleteSpecies)
- Transaction pattern: `src/app/finance/data/actions.ts` (finance uploads)
- Species usage check: `src/app/camera-trap/actions.ts:2007` (getSpeciesUsageCount)
