# Brainstorm: BioChocó Datos Upload Guide & Sidebar Reorder

**Date:** 2026-02-17

## What We're Building

Two related changes to the BioChocó section:

### 1. Sidebar Reorder + Rename

Rename "Resumen" → "Cronograma" and reorder sidebar items:

**Current order:** Resumen, Recursos, Hábitat, Datos, Herramientas
**New order:** Cronograma, Datos, Hábitat, Recursos, Herramientas

Rationale: "Cronograma" better describes what the page actually is (schedule dashboard with map, monthly deployments/retrievals, workload). "Datos" moves up because it will be the primary destination once sensor retrieval begins.

### 2. Collapsible Upload Guide on Datos Page

Add a collapsible guide section at the top of the existing `/biochoco/data` page. The guide walks field team members through the sensor data upload process.

**Upload process steps:**
1. Recuperar los sensores del campo (ya completado con formulario ODK)
2. Abrir la página de Datos en el portal
3. Buscar la instalación por nombre de sitio o ID
4. Hacer clic en "Subir" junto al tipo de dato (Cámaras, Audio, iButton)
5. Arrastrar o seleccionar los archivos en la carpeta de Google Drive
6. Verificar que los conteos de archivos aparezcan correctamente

**UI approach:** Collapsible accordion section at the top of the page. Starts collapsed with a clear "Guía de carga de datos" header and expand/collapse toggle. Keeps the page clean for returning users while being discoverable for first-timers.

## Why This Approach

- **Collapsible > always visible**: Field team will use the guide once or twice then won't need it. Collapsible keeps the page clean.
- **On the same page > separate page**: The guide is short (6 steps). A separate page adds navigation friction. Keeping it on the Datos page means users see the guide right where they need to act.
- **Sidebar reorder**: Puts the two most-used pages (Cronograma and Datos) at the top.

## Key Decisions

- Rename "Resumen" → "Cronograma" in sidebar
- Reorder: Cronograma, Datos, Hábitat, Recursos, Herramientas
- Collapsible guide at top of existing Datos page
- Guide in Spanish (consistent with UI convention)
- No separate guide page needed

## Open Questions

None — scope is well-defined.
