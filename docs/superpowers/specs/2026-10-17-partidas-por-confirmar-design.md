# Partidas por confirmar y reglas de rango (respuesta de Leandro) — Diseño

Fecha: 2026-10-17 · Estado: borrador para revisión de Jay
Fuente: respuesta de Leandro a la pregunta 12 del documento de pendientes ("regla para elegir dentro de los rangos").

Decisiones de Jay (2026-10-17):
- Cuando un precio es un rango, el bot da el rango y el digitador pone el precio final.
- El precio de una cotización del bot lo ponen el digitador asignado al cliente o el admin, como siempre. Si el cliente no tiene asignado, solo el admin.

## 1. Partida por confirmar

Hoy, si una partida no tiene precio fijo, `preparar_cotizacion` rechaza la cotización entera. Además, en los servicios que tienen rango y precio fijo, el bot pone el precio fijo sin avisar.

**Nuevo formato de línea** en `invoices.items`. Los campos nuevos son opcionales:

```
{ desc, cantidad, precio,            // precio: null mientras esté por confirmar
  por_confirmar: true,
  rango: { min, max } | null,        // total de la línea (ya multiplicado por cantidad y fojas)
  precio_sugerido: number | null,    // estimado del bot, si lo hay
  nota: string | null }              // por qué está por confirmar
```

**Cómo la arma el bot:**
- Una partida queda por confirmar cuando `calculatePrice` devuelve un `rango` o el servicio está `por_confirmar`.
  - Si trae `rango`, el precio queda en `null`.
  - Si el servicio está por confirmar pero tiene precio, ese precio pasa a ser `precio_sugerido`.
- La cotización se crea igual, sin rechazarse.
- **Total:** el subtotal y el total suman solo las líneas con precio. En la cotización, el PDF y la respuesta al cliente, las líneas por confirmar salen como "por confirmar (RD$min – RD$max)".
- **Lo que dice el bot:** da el rango, o el estimado como "aproximado", y dice que el digitador confirma el precio exacto. Nunca inventa un monto: el control de precios ya deja pasar `rango.min`, `rango.max` y los totales que salen de las herramientas.
- **Aviso:** se le avisa al asignado del cliente, o a los admins si no hay asignado, con "💲 Cotización con precios por confirmar" y el enlace `/cotizaciones?invoice=<id>`. Se usa la alarma nueva.

**Confirmar el precio:**
- **Quién:** el digitador asignado al cliente (`clients.assigned_to`) o el admin.
- **Qué puede hacer:** ver la cotización del bot y editar los precios de **cualquier** línea mientras esté en `draft` o `pending_approval`.
- **Qué no puede hacer el digitador:** cambiar el estado ni enviarla.
- **Precio fuera del rango:** se acepta, pero la pantalla avisa.
- **Al poner el precio:** se borra `por_confirmar` y se recalcula el total.
- **Botón "Confirmar":** en las líneas con `precio_sugerido`, copia ese precio de un clic.
- **Candado:** `approve`, `approve-and-send` y `send` responden `400 { code: 'PRICES_PENDING' }` mientras quede una línea por confirmar. La pantalla del admin explica por qué no puede aprobar.

**Pantalla de Cotizaciones:**
- Las líneas por confirmar salen resaltadas, con el rango, la nota y un campo de precio.
- Arriba: "N precios por confirmar".
- El digitador asignado ve el botón "Poner precios" en las cotizaciones del bot de sus clientes.
- Hoy un empleado no puede ver una cotización sin aprobar (`blockUnapproved`). Esto se abre solo para el asignado y solo para las cotizaciones del bot.

## 2. Reglas de Leandro por tipo de servicio

**Modificación** (el cliente trae el modelo y solo se cambian datos):
- Es un nuevo `foja_tipo` llamado `modificacion`, a 150 la foja.
- **Desde 3 fojas, todas modificadas:** queda un rango de 100 a 150 la foja (× fojas × cantidad), por confirmar.
- **Con menos de 3 fojas:** 150 la foja, precio fijo.
- **"Modificación de Documento Existente"** (hoy 100 por documento) pasa a `foja_tipo = modificacion`, con 1 foja estimada.
- **Regla de la guía:**
  - el bot pregunta si son todas las fojas o solo algunas;
  - si son muchos cambios, sigue recomendando redacción, como ya dice la regla actual.

