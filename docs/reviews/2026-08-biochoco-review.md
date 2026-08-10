# Revisión de datos BioChocó — agosto 2026
_Generado: 2026-08-10 · 92 instalaciones revisadas (0 excluidas) · **recuento de Drive en vivo** · incluye auditoría ampliada fuera de los 8 chequeos_

## Resumen ejecutivo
- 🔴 Errores: 2   🟡 Advertencias: 40   🔵 Informativos: 0
- 38 de 92 instalaciones tienen al menos un hallazgo. Ciclo de vida **según el cronograma**: 84 recuperadas, 6 en campo, 2 programadas sin instalar. **Según ODK hay 15 en campo** — el cronograma no conoce 9 instalaciones de finales de julio (ver anomalía B).
- **Acciones prioritarias del mes:**
  1. **Actualizar el cronograma con las 9 instalaciones del 20–27 de julio** (CCN-011, CCN-015, GIZ-003, GIZ-015, NAC-010, NAC-013, POT-015, PRI-012, SEC-011). Hoy son invisibles para el monitoreo de recuperaciones vencidas; sus recuperaciones caen ~19–26 de agosto. Además vencen esta semana (11–16 ago) las 6 sí registradas: NAC-014, GIZ-006, CCN-002, POT-007, PRI-010, SEC-002.
  2. **Corregir el registro ODK de NAC-009 y POT-005.** El cronograma las muestra «nunca instaladas» (54/45 días de retraso), pero ODK tiene envíos de `retrieve_sensors` del 17 y 27 de julio con IDs truncados (`NAC-009_V`, `POT-005_V`) y POT-005 ya tiene su iButton en Drive: se instalaron sin formulario de instalación y **ya fueron recuperadas**. Corregir los IDs / registrar la instalación retroactiva y subir sus datos.
  3. **Subir cámaras y audio de 6 sitios recuperados que solo tienen iButton**: NAC-001, GIZ-001, CCN-006, REF-012, PRI-007, SEC-004. Las carpetas existen y están vacías; las tarjetas/grabadoras ya volvieron del campo.
  4. **Vaciar la papelera del Shared Drive FCAT-BIOCHOCO** (28.403 elementos, producto de la limpieza de fotos en blanco de julio). La papelera cuenta para el límite de 500K de Google: el drive está al **85,2%** y dispara una alerta crítica por correo **todos los días**. Vaciarla lo baja a ~79,5%.
  5. **Eliminar los duplicados de audio en NAC-012** — 63 grabaciones subidas dos veces a Drive (mismo nombre y tamaño, dos archivos). BirdNET las contó doble.

## Comparación con junio 2026
- **Nuevos: ~19 · Persistentes: ~23 · Resueltos: ~19**
- Muy buena tendencia operativa: se resolvieron **las 4 recuperaciones vencidas** (incl. POT-008), **los 2 sitios recuperados sin datos** (PRI-003, NAC-007 ya tienen cámara y audio), el reloj de REF-003 (las 180 fotos fuera de ventana desaparecieron) y **toda la cola de verificación** (11 instalaciones en junio → 0 hoy; el equipo verificó todo en julio, con 941 detecciones borradas y 51 limpiezas masivas de fotos en blanco).
- Lo persistente se concentra en la **cobertura iButton baja** (los mismos 10 sitios de junio, sin cambios — apunta a configuración de misión, no a fallas individuales) y en advertencias históricas de trabajos ML fallidos.
- Lo nuevo grande: el desfase cronograma↔ODK (9 instalaciones activas sin registrar en el cronograma; NAC-009/POT-005 recuperadas con IDs truncados) y el bloque de 6 sitios pendientes de subida.

## 1. Recuperación vencida
Sin hallazgos **entre las instalaciones del cronograma**. ✅ Las 4 de junio (POT-008, GIZ-013, CCN-007, REF-013) fueron recuperadas. Próximos vencimientos: 11–16 de agosto (6 sitios registrados) y ~19–26 de agosto (las 9 instalaciones de julio ausentes del cronograma — ver anomalía B).

## 2. Instalación vencida
| Instalación | Plan instal. | Días vencido | Severidad |
|---|---|---|---|
| NAC-009_V1 | 2026-06-17 | **54** | 🔴 |
| POT-005_V1 | 2026-06-26 | **45** | 🔴 |

