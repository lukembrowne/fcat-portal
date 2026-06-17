# Revisión de datos BioChocó — junio 2026
_Generado: 2026-06-17 · 64 instalaciones revisadas (2 excluidas) · **recuento de Drive en vivo**_

## Resumen ejecutivo
- 🔴 Errores: 3   🟡 Advertencias: 27   🔵 Informativos: 11
- 35 de 64 instalaciones tienen al menos un hallazgo. Estado del ciclo: 58 recuperadas, 6 instaladas (aún en campo), 0 pendientes de instalar.
- **Acciones prioritarias del mes:**
  1. **Subir / verificar los datos de PRI-003 y NAC-007** — recuperadas (hace 6 y 4 días) pero sin nada en Drive. Recientes, así que probablemente solo falte cargar; confirmar con el equipo.
  2. **Recuperar POT-008** (instalada, **23 días** vencida de recuperación — riesgo de pérdida de batería/tarjeta).
  3. **Revisar el reloj de la cámara de REF-003** (180 imágenes fuera de la ventana) y la **cobertura iButton muy baja de GIZ-012 (38 %)**.

## Comparación con el mes anterior
- Primera revisión — no hay informe previo con qué comparar. Este informe queda como **línea base**; a partir del próximo mes se marcarán hallazgos como nuevos / persistentes / resueltos.

## 1. Recuperación vencida
Instaladas, aún no recuperadas, con fecha de recuperación del cronograma ya pasada.

| Instalación | Hábitat | Plan recup. | Días vencido | Severidad |
|---|---|---|---|---|
| POT-008_V1 | pastizal | 2026-05-25 | 23 | 🔴 |
| GIZ-013_V1 | cacao GIZ | 2026-06-14 | 3 | 🟡 |
| CCN-007_V1 | cacao CCN | 2026-06-15 | 2 | 🟡 |
| REF-013_V1 | reforestación | 2026-06-16 | 1 | 🟡 |

> **Acción recomendada:** priorizar **POT-008** (3 semanas vencida). Las otras tres apenas se pasaron (1–3 días); reagendar en la próxima salida.

## 2. Instalación vencida
Sin hallazgos: ninguna instalación programada quedó sin instalar pasada su fecha. ✅

## 3. Recuperadas sin datos
Sensores recuperados (`retrieve_sensors` presente) pero con **cero** archivos de cámara, audio e iButton en Drive tras el recuento en vivo.

| Instalación | Hábitat | Fecha recup. | Días desde recup. | Severidad |
|---|---|---|---|---|
| PRI-003_V1 | bosque primario | 2026-06-11 | 6 | 🔴 |
| NAC-007_V1 | cacao nacional | 2026-06-13 | 4 | 🔴 |

> **Acción recomendada:** ambas son recientes — lo más probable es que las tarjetas/grabadoras existan y solo falte subirlas. Cargarlas y, si no aparecen, verificar si hubo falla en campo.

## 4. Datos parciales
Recuperadas con algunos tipos de datos presentes y otros faltantes (tipos esperados según las subcarpetas de Drive existentes).

| Instalación | Hábitat | Presente | Falta | Conteos (cám / audio / iBtn) |
|---|---|---|---|---|
| POT-009_V1 | pastizal | cámaras, iButton | audio | 1728 / 0 / 1 |
| CCN-004_V1 | cacao CCN | cámaras, audio | iButton | 1476 / 5578 / 0 |
| POT-011_V1 | pastizal | audio, iButton | cámaras | 0 / 5451 / 1 |

> **Acción recomendada:** confirmar si el tipo faltante realmente se desplegó en ese sitio. "Falta audio" (POT-009) puede significar que no se instaló grabadora ahí. "Falta cámaras" (POT-011) — revisar si la cámara no capturó (como CCN-005, ver notas de campo) o si las fotos no se subieron. CCN-004 ("falta iButton") tiene cámara y audio — verificar si el iButton se recuperó.

## 5. Coordenadas faltantes
Sin hallazgos: todas las instalaciones revisadas tienen latitud/longitud. ✅

## 6. Conteos no verificables (errores de Drive)
Sin hallazgos: el recuento en vivo se completó sin errores en las 64 instalaciones (0 fallos). ✅

## 7. Archivos fuera de la ventana de despliegue
Imágenes de cámara con marca de tiempo fuera del rango instalación→recuperación.

