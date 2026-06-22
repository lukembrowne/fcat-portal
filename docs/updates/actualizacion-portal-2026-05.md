---
title: "Novedades del Portal FCAT — mayo 2026"
subtitle: "Resumen del trabajo realizado entre finales de abril y finales de mayo de 2026"
date: "Mayo de 2026"
---

# Novedades del Portal FCAT — mayo 2026

Este documento resume el trabajo realizado en el Portal FCAT durante el último mes, aproximadamente entre el 29 de abril y el 27 de mayo de 2026. Está preparado a partir del historial de cambios del repositorio de código y de consultas de solo lectura a la base de datos de producción del portal. La intención es que sirva como nota de actualización para colaboradores: qué se construyó durante el mes, cuánta información ya vive en el sistema, y qué viene en camino.

El mes estuvo marcado por tres frentes principales: el estreno del primer clasificador propio de especies para cámaras trampa, una expansión grande del módulo de análisis de audio (bioacústica), y la habilitación de edición de datos de campo de BioChoco directamente desde el portal.

## 📷 Cámaras trampa

**Primer clasificador propio de especies.**
El equipo entrenó la primera versión de un modelo de clasificación de especies usando imágenes del proyecto **Fragmentos (2014)** y del proyecto **BioChoco**. El modelo `biochoco_v3` reconoce 24 especies y acertó en un **66.5 % de los casos** en la prueba de validación. Más importante que el número aislado: quedó montado el flujo completo para **re-entrenarlo de forma iterativa**, de modo que cada nueva vuelta del modelo aprende de los registros adicionales que se vayan verificando, y su precisión irá mejorando con el tiempo.

Algunas especies con buen desempeño en esta primera versión:

- *Dasypus fenestratus* (armadillo de nueve bandas) — 0.81
- *Proechimys semispinosus* (rata espinosa) — 0.77
- *Formicarius nigricapillus* (formicario cabecinegro) — 0.76
- *Dicotyles tajacu* (saíno de collar) — 0.75
- *Odontophorus erythrops* (corcovado carirrojo) — 0.74
- *Dasyprocta punctata* (guatuso) — 0.74
- *Leopardus pardalis* (ocelote) — 0.73
- *Cuniculus paca* (guanta) — 0.72

Curiosamente, la especie con mayor acierto resultó ser **la gallina doméstica** *Gallus gallus domesticus*, con 0.87 — al parecer es la más fotogénica (o al menos la más predecible) de los patios de las fincas.

![Vista de modelos del clasificador personalizado, con el modelo biochoco_v3 y sus puntajes por especie](screenshots/01-camera-trap-models.png)

**Otras mejoras en cámaras trampa:**

- Procesamiento más rápido y seguro de despliegues grandes. El sistema procesa los despliegues por partes para evitar saturar el almacenamiento, aun cuando el despliegue sea muy pesado, y reanuda solo los procesos que se interrumpan.
- Anotación más cómoda: selector de especies rediseñado, atajos de teclado, control de brillo para fotos oscuras, y cajas de detección que cambian de color según su estado de verificación. Las imágenes se precargan para que avanzar entre fotos sea casi instantáneo.
- Vista comparativa por especie y matriz de confusión, para inspeccionar dónde el modelo se confunde.

![Vista de anotación: selector contextual de especies, cajas de detección y controles de brillo](screenshots/02-annotation.png)

## 🔊 Audio y bioacústica

Esta fue el área con más avances. El portal ya analiza las grabaciones de los sensores acústicos casi de extremo a extremo:

- **Detección automática de aves (BirdNET).** Las grabaciones se procesan con un modelo que identifica especies de aves por su canto, con un nivel de confianza por detección.
- **Índices acústicos del paisaje sonoro.** Se calcula un conjunto de índices que resumen la actividad sonora de cada grabación, listos para comparar entre sitios y franjas horarias.
- **Espectrogramas interactivos.** Cada grabación puede visualizarse con zoom, desplazamiento y reproducción sincronizada, para revisar cada detección a detalle.
- **Filtro por nivel de confianza y exportación a CSV.** Un control deslizante permite filtrar las detecciones según qué tan seguras son, y descargar los resultados ya filtrados.
- **Compresión de audio (WAV→FLAC).** Las grabaciones se comprimen sin pérdida de calidad, con ahorros importantes de almacenamiento. El proceso es reversible.
- **Vista de calendario de grabaciones.** Reemplazó la lista anterior por una cuadrícula tipo calendario que muestra de un vistazo qué días se grabó y cuáles faltan.
- **Enlaces a xeno-canto y Wikipedia** desde cada especie, para verificar e investigar con más contexto.