> **Matiz importante (auditoría ODK):** el hallazgo formal es correcto — no existe envío de `instalar_sensores` — pero ODK sí tiene envíos de `retrieve_sensors` del 17-jul (`NAC-009_V`) y 27-jul (`POT-005_V`), con el ID de instalación **truncado** (falta el dígito de la visita), y POT-005 ya tiene su archivo iButton en Drive. Es decir: los sensores **se instalaron y ya se recuperaron**, pero el formulario de instalación nunca se envió y el de recuperación quedó con ID malformado (probablemente escrito a mano porque el selector no encontraba la instalación). **Acción:** corregir los dos envíos en ODK Central (o registrar la instalación retroactiva), y subir los datos de NAC-009.

## 3. Recuperadas sin datos
Sin hallazgos. ✅ PRI-003 y NAC-007 (rojas en junio) ya tienen datos completos en Drive.

## 4. Datos parciales
| Instalación | Presente | Falta | Conteos (cam / audio / iBtn) | Estado |
|---|---|---|---|---|
| NAC-001_V1 | iButton | cámaras, audio | 0 / 0 / 1 | **nuevo** |
| GIZ-001_V1 | iButton | cámaras, audio | 0 / 0 / 1 | **nuevo** |
| CCN-006_V1 | iButton | cámaras, audio | 0 / 0 / 1 | **nuevo** |
| REF-012_V1 | iButton | cámaras, audio | 0 / 0 / 1 | **nuevo** |
| PRI-007_V1 | iButton | cámaras, audio | 0 / 0 / 1 | **nuevo** |
| SEC-004_V1 | iButton | cámaras, audio | 0 / 0 / 1 | **nuevo** |
| POT-011_V1 | audio, iButton | cámaras | 0 / 5451 / 1 | persistente |
| POT-009_V1 | cámaras, iButton | audio | 405 / 0 / 1 | persistente (nota de campo) |
| CCN-004_V1 | cámaras, audio | iButton | 30 / 5578 / 0 | persistente |
| CCN-005_V1 | audio, iButton | cámaras | 0 / 5146 / 1 | explicado (nota de campo) |
| POT-014_V1 | audio, iButton | cámaras | 0 / 4462 / 1 | explicado (nota de campo) |

> **Acción recomendada:** el bloque de 6 sitios «solo iButton» es la cola de subida principal del mes — confirmar con el equipo si las tarjetas y grabadoras están en la oficina y subirlas. POT-011 sigue sin explicación para cámaras (verificar si la cámara no registró, como CCN-005/POT-014, o si falta subir). CCN-004: verificar si el iButton se recuperó.

## 5. Coordenadas faltantes
NAC-009_V1 y POT-005_V1 (🟡) — las mismas dos instalaciones nunca instaladas; sin envío ODK no hay coordenadas. Se resuelve junto con el punto 2.

## 6. Conteos no verificables (errores de Drive)
Sin hallazgos: recuento en vivo completado sin errores en las 92 instalaciones. ✅

## 7. Archivos fuera de la ventana de despliegue
| Instalación | Ventana | Imágenes fuera | Estado |
|---|---|---|---|
| REF-001_V1 | 2026-03-11 → 2026-03-23 | 2 | nuevo (trivial) |
| POT-010_V1 | 2026-04-18 → 2026-05-18 | 2 | persistente (trivial) |

> REF-003 (180 en junio) ya no aparece — resuelto. Los casos de 2 fotos son típicos de instalación/retiro.

## 8. Salud de procesamiento (iButton / ML)

### Cobertura iButton baja — los mismos 10 sitios de junio, sin cambios
GIZ-012 (38%), CCN-013 (57%), SEC-014 (67%), POT-003 (75%), NAC-012 (76%), GIZ-010 (76%), NAC-011 (77%), CCN-008 (78%), PRI-006 (89%), SEC-003 (90%).

> **Acción recomendada:** dos meses sin cambios confirma que no son fallas individuales: el bloque 75–78% (5 sitios) apunta a una **configuración de misión** distinta. Revisar el protocolo de lanzamiento de iButtons antes de la próxima temporada.

