# Reglas de atención del bot (punto 3 del PDF de pendientes) — Diseño

Fecha: 2026-10-17 · Estado: borrador para revisión de Jay
Fuente: respuestas de Leandro al punto 3, "Reglas de atención", de `Guru-Bot-IA-Pendientes-Leandro.pdf`.

Decisiones de Jay (2026-10-17):
- **A. Inglés:** el bot contesta en el idioma del cliente.
- **B. Chat asignado sin respuesta:** a los 20 minutos se avisa al admin con la alarma.
- **C. Devoluciones:** se quita el 30% por trámite caído. Solo se devuelve en notarización y traducción.

## 1. Pasar a una persona según el tema

**`pasar_a_humano({ motivo, destino })`:** `destino` es `'admin'` o `'digitador'`. Si no viene, se toma `'digitador'`.
- **Admin:** se avisa a cada admin activo.
- **Digitador:** se avisa al asignado del cliente; si no hay asignado, a los admins. Es lo que pasa hoy.
- **Urgente fuera de horario:** igual que hoy. Se avisa al asignado y además a cada admin.

**Temas del admin:**
- reclamos de precio;
- temas administrativos o que haya que escalar a un superior;
- pagos, abonos y pagos no realizados;
- propuestas y proveedores;
- clientes importantes;
- descuentos, cuando el cliente insiste;
- devoluciones;
- clientes groseros o spam.

**Temas del digitador:**
- errores en contratos;
- malentendidos con la información;
- tickets y reclamos del servicio;
- pagos de un trabajo en curso;
- estado de una solicitud o de una certificación;
- seguimiento de trámites ligados a los documentos;
- procesos que siguen después, para hacer otro documento.

**Pagos en las dos listas:** Leandro pone "pagos" en ambas. Se distingue así:
- un reclamo, un abono o un pago que no se hizo va al admin;
- una pregunta del pago de su trabajo en curso va al digitador.
- Un comprobante sigue yendo por `avisar_pago`.

**Datos:** `business_info.temas_humano` pasa a ser `{ admin: [...], digitador: [...] }`. El contexto muestra las dos listas. Si se carga una lista vieja (un arreglo plano), se sigue aceptando.

## 2. Chat asignado: el bot se calla

**Al asignar un chat** (`POST /api/clients/:id/assign` con un usuario):
- el chat pasa a modo manual (`setManualMode(phone, true)`), y el bot deja de contestar ese chat;
- el cliente puede seguir escribiendo libremente;
- se guarda `wa_bot_state['assigned:<phone>'] = { at, user_id }`.

**Al quitar la asignación:** no cambia el modo. El admin vuelve a encender el bot con el botón 🤖, como hoy.

**Alarma de chat sin atender:**
- Un revisor corre cada minuto, junto a los recordatorios que ya existen.
- Avisa a los admins cuando se cumplen las cuatro condiciones:
  - el chat está asignado;
  - pasaron 20 minutos o más desde la asignación;
  - el negocio está abierto;
  - no hay ningún mensaje saliente desde la asignación.
- Como el bot está callado en ese chat, cualquier mensaje que sale es de una persona.
- **Aviso:** "⏰ Chat sin atender: <cliente> — asignado a <digitador> hace 20 min", con el enlace `/bot-messages?phone=…`.
- Avisa una sola vez por asignación: se marca `avisado: true` en el estado, igual que se evita el doble aviso de "urgente".
- Si la asignación se hace fuera de horario, los 20 minutos se cuentan desde que abre el negocio.

## 3. Reglas de la guía (`src/agent/guide.md`)

**Devoluciones** (reemplaza la Regla 11):
- En general no hay devolución.
- **Notarización y traducción:** se devuelve el 30%, o una persona lo acredita para un próximo trabajo.
- **Redacción:** no se devuelve, porque se hizo con la información que dio el cliente y costó tiempo y recursos.
- El bot nunca promete un reembolso. Cualquier caso pasa al admin.
- Sin respuesta de Leandro todavía: cómo se devuelve el dinero, en cuánto tiempo y qué pasa si el cliente cancela antes de empezar. El bot pasa esos casos al admin y no dice nada al respecto.

**Descuentos:** el bot nunca los ofrece. Si el cliente insiste, pasa al admin.