| Instalación | Hábitat | Ventana | Imágenes fuera | Severidad |
|---|---|---|---|---|
| REF-003_V1 | reforestación | 2026-04-17 → 2026-05-17 | **180** | 🟡 |
| POT-010_V1 | pastizal | 2026-04-18 → 2026-05-18 | 2 | 🟡 |
| SEC-007_V1 | bosque secundario | 2026-02-22 → 2026-03-23 | 1 | 🟡 |

> **Acción recomendada:** **REF-003** con 180 imágenes fuera de ventana sugiere un **reloj de cámara mal configurado** — revisar antes de que contamine los análisis temporales. POT-010 (2) y SEC-007 (1) son triviales (probablemente fotos de prueba de instalación/retiro).

## 8. Salud de procesamiento (iButton / ML)

### Trabajos de procesamiento fallidos
| Instalación | Hábitat | Trabajos fallidos |
|---|---|---|
| REF-010_V1 | reforestación | 3 |
| REF-002_V1 | reforestación | 1 |
| SEC-008_V1 | bosque secundario | 1 |
| NAC-008_V1 | cacao nacional | 1 |
| GIZ-009_V1 | cacao GIZ | 1 |
| CCN-012_V1 | cacao CCN | 1 |
| PRI-004_V1 | bosque primario | 1 |

> **Acción recomendada:** reintentar el procesamiento ML de estas instalaciones (ninguna reporta imágenes fallidas individuales, así que probablemente fueron fallos de trabajo completos — disco, descarga o cancelación). REF-010 acumula 3 — revisar primero.

### Cobertura iButton baja (<95 %)
| Instalación | Hábitat | Cobertura | Lecturas |
|---|---|---|---|
| GIZ-012_V1 | cacao GIZ | **38 %** | 559 |
| CCN-013_V1 | cacao CCN | 57 % | 845 |
| SEC-014_V1 | bosque secundario | 67 % | 1002 |
| POT-003_V1 | pastizal | 75 % | 1050 |
| NAC-012_V1 | cacao nacional | 76 % | 1128 |
| GIZ-010_V1 | cacao GIZ | 76 % | 1099 |
| NAC-011_V1 | cacao nacional | 77 % | 1149 |
| CCN-008_V1 | cacao CCN | 78 % | 1134 |
| PRI-006_V1 | bosque primario | 89 % | 1323 |
| SEC-003_V1 | bosque secundario | 90 % | 1335 |

> **Acción recomendada:** GIZ-012 (38 %) y CCN-013 (57 %) tienen huecos grandes en la serie de temperatura — verificar si el sensor falló a mitad de despliegue o si la misión se configuró con un rango distinto. Las de 89–90 % son aceptables. El grupo de 75–78 % (varias instalaciones) conviene mirarlo en conjunto: podría ser un patrón de configuración de misión más que fallas individuales.

### Pendientes de verificación humana (informativo)
11 instalaciones procesadas por ML pero sin verificación humana de detecciones: NAC-002, SEC-007, GIZ-004, CCN-004, PRI-006, NAC-012, CCN-013, REF-003, PRI-013, SEC-012, SEC-009.

> No es un problema de datos, sino una cola de trabajo de verificación. Útil para planificar el tiempo de revisión del equipo.

## Hallazgos explicados por notas de campo
- **CCN-005_V1** — _Datos parciales: falta cámaras_ (audio 5146, iButton 1, cámaras 0). **Nota de campo:** _"no tenía fotos, estaba 0/0"_. Explicado: la cámara no capturó imágenes en campo; no es un fallo de carga. Mantener como registro, no requiere acción de subida.

## Apéndice — metodología y fuentes
- **Fuentes:** cronograma (Google Sheets), ODK (`instalar_sensores` / `retrieve_sensors`), conteo de archivos en Google Drive (**recuento en vivo**), base de datos del portal.
- **Recuento de Drive:** este informe forzó un recuento en vivo de las 64 instalaciones (se completó en ~1.5 min, 0 errores). Importante: una corrida con conteos en caché habría reportado falsos positivos (p. ej. POT-010 y POT-003 figuraban en 0 por caché desactualizada, cuando sí tienen datos).
- **Umbrales:** vencimiento >14 días = error, ≤14 días = advertencia; cobertura iButton <95 % = baja.
- **Alcance v1:** "archivos fuera de ventana" se evalúa solo para imágenes de cámara; el QC de ventana para audio/iButton está diferido. La plausibilidad de coordenadas (caja delimitadora) está diferida; v1 solo marca coordenadas nulas. Tipos esperados (datos parciales) se infieren de las subcarpetas de Drive existentes.
- **Instalaciones excluidas (QA):** 2, omitidas de los hallazgos.
- **Snapshot:** `data/reviews/snapshot-2026-06.json`
