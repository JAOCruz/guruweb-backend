# Bot de WhatsApp con IA y herramientas — Plan de implementación (Fase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** que el bot converse de forma natural y, con herramientas, dé precios reales del catálogo, guarde los datos del cliente, cree la solicitud, prepare la cotización para el admin y pase el chat a una persona.

**Architecture:** un módulo nuevo `src/agent/` recibe el mismo lote de mensajes que hoy recibe `routeMessage` (desde `processBatch` en `src/whatsapp/handler.js`). Un selector de motor (`engineFor(phone)`) decide si el chat va al motor viejo o al agente. El agente arma el contexto (guía, datos del negocio, ficha del cliente, últimos 30 mensajes), llama al modelo mediante un adaptador (Gemini o Claude) y ejecuta las herramientas en un ciclo de máximo 6 llamadas. Los precios solo salen de las herramientas. Un filtro final bloquea cualquier monto que no haya salido de una herramienta.

**Tech Stack:** Node ≥20, Express, PostgreSQL (`pg`), `node:test`, `@google/generative-ai` 0.24 (function calling), `@anthropic-ai/sdk` (nuevo, solo para el adaptador Claude), frontend React 19 + vitest (repo `guru-frontend-dev`, Task 12).

**Spec:** `docs/superpowers/specs/2026-10-05-bot-agente-ia-design.md` (secciones 1–9). Los valores por defecto acordados con Jay el 2026-10-05 están en "Valores por defecto" más abajo; prevalecen sobre la sección 9 del spec hasta que Leandro responda.

## Global Constraints

- Idioma de todo lo que ve el cliente: español (RD). Trato por defecto: "usted".
- Modelo por defecto: Gemini `gemini-2.5-flash` (`BOT_AI_PROVIDER=gemini`); alternativo: `BOT_AI_PROVIDER=claude`, con el modelo en `BOT_CLAUDE_MODEL` (por defecto `claude-sonnet-5-5`).
- Motor: `BOT_ENGINE=legacy|agent` (por defecto `legacy`). `BOT_AGENT_PHONES` es una lista separada por comas de los teléfonos que usan el agente aunque `BOT_ENGINE=legacy`.
- Por turno: máximo 6 llamadas a herramientas y 25 s de tiempo para el modelo; un reintento. Si vuelve a fallar, el chat pasa a una persona.
- Contexto: los últimos 30 mensajes. Los precios nunca van en el contexto.
- Horario: lunes a viernes, de 9:00 a 18:00, zona `America/Santo_Domingo`.
- Mensaje de espera (texto exacto): `Un miembro de nuestro equipo se comunicará con usted a la brevedad. ⏰ Horario de atención: Lunes a Viernes, 9:00 a 18:00 hrs. Si su asunto es urgente fuera de horario, por favor indíquelo escribiendo 'urgente'.`
- Pagos: transferencia o efectivo. Envío y recogida dentro del horario. Dirección: Av. Independencia 1607, Santo Domingo.
- El agente nunca importa `src/llm/systemPrompt.js` ni `src/knowledge/services.js`. Esos archivos no se tocan en este plan: el motor viejo sigue funcionando.
- Los registros (`console.log`) nunca incluyen el texto de los mensajes ni datos del cliente. Solo teléfono, nombres de herramientas y tiempos.
- Secretos: solo variables de Railway. Nunca se leen `.env` ni se imprimen.
- Pruebas: `npm test` (`node --test --test-concurrency=1 test/*.test.js`) contra `guru_test` local. Cada prueba crea sus tablas mínimas, como `test/whatsapp-archive.test.js`. `RAILWAY_VOLUME_MOUNT_PATH` apunta a un directorio temporal.
- En `npm test` nunca se llama a un modelo real: se usa el proveedor falso (Task 3). Los modelos reales solo corren en `npm run bot:eval` (Task 11).
- Commits: uno por tarea, en `main` del backend, **sin push**. El push y la carga de datos en Railway los hace Jay.

## Valores por defecto (hasta que Leandro responda)

| Falta | Comportamiento |
|---|---|
| Servicio sin precio | La herramienta devuelve `precio: null`; el bot dice que lo confirma y crea la solicitud para el digitador |
| Precio en conflicto (estatus jurídico, instancias, estatutos, nómina, foto 2x2, escáner, fotocopia 11x17) | Columna `por_confirmar = true`; la herramienta no devuelve el monto |
| Tramos de actos de venta | Se usan los del catálogo. Los tramos de 3M en adelante se marcan `por_confirmar: true` |
| Rangos | Columna `precio_rango {min,max}`; el bot da el rango y dice que el digitador lo confirma |
| Temas que van a una persona | Reclamaciones, pagos, reembolsos, asesoría legal, casos en tribunal |
| Descuentos | No ofrece; los pasa al admin |
| Tiempos de entrega | `tiempo_entrega` vacío → "el digitador le confirma" |

## Review Focus

1. El cliente escribe "urgente" después de que el bot pasó el chat a una persona (el chat ya está en manual). El agente no corre, pero el admin debe recibir el aviso marcado urgente, una sola vez. La prueba va en Task 9.
2. Llega un segundo lote del mismo teléfono mientras el agente todavía responde el primero. Los turnos de un mismo teléfono van uno tras otro, sin respuestas dobles ni cruzadas. La prueba va en Task 8.
3. El modelo pide una herramienta que no existe o con argumentos inválidos. La herramienta devuelve `{error}` al modelo, el turno sigue y no se cae nada. La prueba va en Task 8.
4. El modelo escribe un monto (RD$ o número con "pesos") que no salió de ninguna herramienta en esta conversación. El filtro lo cambia por "se lo confirmo" y registra el bloqueo. La prueba va en Task 8.
5. Un lote con solo una foto o una nota de voz, sin texto. El agente recibe la transcripción o el análisis guardado como texto del cliente y responde normalmente. La prueba va en Task 8.

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `migrations/20261005_bot_agent.sql` | Columnas nuevas de `service_catalog`; tablas `tramites`, `business_info`, `bot_memory`, `bot_tool_log`; usuario `bot` |
| `src/models/servicePricing.js` | Cálculo de precio compartido (lo usan la ruta `/calculate` y la herramienta) |
| `src/agent/provider/index.js`, `gemini.js`, `claude.js`, `fake.js` | Adaptadores del modelo con una sola interfaz |
| `src/agent/businessInfo.js` | Datos del negocio y `isOpen(date)` |
| `src/agent/tools/*.js` + `src/agent/tools/index.js` | Las 9 herramientas y su registro |
| `src/agent/guide.md` | Guía del bot: identidad, tono y las 11 reglas, sin precios |
| `src/agent/context.js` | Arma el sistema y el historial de cada turno |
| `src/agent/priceGuard.js` | Bloquea montos que no salieron de herramientas |
| `src/agent/memory.js` | Resumen por cliente en `bot_memory` |
| `src/agent/agent.js` | Ciclo del turno: `respond(phone, text, opts)` |
| `src/agent/engine.js` | `engineFor(phone)` |
| `src/whatsapp/handler.js` | Conectar el agente y el aviso "urgente" |
| `src/routes/messages.js` | Devolver las herramientas usadas por cada mensaje del bot |
| `src/db/seedBotKnowledge.js` + `seeds/bot/*.json` | Carga inicial: reglas, trámites, precios que faltan, conflictos |
| `scripts/bot-eval.js` + `test/agent/escenarios/*.json` | Batería con modelo real, comparación Gemini vs Claude |
| `guru-frontend-dev/apps/dashboard/src/pages/BotMessages.tsx` | Mostrar las herramientas bajo cada respuesta del bot |

