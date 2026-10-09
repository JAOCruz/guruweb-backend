# Correcciones de precios de Leandro, ronda 1 — Diseño

Fecha: 2026-10-08 · Estado: borrador para revisión de Jay
Fuente: `../Base de Datos Correcciones/` (Precios/, Actos_De_Venta/). Cubre los puntos 1 y 2 del documento de pendientes, hasta "Tasas". Leandro manda el resto después.

Decisiones de Jay (2026-10-08):
- La tarifa por foja se aplica **a todos** los documentos que redactamos, también a los que ya tienen precio.
- Mensajería de Migración, Ayuntamiento y Recolección de firmas: se queda **por confirmar** hasta que Leandro responda.
- Tasas: el bot da un **estimado con IA**, marcado como aproximado.

## 1. Correcciones de datos (una migración)

| Servicio | Hoy | Queda |
|---|---|---|
| Certificación Estatus Jurídico Inmueble | 1,000, por confirmar | 1,000; regla "no incluye impuestos" |
| Instancias (todas) | precios del sistema, por confirmar | precio por foja (§2), sin "por confirmar" |
| Estatutos Sociales | 250, por confirmar | por foja, legal simple (250 la foja) |
| Nómina de Pagos/Presencia | 300, por confirmar | por foja, carta motivada (300 la foja) |
| Foto 2x2 | 300 por unidad, por confirmar | 250 por juego de hasta 5 fotos |
| Fotocopia 11x17 | 20, por confirmar | 50 en blanco y negro; regla "a color, 100" |
| Escáner | 5 por hoja, por confirmar | **sin cambio**: Leandro dijo que no a las dos opciones y no dio precio |
| Actos de venta (tramos) | tabla A, desde 3M por confirmar | tabla A sin "por confirmar"; de 5M en adelante, 5,000 |
| Contrato de Venta Bienes (tramos) | tabla B | tabla A, la misma de los actos de venta |

- `seeds/bot/conflictos.json` pierde las entradas resueltas, para que al resembrar no vuelvan a marcarse.
- Las traducciones siguen fuera de la notarización: tienen su propio sistema.

## 2. Precio por foja

**Tarifas** (por foja; cada cara impresa es una foja):

| Tipo | Clave | Precio |
|---|---|---|
| Carta, simple | `carta_simple` | 150 |
| Carta, motivada | `carta_motivada` | 300 |
| Legal, simple | `legal_simple` | 250 |
| Legal, motivada | `legal_motivada` | 350 |

- El texto de Leandro dice "legal motivada 300" en la segunda línea. Se toma como carta motivada, porque así lo dice la imagen y porque la cuarta línea ya es legal motivada.
- "Extensivo" no es un tipo aparte: un documento largo es simplemente uno con más fojas.
- Las tarifas viven en un solo módulo (`src/models/fojaRates.js`).

**Dónde aplica:** a toda redacción o instrumentación hecha por la empresa: la categoría "Redactar o digitar un documento" y las instancias.
- No aplica a traducciones, certificaciones, máquina de escribir ni "Coletilla y notarizar documento fiel y conforme" (ese documento lo trae el cliente).

**Datos nuevos en `service_catalog`:**
- `foja_tipo`: una de las 4 claves, o null si no va por foja;
- `fojas`: las fojas estimadas del documento (entero, 1 por defecto).

**Cálculo (`calculatePrice`):**
- Si el servicio tiene `foja_tipo`, la digitación es `tarifa × fojas × cantidad`.
- `fojas` sale del argumento si viene; si no, de la estimación del servicio, y entonces el resultado lleva `fojas_estimadas: true`.
- La notarización no cambia (precio fijo o tabla A según el valor del bien).
- El desglose incluye `fojas` y `tarifa_por_foja`.

**Clasificación inicial (script, revisable):**
- El tipo sale de los ejemplos de Leandro:
  - **carta simple:** cartas, notificaciones, comunicaciones e instancias;
  - **carta motivada:** demandas, escritos, recursos, conclusiones y defensas;
  - **legal simple:** actos notariales, poderes, declaraciones, contratos, actos de venta, acuerdos y estatutos;
  - **legal motivada:** actos auténticos, determinaciones de herederos y particiones.
- Las fojas salen del número de páginas del modelo Word, cuando el servicio tiene uno ligado o con el mismo nombre. Si no, 1.
- El resultado queda en `seeds/bot/fojas.json` (nombre, tipo, fojas, de dónde salió) y lo aplica un script.
- Se genera un Excel para que Leandro revise el tipo, las fojas y el precio nuevo de cada documento, junto al precio anterior.