### Trabajos ML fallidos
12 instalaciones con trabajos fallidos históricos. Los fallos **nuevos de julio** ya se recuperaron solos: 4 por disco insuficiente (11-jul, la guardia de disco funcionó y falló limpio) y 2 por caída del servidor de modelos (13 y 21-jul); POT-002, POT-004, NAC-004 y POT-008 se reprocesaron con éxito el 13–23 de julio y están **verificadas**.

> **Falso positivo a conocer:** «POT-001: 738 imágenes fallaron» viene de un trabajo de **compresión** completado (24-jul) que registró `failed_images = total`; las 738 imágenes están procesadas y bien. Es un bug menor de contabilidad del job de compresión, no un problema de datos.

### Cola de verificación: vacía ✅
En junio había 11 instalaciones procesadas sin verificar; hoy **0** — todo el proyecto actual está verificado.

## Anomalías adicionales (auditoría fuera de los 8 chequeos)

Consultas de solo lectura sobre la base de producción (integridad referencial, duplicados, ventanas de audio, pipeline de audio, drives compartidos, eventos del sistema).

### A. La limpieza de blancos de julio dejó el Drive «lleno» y disparando alertas diarias 🔴→acción fácil
Entre el 6 y el 30 de julio el equipo borró fotos en blanco confirmadas desde el portal (51 acciones masivas; el conteo de cámaras en Drive bajó de 37.723 → 15.908, coherente en base de datos y Drive — **no hay pérdida de datos**). Pero los archivos borrados van a la **papelera**, que sigue contando para el límite de 500K: FCAT-BIOCHOCO quedó al **85,2%** con 28.403 elementos en papelera, en estado read-only, y envía una alerta crítica por correo **cada día** desde el 7 de agosto. **Vaciar la papelera** (o esperar el auto-vaciado de 30 días, ~27–29 ago) lo devuelve a ~79,5% y silencia las alertas. FCAT-BIOCHOCO-4 (14,8%) absorbe las subidas nuevas sin problema.

### B. El cronograma no conoce 9 instalaciones activas — ODK muestra 15 sensores en campo, esta revisión solo vio 6 🔴
El mapa del portal (que lee ODK en vivo) muestra 15 sitios con sensor instalado; esta revisión, que recorre el **cronograma**, solo vio 6. Los 9 faltantes se instalaron entre el **20 y el 27 de julio** y nunca se añadieron a la hoja: CCN-011, CCN-015, GIZ-003, GIZ-015, NAC-010, NAC-013, POT-015, PRI-012, SEC-011. Mientras no estén en el cronograma, **ningún chequeo de recuperación vencida los vigila** — sus recuperaciones caen ~19–26 de agosto. Además hay un envío ODK basura (`deployment_id` = `_V1`, 18-may) y 2 envíos de instalación duplicados que conviene limpiar.

### C. 63 grabaciones de audio duplicadas en NAC-012_V1 (+1 en REF-001) 🟡
La serie completa de 5 minutos del 22-mar, 11:45–16:55 (63 archivos WAV de ~5,8 MB) existe **dos veces** en Drive (mismo nombre y tamaño, distinto ID — doble subida ~13-may). BirdNET procesó ambas copias, así que esas horas están **contadas doble** en las detecciones que alimentan ocupación y validación. REF-001_V1 tiene además un duplicado menor (`2MM20921_20260311_085000.wav`, 0,1 MB, truncado). Acción: borrar una copia de cada una en Drive y re-sincronizar; evaluar limpiar las detecciones duplicadas.

### D. 5 filas de instalaciones sin carpeta de Drive (2 son sensores reales en campo) 🟡
POT-015_V1 (22-jun) y NAC-013_V1/V2/V3 + NAC-014_V1 (11-jul) existen en la base sin carpeta de Drive. Con el hallazgo B queda claro que **POT-015_V1 y NAC-013_V1 no son filas basura: son sensores reales instalados el 27 y 20 de julio** cuyas filas se pre-crearon; les falta la carpeta de Drive y la entrada en el cronograma. La fila duplicada de NAC-014_V1 (id 513; la real está escaneada y en campo) y NAC-013_V2/V3 sí parecen sobrantes. Acción: crear carpetas + cronograma para POT-015/NAC-013 y borrar las 3 filas sobrantes.