---

### Task 1: Migración y cálculo de precio compartido

**Files:**
- Create: `migrations/20261005_bot_agent.sql`, `src/models/servicePricing.js`, `test/bot-agent-migration.test.js`, `test/service-pricing.test.js`
- Modify: `src/routes/serviceCatalog.js:56-117` (la ruta `/calculate` usa `calculatePrice`)

**Interfaces:**
- Produces:
  - **Columnas nuevas de `service_catalog`:**
    - `descripcion TEXT`, `incluye TEXT`, `reglas TEXT`, `requisitos TEXT`;
    - `alias TEXT[] DEFAULT '{}'`;
    - `notarizacion TEXT CHECK (notarizacion IN ('opcional','obligatoria','no_aplica'))`;
    - `template_id TEXT`, `tiempo_entrega TEXT`;
    - `por_confirmar BOOLEAN NOT NULL DEFAULT false`;
    - `precio_rango JSONB` (`{min,max}`).
    - En `price_tiers`, cada tramo puede llevar `por_confirmar: true`.
  - **`tramites`:**
    - `id SERIAL`, `nombre TEXT UNIQUE NOT NULL`, `alias TEXT[] DEFAULT '{}'`;
    - `pasos JSONB NOT NULL DEFAULT '[]'` (cada uno `{orden, descripcion, servicio, preguntas: [text]}`; `servicio` es el nombre exacto en el catálogo o null);
    - `preguntas_obligatorias TEXT[] DEFAULT '{}'`, `reglas TEXT`, `activo BOOLEAN DEFAULT true`.
  - **`business_info`:** `(clave TEXT PRIMARY KEY, valor JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW())`. Se siembra con:
    - `horario` = `{"dias":[1,2,3,4,5],"abre":"09:00","cierra":"18:00","zona":"America/Santo_Domingo"}`;
    - `direccion` = `"Av. Independencia 1607, Santo Domingo"`;
    - `formas_pago` = `["transferencia","efectivo"]`;
    - `entregas` = `"Envío y recogida dentro del horario"`;
    - `mensaje_espera` = el texto exacto de Global Constraints;
    - `trato` = `"usted"`;
    - `temas_humano` = `["reclamaciones","pagos","reembolsos","asesoría legal","casos en tribunal"]`.
    - Todo con `ON CONFLICT DO NOTHING`.
  - **`bot_memory`:** `(client_id INT PRIMARY KEY, resumen TEXT NOT NULL, hasta_mensaje_id INT, updated_at TIMESTAMPTZ DEFAULT NOW())`.
  - **`bot_tool_log`:**
    - `id SERIAL`, `phone TEXT NOT NULL`, `message_id INT` (el saliente del bot);
    - `herramienta TEXT NOT NULL`, `args JSONB`, `resultado JSONB`, `ok BOOLEAN`, `ms INT`;
    - `created_at TIMESTAMPTZ DEFAULT NOW()`; índice `(phone, created_at)`.
  - **Usuario del bot:** `INSERT INTO users (username, name, role, password_hash, is_active, in_payroll) VALUES ('bot','Bot Gurú','digitador','!',false,false) ON CONFLICT DO NOTHING`. Con `is_active=false` nunca puede iniciar sesión.
  - **`calculatePrice(service, { assetValue = null, quantity = 1, includeNotarization = true }) → { total: number|null, breakdown: { digitacion, notarizacion }, porConfirmar: boolean, rango: {min,max}|null, tramo: string|null }`.** Reglas:
    - `total` es `null` cuando `service.por_confirmar`, cuando el tramo que coincide tiene `por_confirmar`, o cuando no hay ningún precio.
    - `rango` sale de `precio_rango`.
    - Mismo algoritmo de tramos que la ruta actual: `min ≤ valor ≤ max`, con `max` null como abierto.
  - La ruta `POST /api/service-catalog/calculate` responde igual que hoy y agrega `porConfirmar` y `rango`.

- [ ] **Step 1: Escribir las pruebas que fallan**

`test/service-pricing.test.js`: es puro, sin base de datos; el servicio se pasa como objeto.
```js
const ACTO = { digitacion_price: '250', notarizacion_price: '500', price_tiers: [
  { min: 0, max: 100000, price: 500 }, { min: 100001, max: 800000, price: 700 },
  { min: 3000001, max: 5000000, price: 3000, por_confirmar: true }, { min: 5000001, max: null, price: 5000, por_confirmar: true }] };
test('acto de venta de 500K: digitación 250 + tramo 700 = 950', () => {
  assert.deepEqual(calculatePrice(ACTO, { assetValue: 500000 }).total, 950);
});
test('un tramo por confirmar no da monto', () => {
  const r = calculatePrice(ACTO, { assetValue: 4000000 });
  assert.equal(r.total, null); assert.equal(r.porConfirmar, true);
});
test('un servicio por confirmar no da monto aunque tenga precio', () => {
  assert.equal(calculatePrice({ digitacion_price: '1000', por_confirmar: true }).total, null);
});
test('sin ningún precio el total es null, no 0', () => {
  assert.equal(calculatePrice({ digitacion_price: null, notarizacion_price: null }).total, null);
});
test('cantidad multiplica y el rango se devuelve', () => {
  const r = calculatePrice({ digitacion_price: '250', precio_rango: { min: 250, max: 300 } }, { quantity: 2 });
  assert.equal(r.total, 500); assert.deepEqual(r.rango, { min: 250, max: 300 });
});
```
`test/bot-agent-migration.test.js`:
- crea `service_catalog` y `invoices` mínimos y la tabla `users` con `resetDb()` más `migrations/20260926_user_management.sql`;
- corre la migración dos veces (es idempotente);
- comprueba:
  - las columnas nuevas existen;
  - `business_info.mensaje_espera` es igual al texto exacto;
  - el usuario `bot` existe con `is_active=false`.

- [ ] **Step 2: Correr las pruebas y ver que fallan**

Run: `node --test test/service-pricing.test.js test/bot-agent-migration.test.js`
Expected: FAIL ("Cannot find module '../src/models/servicePricing'" y que la migración no existe).

- [ ] **Step 3: Escribir la migración y `calculatePrice`; cambiar la ruta `/calculate` para que use `calculatePrice`**

