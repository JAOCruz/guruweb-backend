# Bot de WhatsApp, fase 2: documentos, envíos aprobados y pagos — Diseño

Fecha: 2026-10-06 · Estado: borrador para revisión de Jay
Fase 1 (base): `docs/superpowers/specs/2026-10-05-bot-agente-ia-design.md`

## 1. Objetivo

Que el bot complete el ciclo de un pedido sin que nada llegue al cliente sin aprobación humana:

1. **Conversa:** recoge los datos del cliente y lee los documentos que envía.
2. **Confirma el pedido:** le muestra al cliente un carrito en texto con los servicios y sus precios.
3. **Prepara para aprobación:** la cotización y, si el servicio tiene un modelo aprobado, el documento lleno.
4. **Entrega lo aprobado:** envía la cotización y el documento cuando un humano los aprueba (el documento, normalmente, cuando además el pago está confirmado).
5. **Recibe el pago:** toma el comprobante y avisa a Leandro, sin confirmar el pago nunca.

**Reglas que no cambian:**
- Nada sale al cliente sin aprobación humana. Eso incluye documentos, entregas y cotizaciones en PDF.
- Lo único que el bot puede mandar sin aprobación es el carrito en texto, para que el cliente confirme su pedido.
- El bot nunca confirma pagos.
- Todo se prueba primero en el número de prueba de Meta.

**Fuera de alcance:** plantillas de Meta para escribir fuera de las 24 h, campañas, firma electrónica y editor de la guía en el panel.

## 2. Conversación

**Espera antes de responder (solo chats con el motor nuevo):**
- El bot espera 8 s después del último mensaje.
- Si en esa espera llega una foto, un documento o un audio, el plazo se reinicia.
- Nunca espera más de 30 s desde el primer mensaje del lote.
- Así recibe todo lo que el cliente manda de golpe (cédula, matrícula, "quiero un acto de venta") y responde una sola vez.

**Primera respuesta con todo el material:**
- Evalúa lo recibido ("veo su cédula y la matrícula; entiendo que quiere un acto de venta del vehículo").
- Confirma los datos que leyó.
- Pide solo lo que falta, uno o dos datos por mensaje.
- Da el precio con las herramientas.

**Carrito:**
- Cuando el pedido está claro, el bot muestra en texto la lista de servicios con sus precios y el total. Los precios salen de las herramientas, nunca de memoria.
- Pregunta si eso es todo.
- Con el "sí" del cliente pasa a preparar la cotización y el documento.

**Cambios de tema:** si el cliente pregunta otra cosa a mitad del pedido, el bot la responde y retoma el pedido donde iba, sin perder los datos.

## 3. Documentos

**Modelos disponibles:**
- El bot solo llena modelos etiquetados y aprobados en Documentos → Etiquetas (`doc_templates.approved_tag_version_id`).
- Una aprobación sirve para el panel y para el bot.
- Si el servicio no tiene modelo aprobado, el bot crea la solicitud y el digitador hace el documento a mano, como hoy.

**Herramientas nuevas:**

| Herramienta | Qué hace | ¿Solo o con aprobación? |
|---|---|---|
| `ver_modelo(servicio)` | Busca el modelo aprobado que corresponde al servicio (por `service_catalog.template_id` o por nombre) y devuelve sus etiquetas (clave, etiqueta, rol) y cuáles ya están en la ficha legal | Solo |
| `preparar_documento(modelo, valores, rol_cliente)` | Llena el modelo con el mismo llenado exacto del panel (`fillTags`). Crea el documento en el historial del cliente como borrador del bot, sin aprobar y ligado a la cotización. Guarda los valores en la ficha legal | **Aprobación humana** |
| `avisar_pago(monto?, banco?, referencia?)` | Avisa a los admins que llegó un comprobante, con la foto, lo que se leyó y el enlace a la cotización. No marca nada como pagado | Solo |

**Reglas de llenado:**
- Las etiquetas salen de la versión aprobada.
- Los valores salen de la ficha legal, de la conversación y de las fotos leídas.
- Antes de llamar a `preparar_documento`, el bot muestra el resumen de los datos y el cliente lo confirma.
- Si falta una etiqueta, el bot la pide. No prepara documentos con espacios en blanco: la herramienta rechaza la llamada si falta algún valor y devuelve cuáles faltan.
- Los datos de la otra parte (comprador, vendedor…) se piden igual: nombre, cédula, o una foto de la cédula.

**Los 20 modelos iniciales:**
- Jay los elige entre los más pedidos: actos de venta (vehículo, motor, inmueble), poderes, declaraciones juradas, contratos de alquiler y de trabajo, cartas de no objeción…
- Se etiquetan por lotes con la IA (`POST /api/documentos/etiquetas/batch`) y los aprueba un admin.
- `service_catalog.template_id` se llena para esos servicios.
- Después se agregan más a pedido de Jay.

## 4. Aprobaciones y envíos

**Cotizaciones:**
- En Cotizaciones hay dos botones: "Aprobar" y "Aprobar y enviar". "Aprobar y enviar" aprueba y la envía al cliente por WhatsApp en el mismo paso.
- Sirve para todas las cotizaciones. Las que creó el bot traen el teléfono del chat.
- El envío lleva el PDF y un mensaje corto con el total, las formas de pago (transferencia o efectivo) y la dirección.