### E. SEC-013_V1: 19 imágenes nuevas sin procesar 🟡
19 imágenes en estado «pendiente» sin ningún trabajo ML en cola (el último trabajo fue de audio, 1-ago). Acción: lanzar un ML incremental.

### F. Las fechas de modificación del audio son fechas de subida, no de grabación 🔵
En ~15 instalaciones, todo el audio tiene `modifiedTime` de Drive = día de subida (p. ej. CCN-003: 6.142 archivos «19–21 de mayo»), típico de subidas por la web de Drive que no preservan el mtime. **No usar mtime para QC de ventanas de audio**; el timestamp del nombre de archivo (`2MM20619_20260322_114500.wav`) es la fuente autoritativa. (La revisión estándar ya difiere el QC de ventana de audio — esto confirma que debe seguir así.)

### G. Higiene de proyectos legados (informativo) 🔵
- **92.162 imágenes históricas** (proyectos TP-xxx y PUCE) no tienen **ninguna** marca de tiempo (sin EXIF y sin `file_modified`) — bloquea análisis temporales/ocupación del histórico; un backfill desde Drive (`modifiedTime`) podría recuperar parte.
- 10 pares de instalaciones legadas duplicadas (proyecto PUCE) que apuntan a **dos carpetas distintas de Drive con el mismo nombre** (p. ej. `1_F_B`); casi todas con 0 imágenes.
- 4.281 videos legados pendientes de extracción de cuadros + 63 fallidos.
- 23.155 identificaciones de cámara sin verificar — casi todas del histórico (el proyecto actual está al día).

### H. Estado del pipeline de audio 🔵
- **Cobertura BirdNET completa**: las 77 instalaciones con audio tienen detecciones (2.784.389 pares detección/identificación, 1:1 perfecto, sin huérfanos). Índices acústicos casi completos (brechas menores, máx. 50 archivos en GIZ-010).
- **Compresión FLAC al 16,6%** (62.357 de 375.025; quedan 312.668 WAV, ~30 GB por instalación en las grandes). Sin archivos irrevertibles ni inconsistencias de formato.
- 27 sitios recuperados tienen su archivo iButton en Drive **sin importar al portal** (56 importados). Importarlos alimenta la cobertura térmica.
- El módulo de validación de umbrales BirdNET aún no está desplegado en producción (las 2,78 M identificaciones siguen «sin verificar» a la espera de ese flujo).

### Verificaciones que salieron limpias ✅
Sin huérfanos de integridad referencial, sin IDs de Drive duplicados entre instalaciones, sin timestamps corruptos (futuros/pre-2000) fuera del histórico, filas iButton = filas importadas en los 56 casos, sin trabajos atascados, corridas de ocupación semanales sanas (741 modelos el 9-ago), papelera aparte los drives reconcilian a diario sin errores.

## Hallazgos explicados por notas de campo
- **CCN-005_V1** — sin cámaras: _«no tenía fotos, estaba 0/0»_ (ya registrado en junio).
- **POT-014_V1** — sin cámaras: _«la cámara no registró ninguna fotografía, no sabemos qué pudo…»_ — falla de cámara en campo, no de subida.
- **POT-009_V1** — sin audio: _«el sitio POT-009-V001 no registró datos de audio…»_ — falla de grabadora en campo.

## Apéndice — metodología y fuentes
- **Fuentes:** cronograma (Google Sheets), ODK (`instalar_sensores`/`retrieve_sensors`), recuento Drive en vivo (92/92 sin errores), base de datos de producción (consultas de solo lectura), eventos del sistema.
- **Umbrales:** vencimiento >14 días = error; cobertura iButton <95% = baja.
- **Snapshot estándar:** `data/reviews/snapshot-2026-08.json` · **Consultas ampliadas:** `data/reviews/audit-adhoc-2026-08.json`, `audit-adhoc2-2026-08.json`, `audit-adhoc3-2026-08.json`.
- La auditoría ampliada cubrió: integridad referencial, duplicados (archivos y filas), ventanas de audio/iButton, estado de compresión/BirdNET/índices, capacidad de Shared Drives, eventos warn/error desde julio y la serie diaria de conteos de subida.