Toda la migración es idempotente: `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `ON CONFLICT DO NOTHING`.

- [ ] **Step 4: Correr las pruebas y toda la suite**

Run: `npm test`
Expected: todo pasa (194 + las nuevas).

- [ ] **Step 5: Commit**
```bash
git add migrations/20261005_bot_agent.sql src/models/servicePricing.js src/routes/serviceCatalog.js test/service-pricing.test.js test/bot-agent-migration.test.js
git commit -m "feat(bot): agent tables, bot user and shared price calculation with por-confirmar"
```

---

### Task 2: Datos del negocio y horario

**Files:**
- Create: `src/agent/businessInfo.js`, `test/agent-business-info.test.js`

**Interfaces:**
- Consumes: la tabla `business_info` (Task 1).
- Produces:
  - `getBusinessInfo() → Promise<object>`: claves → valores; se cachea 60 s; `clearCache()` para pruebas.
  - `isOpen(date: Date, horario) → boolean`.
  - `formatForPrompt(info) → string`: texto corto en español con horario, dirección, formas de pago y entregas.

- [ ] **Step 1: Escribir las pruebas que fallan**
```js
const H = { dias: [1,2,3,4,5], abre: '09:00', cierra: '18:00', zona: 'America/Santo_Domingo' };
test('martes 10:00 en RD está abierto', () => assert.equal(isOpen(new Date('2026-10-06T14:00:00Z'), H), true));
test('martes 18:30 en RD está cerrado', () => assert.equal(isOpen(new Date('2026-10-06T22:30:00Z'), H), false));
test('sábado al mediodía está cerrado', () => assert.equal(isOpen(new Date('2026-10-10T16:00:00Z'), H), false));
test('formatForPrompt incluye la dirección y "transferencia o efectivo"', async () => { /* siembra business_info, verifica que el texto contiene 'Av. Independencia 1607' y 'transferencia o efectivo' */ });
```
- [ ] **Step 2:** Run: `node --test test/agent-business-info.test.js`. Expected: FAIL (módulo no existe).
- [ ] **Step 3:** Implementarlo. Para la hora en RD se usa `Intl.DateTimeFormat` con `timeZone`, sin librerías nuevas.
- [ ] **Step 4:** Run: `npm test`. Expected: todo pasa.
- [ ] **Step 5:** Commit: `feat(bot): business info and opening hours for the agent`.

---

### Task 3: Adaptadores del modelo (Gemini, Claude y falso)

**Files:**
- Create: `src/agent/provider/index.js`, `src/agent/provider/gemini.js`, `src/agent/provider/claude.js`, `src/agent/provider/fake.js`, `test/agent-provider.test.js`
- Modify: `package.json` (dependencia `@anthropic-ai/sdk`)

**Interfaces:**
- **Formato común de mensajes:** `{ role: 'user'|'assistant'|'tool', text?, toolCalls?: [{id, name, args}], toolCallId?, name?, result? }`.
- **Herramientas:** `[{ name, description, parameters }]`, donde `parameters` es JSON Schema en minúsculas (`type: 'object'`, `properties`, `required`).
- **`provider.chat({ system, messages, tools, timeoutMs }) → Promise<{ text: string, toolCalls: [{id, name, args}] }>`.**
- **Errores:** si el proveedor indica cuota agotada (`429`, `RESOURCE_EXHAUSTED`, `quota`), lanza un `Error` con `code = 'QUOTA'`. Si se pasa del tiempo, lanza un `Error` con `code = 'TIMEOUT'`.
- **`getProvider(name = process.env.BOT_AI_PROVIDER || 'gemini')`:**
  - `'fake'` sirve solo para pruebas;
  - `createFakeProvider(script: Array<{text?, toolCalls?} | (messages) => {text?, toolCalls?}>)` devuelve cada paso en orden y guarda `calls` (lo que recibió) para revisarlo.
- **Gemini:**
  - `getGenerativeModel({ model: 'gemini-2.5-flash', systemInstruction: system, tools: [{ functionDeclarations }], generationConfig: { temperature: 0.4 } })`;
  - convierte `type` a mayúsculas (`SchemaType`);
  - `assistant` → rol `model` con partes `functionCall`; `tool` → rol `function` con `functionResponse { name, response: result }`;
  - lee `response.functionCalls()`.
- **Claude:**
  - `new Anthropic().messages.create({ model, system, max_tokens: 1024, tools: [{name, description, input_schema}], messages })`;
  - `assistant` → bloques `tool_use`; `tool` → mensaje `user` con bloque `tool_result`.

- [ ] **Step 1: Escribir las pruebas que fallan.** Usan solo el proveedor falso y las funciones puras de conversión, sin red:
```js
test('fake devuelve los pasos en orden y guarda lo que recibió', async () => {
  const p = createFakeProvider([{ toolCalls: [{ id: '1', name: 'buscar_servicio', args: { consulta: 'acto de venta' } }] }, { text: 'Listo' }]);
  assert.equal((await p.chat({ system: 's', messages: [], tools: [] })).toolCalls[0].name, 'buscar_servicio');
  assert.equal((await p.chat({ system: 's', messages: [], tools: [] })).text, 'Listo');
  assert.equal(p.calls.length, 2);
});
test('gemini: toGeminiContents convierte una llamada y su resultado', () => {
  const c = toGeminiContents([{ role: 'user', text: 'hola' },
    { role: 'assistant', toolCalls: [{ id: 'a', name: 'x', args: { q: 1 } }] },
    { role: 'tool', toolCallId: 'a', name: 'x', result: { ok: true } }]);
  assert.deepEqual(c.map((m) => m.role), ['user', 'model', 'function']);
  assert.deepEqual(c[2].parts[0].functionResponse, { name: 'x', response: { ok: true } });
});
test('gemini: toGeminiSchema pone los tipos en mayúsculas, también los anidados', () => {
  assert.equal(toGeminiSchema({ type: 'object', properties: { a: { type: 'array', items: { type: 'string' } } } }).properties.a.items.type, 'STRING');
});
test('claude: toClaudeMessages agrupa el tool_result en un mensaje user', () => { /* misma entrada; espera roles ['user','assistant','user'] y content[0].type === 'tool_result' con tool_use_id 'a' */ });
test('isQuotaError reconoce 429 y RESOURCE_EXHAUSTED', () => { /* ambos → true; 'timeout' → false */ });
```
- [ ] **Step 2:** Run: `node --test test/agent-provider.test.js`. Expected: FAIL.
- [ ] **Step 3:** Ejecutar `npm install @anthropic-ai/sdk` e implementar. Exportar `toGeminiContents`, `toGeminiSchema` y `toClaudeMessages` desde sus archivos, e `isQuotaError` desde `index.js`. El tiempo límite se hace con `Promise.race` y `timeoutMs` (por defecto 25000).
- [ ] **Step 4:** Run: `npm test`. Expected: todo pasa.
- [ ] **Step 5:** Commit: `feat(bot): swappable model adapters (Gemini, Claude, fake for tests)`.

---

### Task 4: Herramientas de catálogo y trámites

**Files:**
- Create: `src/agent/tools/catalog.js`, `src/agent/tools/tramites.js`, `src/agent/text.js`, `test/agent-tools-catalog.test.js`

**Interfaces:**
- Consumes: `calculatePrice` (Task 1).
- Produces:
  - **`fold(s) → string`:** minúsculas, sin acentos, espacios simples. Va en `src/agent/text.js`.
  - **`buscar_servicio({ consulta }) → { resultados: [{ id, nombre, categoria, precio, rango, por_confirmar, incluye, reglas, requisitos, notarizacion, tiempo_entrega, unidad }] }`.**
    - Máximo 5, ordenados por puntaje.
    - El puntaje cuenta las palabras de la consulta (≥3 letras, después de `fold`) que aparecen en el nombre o en un alias. Un alias igual a la consulta completa suma 10.
    - `precio` es `calculatePrice(s).total`, así un servicio por confirmar da `null`.
    - Solo servicios con `active = true`.
    - Sin coincidencias: `{ resultados: [] }`.
  - **`calcular_precio({ servicio_id, valor_del_bien?, cantidad?, con_notarizacion? }) → { servicio, total, desglose, por_confirmar, rango, tramo }`.** Si el servicio no existe: `{ error: 'servicio no encontrado' }`.
  - **`ver_tramite({ nombre }) → { nombre, pasos: [{orden, descripcion, servicio, precio, preguntas}], preguntas_obligatorias, reglas, total, faltan_precios: [nombres] }`.**
    - Se busca por `fold` en el nombre o los alias.
    - `total` es la suma de los precios de los pasos. Si algún paso no tiene precio o está por confirmar, `total = null` y ese paso va en `faltan_precios`.
    - Si no existe: `{ error: 'trámite no encontrado', disponibles: [nombres] }`.

- [ ] **Step 1: Escribir las pruebas que fallan.** Siembran `service_catalog` y `service_categories` mínimos y una fila en `tramites`:
```js
test('"venta del carro" encuentra el acto de venta de vehículo por su alias', async () => {
  const r = await buscar_servicio({ consulta: 'venta del carro' });
  assert.equal(r.resultados[0].nombre, 'Acto de Venta - Vehículo Liviano');
});
test('busca sin importar acentos: "vehiculo" encuentra "Vehículo"', ...);
test('un servicio por confirmar sale con precio null y por_confirmar true', ...);
test('calcular_precio con valor 500000 da 950 y el tramo', ...);
test('calcular_precio con un id que no existe devuelve error, no lanza', ...);
test('ver_tramite suma los pasos con precio', async () => { /* pasos 700 + 1000 → total 1700 */ });
test('ver_tramite con un paso sin precio: total null y lo lista en faltan_precios', ...);
test('ver_tramite desconocido devuelve los disponibles', ...);
```
- [ ] **Step 2:** Run: `node --test test/agent-tools-catalog.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implementarlo. El catálogo activo (unos 280 registros) se lee completo y el puntaje se calcula en JS, sin la extensión `unaccent`.
- [ ] **Step 4:** Run: `npm test`. Expected: todo pasa.
- [ ] **Step 5:** Commit: `feat(bot): catalog and trámite tools`.