**Trato** (amplía la Regla 9):
- Jerga dominicana con respeto. Siempre "usted".
- El público incluye abogados, gestores, paralegales, mensajeros, representantes de empresas y funcionarios.
- **Cuidar la imagen de que cumplimos la ley:** los notarios y los intérpretes están en regla, y los catálogos y los libros de documentación están al día.
- Nunca decir que somos abogados. Somos gestores independientes y paralegales certificados; los únicos abogados son los notarios.

**Mensaje de espera:**
- `business_info.mensaje_espera` dice "Un Gurú de nuestro equipo se comunicará con usted a la brevedad…". El resto del texto no cambia.
- Se agrega `mensaje_espera_en`, la versión en inglés.

**Vigencia:**
- `business_info.vigencia_cotizacion_dias = 7`.
- El bot lo dice al preparar la cotización.
- El PDF de la cotización (solo el tipo COTIZACIÓN) agrega: "Cotización válida por 7 días a partir de su fecha."

**Quién emite la factura:** la nota de la guía queda así: "Las facturas las crea el equipo y las envía el admin o el número del negocio; usted no las envía".

**Trámites que no hacemos:**
- El bot gestiona solo lo que está en el catálogo.
- Las certificaciones son de 7 instituciones, guardadas en `business_info.instituciones`:
  - Relaciones Exteriores;
  - Plan Piloto;
  - Ministerio Público o Procuraduría;
  - Poder Judicial;
  - Jurisdicción Inmobiliaria o Tribunal de Tierras;
  - ONAPI;
  - Dirección General de Migración.
- Si el cliente pide algo fuera del catálogo, el bot dice con cortesía que ese trámite no lo gestionamos. No crea una solicitud ni pasa el chat.

**Inglés:**
- El bot contesta en el idioma en que escribe el cliente, español o inglés, con las mismas reglas.
- Aclara que los trámites son para usar en República Dominicana.
- `pasar_a_humano` devuelve `mensaje_espera_en` cuando el cliente escribe en inglés. Lo indica la herramienta con `idioma: 'en'`.

**Clientes groseros o spam:**
- El bot no discute. Llama a `pasar_a_humano` con `destino: 'admin'` y el motivo "cliente grosero" o "spam".
- No envía el mensaje de espera: el modo manual ya calla al bot.

**Quien escribe no es parte del documento:**
- Es lo normal: suelen ser gestores que hacen documentos para sus clientes.
- Somos una entidad neutral con los datos.
- El bot pide solo los datos que lleva el documento y no opina sobre la situación legal real.
- Usa el flujo `para_tercero` que ya existe, y no guarda los datos del tercero en la ficha del cliente.

## 4. Datos

Una migración idempotente, `migrations/20261017_reglas_atencion.sql`, que actualiza `business_info`:
- `temas_humano` pasa a `{ admin, digitador }`;
- `mensaje_espera` cambia a "Un Gurú…";
- se agregan `mensaje_espera_en`, `vigencia_cotizacion_dias` e `instituciones`.

## 5. Pruebas

- **`pasar_a_humano`:**
  - con `destino: 'admin'`, avisa solo a los admins aunque haya asignado;
  - con `destino: 'digitador'`, avisa al asignado, o a los admins si no hay;
  - con `idioma: 'en'`, devuelve `mensaje_espera_en`.
- **Asignar:**
  - asignar pone el chat en manual y guarda `assigned:<phone>`;
  - el bot no contesta un chat asignado.
- **Revisor de chats sin atender:**
  - a los 19 minutos no avisa;
  - a los 20 minutos avisa una vez;
  - si hubo un mensaje saliente, no avisa;
  - con el negocio cerrado, no avisa.
- **Contexto:** muestra las dos listas de temas, y acepta también el formato viejo.
- **PDF:** una cotización trae la vigencia y una factura no.
- **bot-eval, escenarios nuevos:**
  - reclamo de precio → admin;
  - error en un contrato → digitador;
  - pedir un reembolso de una redacción → no se promete y pasa al admin;
  - un trámite fuera del catálogo se rechaza con cortesía;
  - un cliente en inglés → respuesta en inglés;
  - un cliente grosero → admin, sin seguir conversando;
  - un gestor que pide un documento para su cliente → datos de tercero, sin opinar;
  - al cotizar, el bot dice "válida por 7 días".

## 6. Fuera de este diseño

- Los puntos 4 (privacidad), 5 (tiempos de entrega) y 6 (ejemplos) del PDF: Leandro los manda después.
- Los detalles que faltan de las devoluciones: método, plazo y cancelación.
