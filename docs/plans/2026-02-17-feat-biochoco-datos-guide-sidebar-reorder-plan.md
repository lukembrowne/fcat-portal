---
title: "feat: BioChocó datos upload guide & sidebar reorder"
type: feat
date: 2026-02-17
---

# BioChocó Datos Upload Guide & Sidebar Reorder

## Overview

Two small UI changes to the BioChocó section: (1) rename "Resumen" → "Cronograma" and reorder sidebar items, (2) add a collapsible upload guide at the top of the Datos page.

Brainstorm: `docs/brainstorms/2026-02-17-biochoco-datos-guide-brainstorm.md`

## Changes

### 1. Sidebar reorder + rename

**File:** `src/components/sidebar-nav.tsx` (lines 63–76)

**Current order:**
```
Resumen → /biochoco/overview
Recursos → /biochoco/recursos
Hábitat → /biochoco/habitat
Datos → /biochoco/data
Herramientas → /biochoco/tools (editor-only)
```

**New order:**
```
Cronograma → /biochoco/overview
Datos → /biochoco/data
Hábitat → /biochoco/habitat
Recursos → /biochoco/recursos
Herramientas → /biochoco/tools (editor-only)
```

Just reorder the `biochocoChildren.push()` calls and change the label string from `"Resumen"` to `"Cronograma"`. Route stays `/biochoco/overview`.

### 2. Collapsible upload guide on Datos page

**New file:** `src/app/biochoco/data/data-upload-guide.tsx`

Follow the exact `AnnotationHelpPanel` pattern (`src/components/annotation-help-panel.tsx`):
- `"use client"` component
- `useState` initialized from `localStorage` (`data-upload-guide-collapsed` key)
- Starts collapsed by default (first visit = collapsed)
- Chevron toggle header: "Guía: cómo subir datos de sensores"
- `border rounded-lg bg-muted/30` container (matches existing pattern)

**Guide content** — numbered steps in Spanish:

1. **Recuperar sensores** — Completar el formulario de recuperación en ODK Collect desde el campo
2. **Buscar la instalación** — Usar la barra de búsqueda para encontrar la instalación por nombre de sitio o ID
3. **Subir archivos** — Hacer clic en "Subir" junto al tipo de dato (Cámaras, Audio, iButton) para abrir la carpeta de Google Drive
4. **Cargar los datos** — Arrastrar o seleccionar los archivos del sensor en la carpeta que se abre
5. **Verificar** — Volver a esta página y verificar que los conteos de archivos aparezcan correctamente (usar el botón de actualizar si es necesario)

**Integration in page:** `src/app/biochoco/data/page.tsx`

Add `<DataUploadGuide />` as the first child in the `<div className="space-y-6">`, before both `CreateFoldersPanel` and `UploadStatusTable`.

## Acceptance Criteria

- [x] Sidebar shows "Cronograma" instead of "Resumen" for BioChocó
- [x] Sidebar order is: Cronograma, Datos, Hábitat, Recursos, Herramientas
- [x] Datos page shows collapsible guide panel at top
- [x] Guide starts collapsed, toggle persists in localStorage
- [x] Guide content is accurate Spanish walkthrough of upload process
- [ ] No visual regressions on the Datos page

## References

- Pattern to follow: `src/components/annotation-help-panel.tsx`
- Sidebar nav: `src/components/sidebar-nav.tsx:63-76`
- Datos page: `src/app/biochoco/data/page.tsx`