---

### Task 5: Herramientas del cliente y de solicitudes

**Files:**
- Create: `src/agent/tools/client.js`, `src/agent/tools/requests.js`, `test/agent-tools-client.test.js`
- Modify: `src/conversation/flows/intake.js:493` (exportar `generateCaseNumber`)

**Interfaces:**
- Consumes:
  - `legalProfile.get/merge` (`src/documentos/legalProfile.js`);
  - `Client.findByPhone/update` y `Case.create`;
  - `Notification.create({ userId, type, title, message, link, metadata })`;
  - `analyzeDocument(filePath, mimeType, mediaType)` (`src/llm/mediaAnalysis.js`).
- Every tool receives `ctx = { phone, client, botUserId }` as its second argument.
- Produces:
  - **`guardar_datos_cliente({ campos }, ctx) → { guardado: [claves], cambios: [{clave, antes, ahora}] }`.**
    - `campos` es un objeto como `{ NOMBRE: '...', CEDULA: '...' }`; las claves se normalizan con `legalProfile.norm`.
    - Se guarda con `merge(clientId, data, botUserId)`.
    - Si un valor cambia, el anterior se conserva en `data['HISTORIAL']`, un arreglo `{clave, antes, fecha}`.
    - Si llega `NOMBRE` y `clients.name` es solo dígitos o el pushName, también se actualiza `clients.name`.
    - Nunca se borra una clave.
  - **`leer_documento({ media_id }, ctx) → { tipo, datos_extraidos: string }`.**
    - Solo `client_media` del mismo `phone`; si no: `{ error: 'archivo no encontrado' }`.
    - Usa el análisis guardado en `messages.content` del mensaje de ese medio si existe. Si no, llama a `analyzeDocument`.
  - **`crear_solicitud({ servicio, detalles, servicio_id? }, ctx) → { caso: case_number, estado: 'new', asignado_a: nombre|null }`.**
    - `Case.create({ caseNumber: generateCaseNumber(), title: \`${servicio} — ${clientName}\`, description: detalles, caseType: servicio, clientId, userId: client.assigned_to || null, serviceId: servicio_id || null, source: 'whatsapp' })`.
    - Se notifica (tipo `'case'`, link `/cases`) al asignado o, si no hay asignado, a cada admin activo.
  - **`estado_solicitud({}, ctx) → { solicitudes: [{ caso, titulo, estado, actualizado }] }`:** las 5 más recientes del cliente.