![Espectrograma interactivo con detecciones BirdNET y umbral de confianza ajustable](screenshots/03-audio-spectrogram.png)

![Vista calendario de grabaciones, con las detecciones por día y hora](screenshots/04-audio-raster.png)

## 🗺️ Datos de campo BioChoco

- **Edición de sitios desde el portal.** Nombres, coordenadas y hábitat de los sitios pueden corregirse directamente, sin pasar por hojas de cálculo.
- **Cronograma editable.** Fechas, datos del propietario y notas se ajustan en la misma tabla del cronograma.
- **Notas de campo.** Un espacio en el cronograma para registrar el contexto operativo: problemas de equipo, datos faltantes, etc.

![Cronograma BioChoco con edición en línea de sitios y notas de campo](screenshots/05-biochoco-cronograma.png)

## 🔍 Otras novedades

- **Explorador de especies.** Un solo lugar para navegar todas las detecciones registradas, tanto de cámaras como de audio.
- **Solicitudes de investigación.** Estrenó un sistema para que investigadores externos envíen solicitudes de uso de datos de FCAT, y para que el equipo las reciba, revise, comente y resuelva desde el portal.
- **Almacenamiento que escala con el proyecto.** Se sumó un sistema de distribución de archivos entre varios Google Shared Drives para no chocar contra el límite de 500 000 archivos por unidad — un techo que el proyecto BioChoco ya estaba cerca de tocar.
- **Resumen diario por correo.** Un correo automático con la actividad del portal del día (nuevas grabaciones, despliegues sincronizados, procesamientos completados). Quienes quieran recibirlo pueden escribirle a Luke y serán agregados a la lista.

![Explorador de especies de audio, con detecciones BirdNET agregadas por especie](screenshots/06-species-browser.png)

## 🌳 Próximamente: páginas públicas para propietarios de fincas

Está en desarrollo una funcionalidad para generar **páginas públicas por sitio** que permitirán compartir con cada propietario de finca un resumen accesible de los resultados obtenidos en su predio: especies registradas en cámaras y audio, fotos destacadas, gráficos del paisaje sonoro y un mapa del sitio. La idea es retribuir de forma concreta la colaboración de las personas que abren las puertas de sus bosques, con un enlace que se puede ver desde el celular sin necesidad de cuenta. Más novedades en la próxima actualización.

## 📊 En cifras

Para dar una idea del volumen de información que ya vive en el portal (cifras consultadas directamente de la base de datos de producción):

| Categoría | Total |
|---|---:|
| Despliegues registrados | 383 |
| Despliegues con imágenes / con audio | 309 / 48 |
| Imágenes de cámaras trampa | 126 866 |
| Videos de cámaras trampa | 11 235 |
| Detecciones de cámaras trampa | 44 511 |
| Identificaciones de especies (cámaras) | 39 604 |
| Especies distintas detectadas en cámaras | 57 |
| Identificaciones ya verificadas | 14 194 |
| Grabaciones de audio | 236 607 |
| Grabaciones comprimidas a FLAC | 62 357 |
| Detecciones BirdNET | 452 029 |
| Especies de aves detectadas | 418 |
| Grabaciones con índices acústicos | 62 343 |

## Cierre

Las novedades pueden explorarse entrando al portal. Comentarios, dudas o sugerencias sobre cualquiera de los puntos anteriores son bienvenidos — el contacto sigue siendo Luke.

---

*Resumen preparado por Claude (asistente de IA, Anthropic) a partir del historial de cambios del repositorio de código del Portal FCAT y de consultas de solo lectura a la base de datos de producción. Las capturas de pantalla provienen de la instancia local del portal. Mayo de 2026.*