**Redacción:** las 4 tarifas ya existen. Se reclasifica según el texto de Leandro:
- **Notificaciones** (Sencilla, Avanzada y Personalizada, hoy en Mensajería sin `foja_tipo`): pasan a `carta_motivada`, 300 la foja. La Sencilla sube de 150 a 300.
- **Notoriedades** (las 8 que hoy están en `legal_simple`): pasan a `legal_motivada`, 350 la foja.
- **Qué es "motivado"** (aclaración de Leandro del 2026-10-17): convertir hechos sueltos en lenguaje jurídico. Eso es lo que hace motivado un documento, y por eso son textos más complejos o exclusivos: carta motivada a 300 o legal motivada a 350, según el tamaño.
- **Texto suministrado por el cliente** (escrito a mano o enviado por WhatsApp): no es una redacción motivada.
  - **Si el texto ya está redactado** y solo hay que pasarlo, aunque sea a un contrato: se cobra **Revisión y Formato** (rango por confirmar) **más la impresión**.
  - **Si lo que trae son hechos o ideas** que hay que convertir en lenguaje jurídico: es redacción motivada, por foja.
  - El bot pregunta cuál de los dos casos es, y el digitador confirma.
- Las dos reglas van en la guía.

**Certificaciones:**
- Se cobran por unidad. Cada una lleva sus propios impuestos, su garantía y su política de devolución.
- **Regla de la guía:** el bot pregunta cuántas son y multiplica. Por ejemplo, el viaje de menor se cobra por cada menor.

**Notarización:** sin cambio. Se cotiza 1 original, con duplicado para los demás, desde la ronda 1. La guía aclara que es una gestión, no una redacción.

**Traducción:**
- **Regla de la guía:** el bot pregunta si los documentos van cada uno con su firma o juntos con una sola firma.
- Las líneas de traducción siempre quedan por confirmar, con el precio por página como `precio_sugerido` y la nota "Individual o en conjunto: lo confirma el digitador".

**Servicios con rango y precio fijo** (Revisión y Formato 50–150, Apostilla en Cancillería 250–300, Formularios de Migración 600–800):
- Se les quita el precio fijo (`digitacion_price = NULL`) y quedan como rango.
- En la cotización salen como partidas por confirmar.

## 3. Datos

Una migración idempotente, `migrations/20261017_partidas_por_confirmar.sql`, que:
- quita `digitacion_price` en los 3 servicios con rango;
- marca la categoría de traducciones como por confirmar con precio sugerido. La marca se lee en `calculatePrice`, así que no hace falta otra columna: se usa `por_confirmar = true`, que el bot ya conoce;
- agrega `modificacion` donde haga falta. `foja_tipo` es texto, así que no hay que cambiar el esquema.

Además:
- `seeds/bot/fojas.json`: notificaciones en `carta_motivada`, notoriedades en `legal_motivada` y Modificación en `modificacion`. Lo aplica `scripts/fojas/apply.js`.
- `fojaRates.js` en el backend y `src/lib/fojaRates.ts` en el dashboard: se agrega `modificacion: 150` y la regla de 3 fojas o más de 100 a 150.

## 4. Pruebas

- **`calculatePrice` con Modificación:**
  - con 2 fojas: precio fijo de 300;
  - con 3 fojas: rango de 300 a 450, con `total` null.
- **`preparar_cotizacion`:**
  - con un servicio de rango: crea la cotización con una línea por confirmar;
  - con una traducción: la línea lleva el precio sugerido;
  - el total excluye las líneas por confirmar;
  - avisa al asignado, o a los admins si no hay asignado.
- **Rutas:**
  - el digitador asignado puede poner precios en una cotización del bot de su cliente;
  - otro digitador recibe 403;
  - el digitador no puede aprobar;
  - aprobar o enviar con líneas por confirmar da 400 `PRICES_PENDING`;
  - el admin puede editar siempre.
- **Guía y escenarios del bot:**
  - un precio con rango se dice como rango y luego se arma la cotización;
  - en una traducción, el bot pregunta si van juntas o separadas;
  - en una certificación, el bot pregunta cuántas son;
  - en una Modificación de 3 fojas, el bot da el rango.
- **Dashboard:**
  - las líneas resaltadas;
  - el campo de precio con aviso cuando está fuera del rango;
  - "Confirmar" en las líneas con precio sugerido;
  - el botón de aprobar bloqueado mientras falten precios.

## 5. Fuera de este diseño

- El resto del documento de pendientes: Leandro sigue mandando respuestas.
- Que el digitador cambie el estado o envíe cotizaciones del bot. Eso sigue siendo del admin.