- [ ] **Step 1: Escribir las pruebas que fallan**
```js
test('guardar_datos_cliente guarda en la ficha legal normalizando la clave', async () => {
  await guardar_datos_cliente({ campos: { 'cédula': '001-0000000-1' } }, ctx);
  assert.equal((await legalProfile.get(clientId)).CEDULA, '001-0000000-1');
});
test('un dato que cambia queda en HISTORIAL y el nuevo reemplaza al viejo', ...);
test('NOMBRE reemplaza un nombre de cliente que era solo el teléfono', ...);
test('leer_documento no lee medios de otro teléfono', ...);
test('leer_documento usa el análisis ya guardado sin llamar a la IA', ...); // stub de analyzeDocument que falla si se llama
test('crear_solicitud crea el caso, lo deja al asignado y le avisa', ...);
test('crear_solicitud sin asignado avisa a cada admin activo', ...);
test('estado_solicitud devuelve las del cliente, la más nueva primero', ...);
```
- [ ] **Step 2:** Run: `node --test test/agent-tools-client.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implementarlo. En `intake.js` cambiar la última línea a `module.exports = { handle, generateCaseNumber };`.
- [ ] **Step 4:** Run: `npm test`. Expected: todo pasa.
- [ ] **Step 5:** Commit: `feat(bot): client-data, document-reading and request tools`.

---

### Task 6: Cotización con aprobación y paso a una persona

**Files:**
- Create: `src/agent/tools/quote.js`, `src/agent/tools/handoff.js`, `test/agent-tools-quote-handoff.test.js`

**Interfaces:**
- Consumes:
  - `Invoice.create`, `Invoice.requestApproval`;
  - `generateDocNumber('COT')` (`src/documents/generateInvoice.js`);
  - `calculatePrice` (Task 1);
  - `setManualMode(phone, true)` (handler);
  - `getBusinessInfo`, `isOpen` (Task 2).
- Produces:
  - **`preparar_cotizacion({ partidas: [{ servicio_id, cantidad?, valor_del_bien?, con_notarizacion? }] }, ctx) → { cotizacion: doc_number, total, estado: 'pending_approval' }`.**
    - Cada partida se recalcula con `calculatePrice`. El bot nunca manda precios propios.
    - Si alguna partida tiene `total === null`, no se crea nada y se devuelve `{ error: 'hay partidas sin precio confirmado', sin_precio: [nombres] }`.
    - Las `items` usan el mismo formato que el panel: `{ descripcion, cantidad, precio }`.
    - `createdBy = botUserId`, `source = 'bot'`, sin descuento. Después se llama `requestApproval`.
    - Se notifica a cada admin activo (tipo `'invoice'`, link `/cotizaciones`).
  - **`pasar_a_humano({ motivo }, ctx) → { mensaje: string, urgente: boolean }`.**
    - Llama `setManualMode(phone, true)` y guarda el traspaso en `wa_bot_state` (clave `handoff:<phone>`, valor `{ at, motivo, urgente_avisado: false }`).
    - Avisa al asignado o, si no hay, a cada admin activo: tipo `'handoff'`, título `🙋 El bot pasó un chat: <nombre>`, link `/bot-messages?phone=<phone>`.
    - `mensaje` es `business_info.mensaje_espera`.
    - `urgente` es `true` cuando está cerrado y el último texto del cliente contiene "urgente" (por palabra, sin importar acentos). En ese caso el título del aviso empieza con `🚨 URGENTE`.
  - **`notifyUrgentAfterHandoff(phone, text) → Promise<boolean>`** (lo usa Task 9). Avisa como urgente solo si:
    - existe `handoff:<phone>`;
    - `urgente_avisado` es false;
    - el texto contiene "urgente";
    - está cerrado.
    Después marca `urgente_avisado = true`.

- [ ] **Step 1: Escribir las pruebas que fallan**
```js
test('preparar_cotizacion recalcula con el catálogo, la crea por aprobar como el bot y avisa a los admins', async () => {
  const r = await preparar_cotizacion({ partidas: [{ servicio_id: acto, valor_del_bien: 500000 }] }, ctx);
  assert.equal(r.total, 950); assert.equal(r.estado, 'pending_approval');
  const inv = (await pool.query('SELECT created_by, status FROM invoices')).rows[0];
  assert.equal(inv.created_by, botUserId); assert.equal(inv.status, 'pending_approval');
});
test('con una partida por confirmar no crea nada y dice cuál', ...);
test('pasar_a_humano pone el chat en manual, avisa y devuelve el mensaje de espera exacto', ...);
test('fuera de horario con "urgente" el aviso dice URGENTE', ...);   // inyectar now
test('notifyUrgentAfterHandoff avisa una sola vez', ...);
test('notifyUrgentAfterHandoff no hace nada si el bot no pasó el chat', ...);
```
Para controlar la hora en las pruebas, las funciones aceptan `ctx.now` (un `Date`); por defecto es `new Date()`.
- [ ] **Step 2:** Run: `node --test test/agent-tools-quote-handoff.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implementarlo.
- [ ] **Step 4:** Run: `npm test`. Expected: todo pasa.
- [ ] **Step 5:** Commit: `feat(bot): quote-for-approval and handoff tools`.

---

### Task 7: Registro de herramientas, guía y contexto

**Files:**
- Create: `src/agent/tools/index.js`, `src/agent/guide.md`, `src/agent/context.js`, `src/agent/memory.js`, `test/agent-context.test.js`

**Interfaces:**
- Consumes: las herramientas de las Tasks 4–6, `getBusinessInfo`/`formatForPrompt` y `Message.findRecentByPhone(phone, limit)`.
- Produces:
  - **`TOOLS: [{ name, description, parameters }]`:** las 9 herramientas, con descripciones en español que dicen cuándo usar cada una. Por ejemplo, `calcular_precio`: "Antes de dar cualquier precio. Si el servicio depende del valor del bien, pregunte el valor primero".
  - **`runTool(name, args, ctx) → Promise<object>`:**
    - nombre desconocido → `{ error: 'herramienta desconocida: <name>' }`;
    - faltan argumentos requeridos (según `parameters.required`) → `{ error: 'faltan datos: <campos>' }`;
    - si la herramienta lanza una excepción → `{ error: 'no se pudo completar' }` (el detalle va solo al log).
    - Cada llamada se guarda en `bot_tool_log` con `ok` y `ms`; `message_id` se rellena después (Task 8).
  - **`src/agent/guide.md`:**
    - las 11 reglas del spec §4 con los valores por defecto de este plan;
    - "Pregunte antes de cotizar" y el "Antes de dar cualquier precio, use calcular_precio. Nunca escriba un monto que no le haya dado una herramienta".
    - Sin ningún monto en RD$, salvo los porcentajes de devolución de la regla 11. La prueba lo exige.
  - **`buildContext({ phone, client, now }) → { system: string, messages: [...] }`:**
    - `system` = guía + datos del negocio + "Ahora: <fecha y hora RD>, <abierto|cerrado>" + ficha del cliente:
      - nombre;
      - datos de `legal_profiles` sin `HISTORIAL`;
      - solicitudes abiertas;
      - `bot_memory.resumen`.
    - `messages` = los últimos 30 mensajes en orden cronológico: `inbound` → `user`, `outbound` → `assistant`.
  - **`maybeSummarize({ phone, client, provider, now })`:**
    - Si el último mensaje anterior al turno tiene más de 30 minutos y hay mensajes nuevos desde `hasta_mensaje_id`, pide al modelo un resumen de 5 líneas como máximo, sin datos de cédula, y hace upsert en `bot_memory`.
    - Cualquier error se ignora; nunca bloquea el turno.