**Documentos:**
- En Documentos, un borrador del bot aparece como "Preparado por el bot", con un enlace a su cotización.
- Al aprobarlo se elige:
  - **"Enviar cuando pague"** (por defecto): sale en PDF en cuanto el pago de su cotización esté confirmado;
  - **"Enviar ya"**: sale en PDF al aprobarlo;
  - **"Solo aprobar"**: no se envía; el envío se hace después con un botón "Enviar al cliente".

**Pago confirmado:**
- Leandro confirma el pago con el botón que ya existe en Cotizaciones (`confirm-payment`).
- Al confirmarlo, los documentos de esa cotización aprobados con "Enviar cuando pague" salen.

**Servicio de entregas (`src/agent/delivery.js`):**
- Lo llaman las acciones del panel al aprobar, al confirmar el pago y al pulsar "Enviar al cliente".
- Revisa que se cumpla la condición y envía por WhatsApp.
- Registra el envío en Mensajes y en Actividad, con quién lo aprobó.
- No hay ningún proceso en segundo plano: solo actúa cuando una persona hace algo en el panel.

**Ventana de 24 h de Meta:**
- Si el envío falla porque pasaron más de 24 h desde el último mensaje del cliente (`WINDOW_CLOSED`), no se reintenta.
- Queda marcado "listo, sin enviar" y se avisa al admin: "La cotización o el documento de X está aprobado, pero WhatsApp no deja escribirle porque pasaron más de 24 h desde su último mensaje. Envíelo por otro medio, o espere a que el cliente escriba y pulse Enviar."

**Comprobantes:**
- Cuando el análisis de una foto parece un comprobante (transferencia, depósito, monto, banco), el bot llama a `avisar_pago`.
- Le dice al cliente que lo recibió y que el equipo lo verifica.
- El aviso a los admins lleva la foto, el monto leído y el enlace a la cotización abierta del cliente.

**Permiso de los digitadores:**
- Hay un switch en Configuración: "Los digitadores pueden aprobar y enviar documentos". Está apagado por defecto y solo lo cambia el admin.
- Encendido, el digitador asignado al cliente puede aprobar y enviar sus documentos.
- Las cotizaciones siguen siendo solo del admin.

## 5. Cambios en la base de datos

**`portfolio_documents`, columnas nuevas:**
- `invoice_id` (la cotización ligada);
- `prepared_by_bot BOOLEAN DEFAULT false`;
- `send_mode` (`al_pagar` | `ya` | `manual`, null hasta aprobarse);
- `sent_at`;
- `send_error` (texto corto, por ejemplo `WINDOW_CLOSED`).

**`invoices`, columnas nuevas:**
- `sent_by_bot_at`;
- `send_error`.

**Configuración:** la clave `digitadores_aprueban_documentos` (booleano) en `business_info`.

**`bot_tool_log`:** registra también `ver_modelo`, `preparar_documento` y `avisar_pago`.

## 6. Panel (frontend)

**Cotizaciones:**
- Botón "Aprobar y enviar" junto a "Aprobar".
- Estado "Enviada por WhatsApp", o "Lista, sin enviar (más de 24 h)" con el botón de enviar.

**Documentos:**
- Etiqueta "Preparado por el bot" y enlace a la cotización.
- El diálogo de aprobar tiene las tres opciones de envío.
- Botón "Enviar al cliente".
- Se ve el estado del envío.

**Configuración:** el switch de los digitadores.

**Notificaciones:** comprobante recibido, envío hecho y envío bloqueado por las 24 h.

## 7. Fallos

| Situación | Qué pasa |
|---|---|
| El envío falla por las 24 h | Queda "lista, sin enviar" y se avisa al admin |
| El envío falla por otra razón | Se reintenta una vez. Si vuelve a fallar, queda "lista, sin enviar" y se avisa al admin con el motivo, sin datos del cliente |
| Falla la conversión del documento a PDF | No se envía y se avisa. Nunca se envía el Word editable |
| Un digitador sin permiso intenta aprobar | 403, igual que hoy |
| Doble clic en "Aprobar y enviar" | Un solo envío (`sent_at` se marca de forma atómica) |

## 8. Pruebas

- **Pruebas automáticas:** cada herramienta y cada regla de envío, contra la base de datos de prueba:
  - aprobar con cada modo;
  - pagar antes o después de aprobar;
  - las 24 h;
  - el doble clic;
  - el permiso de los digitadores encendido y apagado;
  - el documento con una etiqueta faltante.
- **Pruebas de la espera de 8–30 s**, con el reloj simulado.
- **Conversaciones nuevas en la batería:**
  - el cliente manda todo de golpe;
  - cambia de tema y vuelve;
  - manda un comprobante;
  - faltan los datos de la otra parte;
  - el servicio no tiene modelo aprobado.
- **Frontend:** pruebas de los botones nuevos, del diálogo de aprobar y del switch.
- **Número de prueba de Meta:** un pedido completo de un acto de venta, desde las fotos hasta el PDF entregado.

## 9. Fases de entrega

1. Espera de 8–30 s, carrito, cambios de tema y `avisar_pago`.
2. "Aprobar y enviar" en las cotizaciones y el servicio de entregas.
3. `ver_modelo`, `preparar_documento`, la aprobación de documentos con los modos de envío, el switch de los digitadores y la entrega al pagar.
4. Los 20 modelos etiquetados (lo aprueban ustedes) y las pruebas de punta a punta.