**Bot:**
- `calcular_precio` acepta `fojas`.
- Cuando las fojas son estimadas, el bot dice el precio como estimado: "un documento así suele tener 2 fojas: RD$500; el precio final depende de las fojas que tenga".
- **Panel:**
  - `/calculate` acepta `fojas`;
  - Catálogo muestra y edita `foja_tipo` y `fojas`;
  - Cotizaciones deja poner las fojas en la línea.

## 3. Originales y duplicados

- Por defecto, cada documento se vende con **1 original**.
- Incluyen **2 originales** solo:
  - los contratos de alquiler de inmuebles sencillos;
  - los contratos sencillos de 1 página tamaño carta.
- Cada original adicional o duplicado cuesta:
  - **500** si el documento tiene 1 o 2 fojas;
  - **700** si tiene 3 o más.
- `calcular_precio` acepta `duplicados` y suma esa línea según las fojas del documento.
- La guía del bot: pregunta cuántos originales necesita el cliente, y cambia la regla actual de "máximo 2 originales".

## 4. Mensajería

**Envío al cliente:**
- Es solo para documentos que hicimos o modificamos nosotros.
- El bot pregunta si el cliente pasa a recogerlo, lo manda a buscar o quiere que se lo enviemos.
- El envío se cobra lo que marque Uber, así que queda por confirmar ("Mensajería Local" pasa a ser ese servicio, sin precio fijo).

**Trámites de mensajería:** RD$1,000 por unidad (por documento), **sin impuestos**.
- Ejemplo: legalizar 2 documentos son 2,000 más los impuestos.
- Precio nuevo en los servicios que ya existen:
  - Legalización en Procuraduría o Ministerio Público;
  - Depósito en DGII;
  - Solicitud de certificación (búsqueda física de no antecedentes, estatus jurídico, IPI…).
- Servicios nuevos, también de 1,000:
  - Depósito en Cámara de Comercio;
  - Cancillería / MIREX;
  - Ministerio de Educación;
  - MESCYT.
- Migración, Ayuntamiento y Recolección de firmas siguen por confirmar. El motivo dice "pendiente de Leandro".

## 5. Tasas estimadas con IA

**Herramienta `estimar_tasa(concepto)`:**
- Sirve para tasas de matrícula, marbete, ayuntamiento, legalización, impuesto de transferencia y similares.
- Busca en la web con el proveedor de IA activo (Gemini con Google Search, o Claude con búsqueda web).
- Devuelve `{ concepto, monto_aproximado, fuente, fecha }`.
- Guarda cada resultado 30 días en `tasas_cache`, para no buscar lo mismo cada vez.

**Reglas:**
- El bot siempre la presenta como aproximada: "la tasa de marbete ronda RD$X; el monto exacto lo confirma la institución".
- Nunca se suma al total de la cotización. Va aparte, como "tasas oficiales (aprox.)".
- Si la búsqueda falla o no hay cifra clara, el bot dice que el equipo confirma el monto.
- El control de precios ya acepta montos que salen de herramientas. La guía exige la palabra "aproximado" para estos.

## 6. Pruebas

- **`calculatePrice`:**
  - por foja, con fojas pasadas y con fojas estimadas;
  - con cantidad;
  - con notarización por tramos;
  - un servicio sin `foja_tipo` funciona igual que hoy.
- **Duplicados:** 1, 2 y 3 fojas.
- **Migración:** después de correrla, los servicios corregidos ya no están por confirmar y tienen los precios de la tabla del §1.
- **`estimar_tasa`:** el proveedor falso devuelve una cifra; la caché devuelve lo mismo sin llamar al proveedor; si el proveedor falla, devuelve "por confirmar".
- **Escenarios del bot:**
  - el precio por fojas sale dicho como estimado;
  - pide duplicados;
  - envío por Uber;
  - legalizar 2 documentos;
  - preguntar por la tasa del marbete.
- **Frontend:** editar `foja_tipo` y `fojas` en el Catálogo; fojas en la línea de la cotización.

## 7. Entrega

1. La migración de correcciones de datos y los conflictos resueltos.
2. El precio por foja: columnas, cálculo, herramienta y `/calculate`.
3. La clasificación inicial (`fojas.json`, el script y el Excel para Leandro).
4. Los duplicados y la mensajería.
5. `estimar_tasa`.
6. El panel (Catálogo y Cotizaciones).
7. En producción, Jay corre la migración y el script de fojas.