- [ ] **Step 1: Escribir las pruebas que fallan**
```js
test('la guía no contiene montos en pesos', () => {
  const g = fs.readFileSync('src/agent/guide.md', 'utf8');
  assert.equal(/RD\$\s?\d|\d[\d,.]*\s*pesos/i.test(g), false);
});
test('hay exactamente 9 herramientas con los nombres del spec', () => {
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), ['buscar_servicio','calcular_precio','crear_solicitud','estado_solicitud','guardar_datos_cliente','leer_documento','pasar_a_humano','preparar_cotizacion','ver_tramite']);
});
test('runTool con nombre desconocido devuelve error y lo registra', ...);
test('runTool sin un argumento requerido devuelve "faltan datos"', ...);
test('runTool registra cada llamada en bot_tool_log', ...);
test('buildContext trae solo los últimos 30 mensajes, en orden', ...);   // siembra 35
test('buildContext incluye la ficha y el resumen, pero no HISTORIAL', ...);
test('buildContext dice "cerrado" un sábado', ...);
test('maybeSummarize guarda el resumen cuando la conversación anterior quedó quieta 30 min', ...); // proveedor falso
```
- [ ] **Step 2:** Run: `node --test test/agent-context.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implementarlo y escribir `guide.md`. El tono sale de `PERSONA IA.pdf` y `CUSTOMER SERVICE WORKFLOW.pdf` (en `~/Documents/guru bot/Documentos/`), con mensajes cortos y los emojis oficiales.
- [ ] **Step 4:** Run: `npm test`. Expected: todo pasa.
- [ ] **Step 5:** Commit: `feat(bot): tool registry, behavior guide and per-turn context`.

---

### Task 8: El ciclo del agente y el filtro de precios

**Files:**
- Create: `src/agent/agent.js`, `src/agent/priceGuard.js`, `test/agent-loop.test.js`

**Interfaces:**
- Consumes: `getProvider`, `TOOLS`, `runTool`, `buildContext`, `maybeSummarize`, `pasar_a_humano` y `AI_DEFERRED` (`src/conversation/router.js`).
- Produces:
  - **`priceGuard(text, allowed: Set<number>) → { text, blocked: number[] }`.**
    - Detecta montos como `RD$ 1,500`, `RD$1500`, `1,500 pesos` y `$1500`.
    - Un monto que no está en `allowed` se cambia por `(se lo confirmo)` y va en `blocked`.
    - Los números que no son dinero (cédulas, fechas, cantidades sin moneda) no se tocan.
  - **`respond(phone, text, { media = [], provider, now } = {}) → Promise<string | AI_DEFERRED>`.** El ciclo:
    1. Busca el cliente con `Client.findByPhone(phone)` y el id del usuario `bot` (`SELECT id FROM users WHERE username = 'bot'`, en caché). El `ctx` de las herramientas es `{ phone, client, botUserId, now }`.
    2. Llama `maybeSummarize` y luego `buildContext`, y agrega el turno nuevo como mensaje `user`. El texto es `text` más, por cada medio, su `transcription` o `analysis` con la etiqueta `[Foto/Documento enviado, id <media.id>]: <análisis>`.
    3. Llama a `provider.chat` con `timeoutMs: 25000` y ejecuta los `toolCalls` en orden con `runTool`.
    4. `allowed` junta todos los números de los resultados: `total`, `precio`, `rango.min/max`, los de `desglose`, y los totales multiplicados por cantidad.
    5. Repite hasta que haya texto sin `toolCalls`, o hasta 6 llamadas a herramientas en total.
    6. **Más de 6 llamadas:** llama a `pasar_a_humano({ motivo: 'demasiados pasos' })` y devuelve su `mensaje`.
    7. **Un error `QUOTA`:** devuelve `AI_DEFERRED`, para que el reintento diferido existente lo maneje.
    8. **Otro error (o `TIMEOUT`):** reintenta el turno completo una vez. Si vuelve a fallar, llama a `pasar_a_humano({ motivo: 'falla del modelo' })` y devuelve el mensaje de espera. Nunca devuelve un error técnico.
    9. **Repetición:** si los últimos 3 mensajes `inbound` (incluido este), después de `fold`, son iguales, hace el traspaso sin llamar al modelo.
    10. **Respuesta final:** se pasa por `priceGuard`. Si `pasar_a_humano` se ejecutó durante el turno y el modelo no repitió el mensaje de espera, ese mensaje se agrega al final.
    11. **Registro:** devuelve el texto, y `respond` deja `lastToolLogIds` en un mapa por teléfono. `attachToolLogs(phone, messageId)` hace `UPDATE bot_tool_log SET message_id=$1 WHERE id = ANY($2)`.
  - **Turnos en serie por teléfono:** un mapa `phone → Promise`. Cada `respond` espera al anterior del mismo teléfono.

- [ ] **Step 1: Escribir las pruebas que fallan.** Todas usan `createFakeProvider` y las tablas mínimas de las Tasks 4–6:
```js
test('pregunta de precio: busca, calcula y responde con el monto de la herramienta', async () => {
  const p = createFakeProvider([
    { toolCalls: [{ id: '1', name: 'buscar_servicio', args: { consulta: 'acto de venta vehiculo' } }] },
    { toolCalls: [{ id: '2', name: 'calcular_precio', args: { servicio_id: acto, valor_del_bien: 500000 } }] },
    { text: 'El acto de venta le sale en RD$950 🦉' }]);
  assert.match(await respond(PHONE, 'cuanto es un acto de venta de un carro de 500 mil', { provider: p }), /RD\$950/);
});
test('un monto inventado se cambia por "(se lo confirmo)"', async () => {
  const p = createFakeProvider([{ text: 'Eso cuesta RD$1,200' }]);
  const out = await respond(PHONE, 'cuanto cuesta un poder', { provider: p });
  assert.doesNotMatch(out, /1,200/); assert.match(out, /se lo confirmo/);
});
test('priceGuard no toca cédulas, fechas ni cantidades sin moneda', ...);
test('herramienta desconocida: el modelo recibe el error y el turno termina con texto', ...);
test('más de 6 herramientas pasa a una persona con el mensaje de espera', ...);
test('cuota agotada devuelve AI_DEFERRED', ...);
test('el modelo falla dos veces: pasa a una persona, sin error técnico', ...);
test('el mismo mensaje 3 veces pasa a una persona sin llamar al modelo', ...);
test('un lote con solo una foto llega al modelo como texto con su análisis', async () => {
  const p = createFakeProvider([{ text: 'Recibí su cédula' }]);
  await respond(PHONE, '', { provider: p, media: [{ id: 7, media_type: 'image', analysis: 'Cédula de JUAN PEREZ' }] });
  assert.match(p.calls[0].messages.at(-1).text, /Cédula de JUAN PEREZ/);
});
test('dos turnos del mismo teléfono no se cruzan', async () => {
  // proveedor falso con un retraso de 200 ms en el primer turno; se lanzan dos respond sin await;
  // el segundo turno debe ver en p.calls[1] el mensaje del primero ya resuelto (calls en orden, sin intercalar)
});
test('attachToolLogs liga las herramientas al mensaje del bot', ...);
```
- [ ] **Step 2:** Run: `node --test test/agent-loop.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implementarlo.
- [ ] **Step 4:** Run: `npm test`. Expected: todo pasa.
- [ ] **Step 5:** Commit: `feat(bot): agent loop with tool budget, retries, handoff and price guard`.

---

### Task 9: Conectar el agente a WhatsApp

**Files:**
- Create: `src/agent/engine.js`, `test/agent-handler.test.js`
- Modify: `src/whatsapp/handler.js:296-404` (`processBatch` y `sendResponse`), `src/routes/messages.js` (las herramientas por mensaje)

**Interfaces:**
- Consumes: `respond`, `attachToolLogs`, `notifyUrgentAfterHandoff` y `AI_DEFERRED`.
- Produces:
  - **`engineFor(phone) → 'agent'|'legacy'`:** `'agent'` si el teléfono normalizado está en `BOT_AGENT_PHONES` o si `BOT_ENGINE === 'agent'`.
  - **En `processBatch`:**
    - Antes de `if (!willRespond) return;`: si `isManualMode(phone)` y hay texto, se llama `notifyUrgentAfterHandoff(phone, combinedText)`.
    - Si `engineFor(phone) === 'agent'`:
      - se omite la detección de reclamaciones por HTTP (el agente decide pasar a una persona);
      - se llama `respond(phone, combinedText, { media: allMedia })`;
      - `AI_DEFERRED` se maneja igual que hoy con `scheduleAIRetry`; el reintento también usa `engineFor`;
      - si no, `sendResponse` y luego `attachToolLogs(phone, savedMessage.id)`.
    - Si es `'legacy'`, el código actual queda igual.
  - **`sendResponse`** devuelve la fila de `Message.create`.
  - **`GET /api/messages/phone/:phone`:** cada mensaje `outbound` trae `tools: [{ herramienta, ok }]` desde `bot_tool_log` con una sola consulta (`WHERE message_id = ANY(...)`).

- [ ] **Step 1: Escribir las pruebas que fallan**
```js
test('engineFor: un teléfono en BOT_AGENT_PHONES usa el agente aunque BOT_ENGINE sea legacy', ...);
test('engineFor: por defecto es legacy', ...);
test('un lote de un chat con agente se responde con el agente, se envía y se liga a sus herramientas', async () => {
  // sock falso que guarda lo enviado; respond reemplazado por un proveedor falso vía BOT_AI_PROVIDER=fake + script global de prueba
});
test('un chat legacy sigue yendo a routeMessage', ...);
test('chat en manual después de un traspaso: "urgente" fuera de horario avisa al admin una vez y el bot no responde', ...);
test('GET /api/messages/phone/:phone trae las herramientas de cada respuesta del bot', ...);
```
Para usar el proveedor falso desde el handler, `getProvider('fake')` devuelve el proveedor que se registró con `setFakeProvider(p)` (se exporta desde `provider/index.js`, solo para pruebas).
- [ ] **Step 2:** Run: `node --test test/agent-handler.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implementarlo.
- [ ] **Step 4:** Run: `npm test`. Expected: todo pasa, incluidas `whatsapp-cloud`, `whatsapp-bot-state` y `whatsapp-archive` sin cambios.
- [ ] **Step 5:** Commit: `feat(bot): route chosen chats to the agent; urgent notice after handoff; tools per message`.

---

### Task 10: Carga inicial del conocimiento

**Files:**
- Create: `seeds/bot/servicios-enriquecidos.json`, `seeds/bot/servicios-nuevos.json`, `seeds/bot/conflictos.json`, `seeds/bot/tramites.json`, `src/db/seedBotKnowledge.js`, `test/seed-bot-knowledge.test.js`
- Modify: `package.json` (script `"seed:bot": "node -r dotenv/config src/db/seedBotKnowledge.js"`)

**Interfaces:**
- **Formato de los archivos JSON:**
  - **`servicios-enriquecidos.json`:** `[{ nombre (exacto, como está en el catálogo), descripcion?, incluye?, reglas?, requisitos?, alias?: [], notarizacion?, tiempo_entrega?, precio_rango? }]`. Solo se escriben los campos que vienen. Un nombre que no existe se reporta y se salta.
  - **`servicios-nuevos.json`:** `[{ nombre, categoria (nombre exacto de service_categories), digitacion_price?, notarizacion_price?, unit_type?, alias?, incluye?, reglas?, requisitos?, precio_rango?, por_confirmar? }]`. Se inserta solo si el nombre no existe; nunca se cambia un precio que ya está.
  - **`conflictos.json`:** `[{ nombre, motivo }]`. Pone `por_confirmar = true` y guarda `motivo` en `reglas`. Para los actos de venta: `[{ grupo: 'Acto de Venta', tramos_desde: 3000001 }]` marca `por_confirmar: true` en esos tramos de todos los servicios cuyo nombre empieza así.
  - **`tramites.json`:** `[{ nombre, alias, pasos, preguntas_obligatorias, reglas }]`, con upsert por `nombre`.
- **Contenido** (fuentes en `~/Documents/guru bot/`, el más reciente primero, y `src/knowledge/GURU_PRECIOS_OFICIALES.pdf`):
  - **Los 7 trámites** de `LATEST UPDATES/INDICE TRAMITES.pdf`:
    - Traspaso de vehículo;
    - Salida de menor (regla: no se acepta con menos de 24 h);
    - Ayuntamiento;
    - Compulsa;
    - Apostilla de documento;
    - Apostilla de certificación;
    - Legalización de traducción.
  - **Reglas e incluye de los 9 servicios** de `LATEST UPDATES/ESQUELETOS SERVICIOS.pdf`:
    - máximo 2 originales;
    - más de 3 modificaciones = redacción;
    - certificaciones con 48 h;
    - mensajería y trámites con 24 h;
    - reembolso del 30% si un trámite se cae;
    - las impresiones erróneas se cobran.
  - **Alias comunes:** "traspaso", "venta del carro", "poder", "declaración jurada", "apostillar"…
  - **Los ~60 precios que faltan** (lista en `guru-soluciones/docs/bot-ia/2026-10-05-auditoria-documentacion.md`). Si una fuente no da un precio claro, el servicio entra con `por_confirmar: true`.
  - **Los conflictos** de la tabla "Precios que no coinciden" de `docs/bot-ia/2026-10-05-pendientes-leandro.md`.
- **`seedBotKnowledge({ dir = 'seeds/bot', dryRun = false }) → { enriquecidos, nuevos, conflictos, tramites, saltados: [nombres] }`:**
  - todo en una transacción;
  - con `--dry-run` imprime el resumen y hace `ROLLBACK`;
  - se puede correr varias veces sin duplicar.

- [ ] **Step 1: Escribir las pruebas que fallan.** Usan una carpeta de seeds de prueba en `test/fixtures/seeds-bot/`:
```js
test('enriquece por nombre exacto y reporta los que no existen', ...);
test('un servicio nuevo se inserta una vez; correrlo de nuevo no duplica ni cambia precios', ...);
test('conflictos marca por_confirmar y los tramos de actos de venta desde 3M', ...);
test('dry-run no deja cambios', ...);
test('los JSON reales de seeds/bot son válidos: 7 trámites con los nombres del plan, y cada paso.servicio es null o un nombre que está en servicios-nuevos o en el snapshot del catálogo', ...);
```
La última prueba usa `test/agent/catalog-snapshot.json`, que genera la Task 11. Si la Task 11 no está hecha, se crea primero el snapshot (Task 11, Step 3a).
- [ ] **Step 2:** Run: `node --test test/seed-bot-knowledge.test.js`. Expected: FAIL.
- [ ] **Step 3:** Escribir `seedBotKnowledge.js` y transcribir los JSON desde las fuentes. Las descripciones las redacto yo; Leandro las corrige después.
- [ ] **Step 4:** Run: `npm test`. Expected: todo pasa.
- [ ] **Step 5:** Commit: `feat(bot): initial knowledge — trámites, service rules, missing prices, conflicts flagged`.
- [ ] **Step 6 (Jay, en Railway):** primero `railway run npm run db:migrate`, luego `railway run node -r dotenv/config src/db/seedBotKnowledge.js --dry-run`, y si el resumen cuadra, `railway run npm run seed:bot`.

---

### Task 11: Batería con modelo real y comparación Gemini vs Claude

**Files:**
- Create: `scripts/export-catalog.js`, `test/agent/catalog-snapshot.json`, `test/agent/escenarios/*.json` (unos 40), `scripts/bot-eval.js`
- Modify: `package.json` (`"bot:eval": "node scripts/bot-eval.js"`)

**Interfaces:**
- **`scripts/export-catalog.js`:**
  - lectura de solo consulta con `DATABASE_URL` (sin imprimirla);
  - guarda `service_categories` y `service_catalog` activos, más `tramites`, en `test/agent/catalog-snapshot.json`;
  - no exporta clientes ni mensajes.
- **Escenario:**
```json
{ "nombre": "acto de venta sin valor",
  "turnos": ["hola", "quiero un acto de venta de un carro, cuanto es"],
  "espera": { "herramientas_incluye": ["buscar_servicio"], "pregunta_antes_de_precio": "valor",
              "no_herramientas": ["preparar_cotizacion"], "termina_sin_traspaso": true },
  "prohibido": { "montos_fuera_de_herramientas": true, "entrega": true } }
```
- **Los ~40 escenarios cubren:**
  - saludo;
  - precio sin decir qué necesita;
  - acto de venta con y sin valor;
  - valor de más de 3M (por confirmar);
  - servicio sin precio;
  - rango (apostilla);
  - cada uno de los 7 trámites;
  - salida de menor con viaje mañana (rechaza con menos de 24 h);
  - foto de cédula;
  - dar datos sueltos;
  - "ESTADO DE MI SOLICITUD";
  - pedir cotización;
  - pedir descuento;
  - reclamo;
  - "quiero hablar con alguien";
  - "urgente" fuera de horario;
  - repetir 3 veces;
  - preguntar quién es el notario (no lo revela);
  - preguntar formas de pago, horario y dirección;
  - inglés (responde en español y ofrece una persona);
  - un mensaje grosero.
- **`bot-eval.js [--provider gemini|claude|both] [--solo nombre]`:**
  1. Recrea un esquema `bot_eval` en `guru_test` desde el snapshot.
  2. Corre cada escenario con `respond` y el proveedor real.
  3. Revisa `espera` y `prohibido` usando `bot_tool_log` y el texto.
  4. Pide a un segundo modelo una nota de tono del 1 al 5 con una rúbrica fija (cercano, corto, usted, sin inventar).
  5. Escribe `test/agent/resultados/<fecha>-<proveedor>.md` con aprobados/fallidos por escenario, tiempo medio, tokens y costo estimado por conversación.
  - Sale con código 1 si algún escenario viola `prohibido`.

- [ ] **Step 1:** Escribir `export-catalog.js` y correrlo (solo lectura). Expected: un snapshot con más de 200 servicios, y sin `phone` ni `client` en el archivo (`grep -c phone` = 0).
- [ ] **Step 2:** Escribir los escenarios y `bot-eval.js`. Incluir una prueba unitaria `test/bot-eval-checks.test.js` para las funciones que revisan `espera` y `prohibido` (puras, con registros falsos).
- [ ] **Step 3:** Run: `npm test`. Expected: todo pasa.
- [ ] **Step 4:** Run: `npm run bot:eval -- --provider gemini` (necesita `GEMINI_API_KEY` en el entorno; Jay lo corre con `railway run` si no está local). Expected: el reporte existe y ningún escenario viola `prohibido`. Las fallas de `espera` se corrigen en `guide.md` o en las descripciones de las herramientas, y se vuelve a correr.
- [ ] **Step 5:** Commit: `test(bot): real-model scenario battery and provider comparison`.

---

### Task 12: Las herramientas en Mensajes (frontend)

**Files (repo `guru-frontend-dev`):**
- Modify: `apps/dashboard/src/lib/botApi.ts` (tipo del mensaje: `tools?: { herramienta: string; ok: boolean }[]`), `apps/dashboard/src/pages/BotMessages.tsx` (bajo cada burbuja del bot)
- Test: `apps/dashboard/src/pages/BotMessages.test.tsx`

**Interfaces:**
- Consumes: `GET /api/messages/phone/:phone` con `tools` (Task 9).
- Produces: bajo una burbuja del bot con `tools`, una línea pequeña en `text-xs text-foreground/60` con etiquetas en español separadas por " · ":
  - `buscar_servicio` → "buscó servicio";
  - `calcular_precio` → "calculó precio";
  - `ver_tramite` → "vio trámite";
  - `guardar_datos_cliente` → "guardó datos";
  - `leer_documento` → "leyó documento";
  - `crear_solicitud` → "creó solicitud";
  - `preparar_cotizacion` → "preparó cotización";
  - `estado_solicitud` → "vio estado";
  - `pasar_a_humano` → "pasó a una persona".
  - Una herramienta con `ok=false` se ve tachada y con `title="falló"`.

- [ ] **Step 1: Escribir las pruebas que fallan**
```tsx
it('muestra las herramientas bajo la respuesta del bot', async () => { /* mensaje outbound con tools [{buscar_servicio,ok:true},{calcular_precio,ok:true}] → getByText('buscó servicio · calculó precio') */ });
it('una herramienta que falló se ve tachada', ...);
it('los mensajes sin tools no muestran la línea', ...);
```
- [ ] **Step 2:** Run: `npm test -w apps/dashboard -- BotMessages`. Expected: FAIL.
- [ ] **Step 3:** Implementarlo.
- [ ] **Step 4:** Run: `npm test -w apps/dashboard` y `npm run build -w apps/dashboard`. Expected: todo pasa y compila.
- [ ] **Step 5:** Commit en `guru-frontend-dev`: `feat(mensajes): show the tools the bot used under each reply`. Push a `main` (despliega solo dev), solo si Jay lo pide. El paso a producción lo hace Jay.

---

## Encendido (Jay, después de las tareas)

1. Push del backend. Railway corre las migraciones.
2. En Railway: `BOT_AI_PROVIDER=gemini` y `BOT_AGENT_PHONES=<tu número>,<el de Leandro>`; `BOT_ENGINE` se queda en `legacy`.
3. `npm run seed:bot`, como en la Task 10, Step 6.
4. Escribirle al número de prueba (+1 555-676-6017) desde un número de la lista y revisar en Mensajes las herramientas bajo cada respuesta.
5. Cuando la batería y las pruebas reales salgan bien, y Leandro haya respondido, se decide el cambio a `BOT_ENGINE=agent` y el retiro del motor viejo (plan aparte).
