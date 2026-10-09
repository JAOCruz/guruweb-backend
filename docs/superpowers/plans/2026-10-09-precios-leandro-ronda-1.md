# Precios de Leandro, ronda 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply Leandro's first round of price answers. That means:
- corrected catalog data;
- per-foja pricing for every drafted document;
- duplicates;
- courier prices;
- AI-estimated government fees (tasas).

**Architecture:**
- **One idempotent SQL migration** fixes the data and adds `foja_tipo`/`fojas` and `tasas_cache`.
- **`calculatePrice`** learns per-foja pricing and duplicates. The rates live in one module.
- **A classify script** writes `seeds/bot/fojas.json` plus an Excel file for Leandro. An apply script loads the JSON.
- **A new agent tool `estimar_tasa`** uses a `search()` method added to each provider adapter, with a 30-day cache.
- **The dashboard Catálogo** edits `foja_tipo`/`fojas`.

**Tech Stack:** Node 20, Express, PostgreSQL, `node:test`, `@google/generative-ai` 0.24, `@anthropic-ai/sdk`, React + Vite + vitest (dashboard), Python `openpyxl` (Excel).

**Spec:** `docs/superpowers/specs/2026-10-08-precios-leandro-ronda-1-design.md`

## Global Constraints

**Rates and prices:**
- Foja rates: `carta_simple` 150, `carta_motivada` 300, `legal_simple` 250, `legal_motivada` 350. Each printed side is one foja.
- Duplicate or extra original: 500 if the document has 1–2 fojas, 700 if 3 or more.
- Courier for trámites: 1000 per document, taxes not included.
- Acto de venta / Contrato de Venta Bienes notarization uses Table A:

| Asset value | Price |
|---|---|
| 0–100,000 | 500 |
| 100,001–800,000 | 700 |
| 800,001–1,000,000 | 1000 |
| 1,000,001–3,000,000 | 2000 |
| 3,000,001–5,000,000 | 3000 |
| 5,000,001 and up (max null) | 5000 |

No tier is `por_confirmar`.

**Behaviour that must not change:**
- A service without `foja_tipo` prices exactly as today: all existing `test/service-pricing.test.js` cases stay green.
- Tasas are never added to a quote total. The bot always presents them as "aproximado".

**Process:**
- Copy, comments and guide text are in Spanish, matching the surrounding code.
- Backend tests: `npm test` in `guruweb-backend`, against local Postgres `guru_test`. Never point tests at production.
- Never read `.env` or print `DATABASE_URL`. Production DB access is read-only: SELECT only.
- Production migrations and seeds are run by Jay.
- No Playwright MCP and no visible browser. Frontend tests use vitest in `guru-frontend-dev/apps/dashboard`.
- Commit on `main` in each repo. Do not push; the controller pushes.

## Review Focus

1. **Re-running the migration** (it is idempotent by design): it must not duplicate the new courier/duplicate services or append the same `reglas` sentence twice.
2. **Unusual `fojas` values.** A `fojas` of 0, a negative number, a decimal or a string must not produce 0 or NaN prices: treat any non-positive or non-integer value as "not given".
3. **The price guard on foja quotes.** `tarifa_por_foja` and `monto_aproximado` must be allowed amounts. The fojas count itself must not be: "RD$2" stays blocked.
4. **`estimar_tasa` when the provider has no `search`** (the fake provider without one, or a QUOTA error): it returns `por_confirmar` and never throws out of the tool.
5. **Re-seeding.** `seedBotKnowledge` run again after this round must not re-flag the resolved services as `por_confirmar`.

---

### Task 1: Data migration and resolved conflicts

**Files:**
- Create: `migrations/20261009_precios_leandro_1.sql`
- Modify: `seeds/bot/conflictos.json`
- Test: `test/precios-leandro-migration.test.js` (new); `test/seed-bot-knowledge.test.js` (only if it asserts on the removed conflicts)

**Interfaces:**
- Produces:
  - columns `service_catalog.foja_tipo TEXT` (CHECK in the 4 keys or NULL) and `service_catalog.fojas INTEGER`;
  - table `tasas_cache (id SERIAL PK, concepto_key TEXT UNIQUE NOT NULL, concepto TEXT, monto NUMERIC, fuente TEXT, nota TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`.

- [ ] **Step 1: Write the failing test** `test/precios-leandro-migration.test.js`.

  Schema setup: build it the way `test/seed-bot-knowledge.test.js` does (minimal `service_categories`/`service_catalog`, then `migrations/20261005_bot_agent.sql`).

  Seed these rows by name, with the production values from the spec §1 table:
  - Certificación Estatus Jurídico Inmueble;
  - Instancia - Recurso de Amparo, PC 500;
  - Instancia Sencilla;
  - Estatutos Sociales;
  - Nómina de Pagos/Presencia;
  - Foto 2x2;
  - Fotocopia 11x17";
  - Escáner de Documento;
  - Acto de Venta - Vehículo Liviano, with the 3M+ tiers `por_confirmar`;
  - Contrato de Venta Bienes, with the Table B tiers;
  - Mensajería Local (Santo Domingo);
  - the six `Mensajería - …` rows (309–314).

  The resolved rows carry the `reglas` note `Precio por confirmar: …`, as `seedBotKnowledge` writes it.

  Then run the migration **twice** and assert:
  - `test('las correcciones de Leandro quedan aplicadas y la migración es idempotente')`:
    - estatus jurídico: `por_confirmar=false`, `reglas` contains `No incluye impuestos` exactly once and no longer contains `Precio por confirmar`;
    - every `Instancia%`, Estatutos and Nómina: `por_confirmar=false`;
    - Foto 2x2: `digitacion_price=250`, `unit_type='por juego de hasta 5 fotos'`, not PC;
    - Fotocopia 11x17": `digitacion_price=50`, not PC, `reglas` mentions `RD$100` once;
    - Escáner: unchanged (`por_confirmar=true`, 5).
  - `test('actos de venta y contrato de venta usan la tabla A sin tramos por confirmar')`:
    - Acto de Venta tiers: no element has `por_confirmar`;
    - Contrato de Venta Bienes tiers deep-equal Table A, with labels `Hasta RD$100K`, `RD$100K-800K`, `RD$800K-1M`, `RD$1M-3M`, `RD$3M-5M`, `RD$5M+`.
  - `test('mensajería: 1000 sin impuestos, envío por Uber por confirmar y servicios nuevos una sola vez')`:
    - Legalización, DGII and Solicitud de Certificación: 1000, `unit_type='por documento'`, not PC, `reglas` contains `No incluye impuestos`;
    - Migración, Ayuntamiento and Recolección de Firmas: still PC, `reglas` contains `pendiente de Leandro`;
    - `Mensajería Local (Santo Domingo)` is renamed `Envío al cliente (Uber)`: `digitacion_price` NULL, PC true, `reglas` contains `Uber`, and `alias` includes `mensajería local`;
    - new rows exist exactly once each at 1000:
      - `Mensajería - Depósito en Cámara de Comercio`;
      - `Mensajería - Cancillería (MIREX)`;
      - `Mensajería - Ministerio de Educación`;
      - `Mensajería - MESCYT`.
  - `test('duplicados: dos servicios nuevos, una sola vez')`:
    - `Original adicional o duplicado (1 o 2 fojas)` 500;
    - `Original adicional o duplicado (3 o más fojas)` 700;
    - both `unit_type='por original'`, in category `Redactar o digitar un documento`.
  - `test('columnas de fojas y caché de tasas')`:
    - inserting `foja_tipo='legal_simple', fojas=2` works;
    - `foja_tipo='otro'` fails the CHECK;
    - `tasas_cache` exists.

- [ ] **Step 2: Run the test and confirm it fails.** Run `node --test test/precios-leandro-migration.test.js`. Expected: FAIL (the migration file is missing).

- [ ] **Step 3: Write `migrations/20261009_precios_leandro_1.sql`.**
  - Make it idempotent: `ADD COLUMN IF NOT EXISTS`, a CHECK in a `DO $$` block guarded by `pg_constraint`, `CREATE TABLE IF NOT EXISTS`, and INSERTs `WHERE NOT EXISTS (SELECT 1 … WHERE name = …)`.
  - Append a sentence to `reglas` only when `position(sentence in coalesce(reglas,'')) = 0`.
  - Strip the conflict note with `regexp_replace(reglas, '(^|\n)Precio por confirmar:[^\n]*', '', 'g')` on every resolved row.
  - Remove `por_confirmar` from tiers with `(SELECT jsonb_agg(t - 'por_confirmar') FROM jsonb_array_elements(price_tiers) t)`.
  - Look up categories by name (`Mensajería`, `Redactar o digitar un documento`). Leave the Escáner untouched.

- [ ] **Step 4: Update `seeds/bot/conflictos.json`.**
  - Remove the entries for:
    - Estatus Jurídico;
    - all Instancias;
    - Estatutos;
    - Nómina;
    - Foto 2x2;
    - Fotocopia 11x17;
    - both `grupo` entries.
  - Keep only Escáner.
  - If `test/seed-bot-knowledge.test.js` reads the real `conflictos.json` and asserts on removed names, update those assertions to the Escáner-only list.

- [ ] **Step 5: Run the test.** Run `node --test test/precios-leandro-migration.test.js test/seed-bot-knowledge.test.js`. Expected: PASS.

- [ ] **Step 6: Commit.** `feat(precios): migración con las correcciones de Leandro (ronda 1)`

---

### Task 2: Per-foja pricing and duplicates in `calculatePrice`

**Files:**
- Create: `src/models/fojaRates.js`
- Modify: `src/models/servicePricing.js`
- Test: `test/service-pricing.test.js` (append)

**Interfaces:**
- Produces:
  - `FOJA_RATES` (object of the 4 keys → numbers);
  - `duplicadoPrice(fojas: number) → 500|700`;
  - `validFojas(v) → positive integer | null`.
- Produces: `calculatePrice(service, { assetValue, quantity, includeNotarization, fojas = null, duplicados = 0 })`, which returns everything it returns today, plus:
  - `fojas` (number | null);
  - `tarifaPorFoja` (number | null);
  - `fojasEstimadas` (boolean);
  - `breakdown.duplicados` (number). This key is present only when `duplicados > 0`.
- Behaviour:
  - When `FOJA_RATES[service.foja_tipo]` exists:
    - `digitacion = rate × nFojas × qty`, where `nFojas = validFojas(fojas) ?? validFojas(service.fojas) ?? 1`;
    - `fojasEstimadas = validFojas(fojas) === null`;
    - the service has a price even if `digitacion_price` is null, and `digitacion_price` is ignored.
  - `duplicados = validFojas(duplicados) ?? 0`. It adds `duplicadoPrice(nFojasDoc) × duplicados`, where `nFojasDoc` is the same fallback chain, also for services without `foja_tipo`.
  - Without `foja_tipo` and with `duplicados = 0`, the result is identical to today: `breakdown` deep-equals `{ digitacion, notarizacion }`.

- [ ] **Step 1: Write failing tests** in `test/service-pricing.test.js`:
  - `por foja: legal simple de 2 fojas estimadas = 500 + notarización`: `{ foja_tipo:'legal_simple', fojas:2, notarizacion_price:'500' }` gives total 1000, `fojas` 2, `tarifaPorFoja` 250, `fojasEstimadas` true.
  - `por foja: las fojas pasadas mandan y ya no son estimadas`: `fojas: 3` on the same service gives digitación 750 and `fojasEstimadas` false.
  - `por foja ignora digitacion_price y multiplica por cantidad`: `{ foja_tipo:'carta_simple', digitacion_price:'999', fojas:1 }` with `quantity:2` gives 300.
  - `por foja con tramos: acto de venta de 2 fojas en 500K = 500 + 700`.
  - `fojas inválidas (0, -1, 1.5, 'x') cuentan como no dadas`: each gives the service's `fojas` or 1, never 0 or NaN.
  - `duplicados: 1–2 fojas a 500, 3+ a 700, suma al total y al desglose`, on a foja service and on a fixed-price service with `fojas: 3`.

- [ ] **Step 2: Run the tests and confirm the new ones fail.** Run `node --test test/service-pricing.test.js`. Expected: the new tests FAIL and the old ones PASS.

- [ ] **Step 3: Implement** `fojaRates.js` and the changes to `calculatePrice`. Update the header comment of `calculatePrice`.

- [ ] **Step 4: Run the tests.** Run `node --test test/service-pricing.test.js`. Expected: all PASS.

- [ ] **Step 5: Commit.** `feat(precios): precio por foja y duplicados en calculatePrice`

---

### Task 3: Tools, price guard, `/calculate` and catalog CRUD know about fojas

**Files:**
- Modify:
  - `src/agent/tools/catalog.js`
  - `src/agent/tools/quote.js`
  - `src/agent/tools/index.js` (schemas only)
  - `src/agent/agent.js` (`collectAmounts`)
  - `src/routes/serviceCatalog.js`
  - `src/models/serviceCatalog.js`
- Test:
  - `test/agent-tools-catalog.test.js`
  - `test/agent-tools-quote-handoff.test.js`
  - `test/agent-loop.test.js` (or wherever `collectAmounts` is tested)

**Interfaces:**
- Consumes: `calculatePrice` options and fields from Task 2.
- Produces:
  - **`calcular_precio`:**
    - takes the new arguments `fojas` (integer) and `duplicados` (integer);
    - returns its current fields plus `fojas`, `tarifa_por_foja`, `fojas_estimadas`;
    - the `desglose` may include `duplicados`.
  - **`buscar_servicio`:** each result adds `por_foja: { tipo, tarifa, fojas_estimadas }`, or `null`.
  - **`preparar_cotizacion`:**
    - `partidas[]` accept `fojas` and `duplicados`;
    - a foja line's `desc` gets ` (N fojas)`;
    - duplicates become a separate item `Original adicional o duplicado` with `cantidad = duplicados` and `precio = duplicadoPrice(n)`.
  - **`POST /service-catalog/calculate`:**
    - accepts `fojas` and `duplicados`;
    - returns `fojas`, `tarifaPorFoja`, `fojasEstimadas`;
    - the `service` object adds `foja_tipo` and `fojas`.
  - **`POST` and `PUT /service-catalog`:**
    - accept `foja_tipo` (one of the 4 keys, or null) and `fojas` (positive integer, or null);
    - anything else → 400.
  - **`collectAmounts`:** also adds positive values under the keys `tarifa_por_foja` and `monto_aproximado`. Neither goes to `totals`.

- [ ] **Step 1: Write failing tests:**
  - **catalog:**
    - a service with `foja_tipo='legal_simple', fojas=2` returns `tarifa_por_foja` 250, `fojas` 2 and `fojas_estimadas` true;
    - with `fojas: 4` → `fojas_estimadas` false;
    - `duplicados: 1` → `desglose.duplicados` 500.
  - **quote:** a partida with `fojas: 3, duplicados: 2` creates one line ending in `(3 fojas)` and a duplicates line with `cantidad` 2 and `precio` 700; the totals match.
  - **guard:**
    - `collectAmounts({ tarifa_por_foja: 250, fojas: 2 })` allows 250 but not 2;
    - `{ monto_aproximado: 1500 }` allows 1500 and is not pushed to `totals`.
  - **route:** if no route test exists, add `test/service-catalog-route.test.js`. Follow the auth or app pattern of an existing route test such as `test/invoice-approve-send.test.js`. It covers:
    - PUT with `foja_tipo:'otro'` → 400;
    - PUT with `foja_tipo:'carta_motivada', fojas:2` → 200, and the values are saved;
    - `/calculate` with `fojas`.

- [ ] **Step 2: Run the tests and confirm they fail.** Run the named test files. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - Update the tool descriptions in `index.js`, in Spanish. `calcular_precio`: "si el servicio va por foja y no sabe cuántas, el precio es estimado: dígalo así". `duplicados` is "originales adicionales o duplicados".
  - `Service.create` takes `foja_tipo` and `fojas`.

- [ ] **Step 4: Run the tests.** Run `npm test`. Expected: all PASS.

- [ ] **Step 5: Commit.** `feat(precios): herramientas, ruta y catálogo con fojas y duplicados`

---

### Task 4: Initial classification, apply script and Excel for Leandro

**Files:**
- Create:
  - `scripts/fojas/classify.js` (pure module plus CLI)
  - `scripts/fojas/apply.js`
  - `scripts/fojas/excel.py`
  - `seeds/bot/fojas.json` (generated)
- Test: `test/fojas-classify.test.js`

**Interfaces:**
- Consumes: the columns from Task 1, `FOJA_RATES` from Task 2, `fold` from `src/agent/text.js`.
- Produces:
  - `classifyTipo(name: string, categoria: string) → foja_tipo | null`;
  - `templatePages(dir) → Map<foldedBaseName, pages>`, which reads `docProps/app.xml` `<Pages>` from each `.docx`;
  - `fojasFor(name, pagesMap) → { fojas, fuente }`;
  - `applyFojas({ file, dryRun }) → { aplicados, saltados: string[] }`.

**Rules:**
- **`classifyTipo` returns `null` for:**
  - categories other than `Redactar o digitar un documento`, unless the name starts with `Instancia`;
  - names matching `/coletilla|original adicional o duplicado/`.
- **Otherwise, first match wins, on `fold(name)`:**
  1. `/autentic|determinacion|particion/` → `legal_motivada`
  2. `/demanda|escrito|recurso|conclusion|defensa|amparo|nomina/` → `carta_motivada`
  3. `/^instancia|carta|notificacion|comunicacion/` → `carta_simple`
  4. otherwise → `legal_simple`
- **`fojasFor`:**
  - if a template's folded base name equals the folded service name, or one contains the other with at least 2 shared words: pages of that template, `fuente: 'modelo: <archivo>'`;
  - otherwise `{ fojas: 1, fuente: 'por defecto' }`.
- **The `classify.js` CLI:**
  - `node -r dotenv/config scripts/fojas/classify.js [--templates templates/documents] [--out seeds/bot/fojas.json]`;
  - **SELECT-only:** it reads active services with their category name;
  - it writes `[{ nombre, categoria, foja_tipo, fojas, fuente, precio_anterior, precio_nuevo }]`, where `precio_anterior = digitacion_price` and `precio_nuevo = FOJA_RATES[tipo] × fojas`;
  - it writes only services with a non-null type.
- **`apply.js`:**
  - `node -r dotenv/config scripts/fojas/apply.js [--dry-run] [--file seeds/bot/fojas.json]`;
  - it updates `foja_tipo` and `fojas` by exact name, in one transaction;
  - with `--dry-run` it ROLLBACKs;
  - it prints `Aplicados: N · Saltados: M`.
- **`excel.py`:** `python3 scripts/fojas/excel.py seeds/bot/fojas.json "<out.xlsx>"` writes one sheet with:
  - columns: Documento, Categoría, Tipo, Fojas, De dónde salen las fojas, Precio anterior (digitación), Precio nuevo (digitación), Diferencia;
  - a header row, frozen panes, autofilter and readable widths;
  - Spanish tipo labels: "Carta simple (150)", etc.

- [ ] **Step 1: Write failing tests** in `test/fojas-classify.test.js`:
  - `classifyTipo('Instancia - Recurso de Amparo','Redactar y Certificar una Traducción')` → `carta_motivada`;
  - `'Instancia - Corrección'` → `carta_simple`;
  - `'Acto de Venta - Vehículo Liviano'` → `legal_simple`;
  - `'Determinación de Herederos'` → `legal_motivada`;
  - `'Nómina de Pagos/Presencia'` → `carta_motivada`;
  - `'Traducción - Acta Natal (Idiomas básicos)'` with the Traducción category → `null`;
  - `'Coletilla y Notarizar documento Fiel y Conforme'` → `null`;
  - `templatePages` on a temp dir with two tiny docx fixtures written by the test (zip with only `docProps/app.xml`, via the `adm-zip`/`jszip` already in `node_modules`, otherwise the `zip` CLI) → the right counts;
  - `applyFojas` on a local DB with 2 rows and a 3-entry file → `aplicados` 2, `saltados` 1; with `dryRun`, nothing changes.

- [ ] **Step 2: Run the tests and confirm they fail.** Run `node --test test/fojas-classify.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement the three scripts.**

- [ ] **Step 4: Run the tests.** Run `node --test test/fojas-classify.test.js`. Expected: PASS.

- [ ] **Step 5: Generate the real files** (the controller does this, read-only against production):
  - `node -r dotenv/config scripts/fojas/classify.js`;
  - `python3 scripts/fojas/excel.py seeds/bot/fojas.json "../Base de Datos Correcciones/Revisión de fojas (Leandro).xlsx"`.

  Spot-check 10 rows.

- [ ] **Step 6: Commit** the scripts, the tests and `seeds/bot/fojas.json`. The Excel stays outside the repo. Message: `feat(precios): clasificación inicial por foja, script para aplicarla y Excel para Leandro`

---

### Task 5: `estimar_tasa` tool with provider search and cache

**Files:**
- Create: `src/agent/tools/tasas.js`
- Modify:
  - `src/agent/provider/gemini.js`
  - `src/agent/provider/claude.js`
  - `src/agent/provider/fake.js`
  - `src/agent/provider/index.js`
  - `src/agent/tools/index.js`
- Test: `test/agent-tools-tasas.test.js`; `test/agent-provider.test.js` (append)

**Interfaces:**
- Produces: `provider.search({ prompt, timeoutMs }) → { text, sources: string[] }` on each provider:
  - **gemini:** model `gemini-2.5-flash` with `tools: [{ googleSearch: {} }]`. Sources come from `candidates[0].groundingMetadata.groundingChunks[].web.uri`.
  - **claude:** `messages.create` with the web search server tool. Use the current tool type and version from the `claude-api` skill, with `max_uses: 3`. `text` is the joined text blocks; `sources` are the `url`s of the `web_search_tool_result` blocks.
  - **Errors:** both map quota errors to `code: 'QUOTA'`, like `chat`.
  - **fake:** `createFakeProvider(script, { search })`. Without `search`, the method is absent.
  - **`getProvider`** passes `search` through for gemini and claude.
- Produces: `estimar_tasa({ concepto }, ctx)`:
  - **success:** `{ concepto, monto_aproximado: number, fuente: string|null, fecha: 'YYYY-MM-DD', aproximado: true }`;
  - **failure:** `{ concepto, monto_aproximado: null, por_confirmar: true }` on any failure: no `search`, a thrown error, a non-JSON answer, or a non-positive amount.
  - `key = fold(concepto).trim()`. A cache row younger than 30 days is returned without calling search.
  - The prompt asks for the current official amount in the Dominican Republic and the answer `{"monto": number|null, "fuente": "url", "nota": "…"}` as JSON only. Parse the first `{…}` in the text.
  - On success it upserts `tasas_cache`. If `fuente` is missing, it uses `sources[0]`.
  - The tool is registered in `TOOLS` and the executor map, with a Spanish description: "Estima una tasa oficial (marbete, matrícula, ayuntamiento, legalización, impuesto de transferencia…). El monto es aproximado: dígalo siempre como aproximado y que lo confirma la institución; nunca lo sume al total de la cotización."

- [ ] **Step 1: Write failing tests:**
  - `estimar_tasa con búsqueda devuelve monto aproximado y lo guarda`: fake `search` returns `'{"monto":1500,"fuente":"https://dgii.gov.do/x"}'` → `monto_aproximado` 1500, a row in `tasas_cache`;
  - `segunda consulta igual sale de la caché sin buscar`: the search call count stays at 1;
  - `caché vencida (31 días) vuelve a buscar`;
  - `sin search, con error QUOTA o respuesta sin monto → por_confirmar, sin lanzar`;
  - provider test: a fake created without `search` has no `search` method; `getProvider('gemini').search` is a function.

- [ ] **Step 2: Run the tests and confirm they fail.** Run `node --test test/agent-tools-tasas.test.js test/agent-provider.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests.** Run `npm test`. Expected: all PASS.

- [ ] **Step 5: Commit.** `feat(bot): estimar_tasa busca tasas oficiales en la web, aproximadas y en caché 30 días`

---

### Task 6: Guide rules and eval scenarios

**Files:**
- Modify:
  - `src/agent/guide.md`
  - `test/agent/escenarios/08-acto-de-venta-de-mas-de-3-millones.json`
  - `test/agent/catalog-snapshot.json`, only if `bot-eval` prices from it: check `scripts/bot-eval.js` and add `foja_tipo`/`fojas` to the snapshot rows it uses
- Create: `test/agent/escenarios/54-…json` through `58-…json`
- Test: `test/bot-eval-checks.test.js` must stay green. The scenarios run with `npm run bot:eval`, which needs AI quota and is not part of `npm test`.

**Guide changes:**
- **Regla 6:**
  - Replace "Máximo 2 originales notariados…" with: by default each document comes with **1 original**; the only ones with 2 are basic rental contracts for real estate and simple 1-page letter-size contracts; ask how many originals the client needs; each extra one is a duplicate (use `calcular_precio` with `duplicados`).
  - Add "Redacción por foja": prices depend on the fojas; when `fojas_estimadas` is true, say it as an estimate ("un documento así suele tener N fojas…; el precio final depende de las fojas").
- **Regla 7:** add the delivery rule: ask whether the client picks it up, sends someone, or wants us to send it. Delivery goes by Uber and costs what the app charges, confirmed by the team.
- **Regla 5:** add courier for trámites: RD$1,000 per document is a tool price, never typed from memory. Taxes are not included and the client pays them.
- **Tasas:** use `estimar_tasa`, always say "aproximadamente", never add it to the total. If it returns `por_confirmar`, the team confirms.

**Scenarios** (same format as the existing ones):
- 54 "redacción por foja estimada": `herramientas_incluye: ["calcular_precio"]`, `texto_coincide` on `foja`;
- 55 "pide un duplicado": `herramientas_incluye: ["calcular_precio"]`;
- 56 "envío por Uber": `texto_coincide` on `Uber`;
- 57 "legalizar 2 documentos": `herramientas_incluye: ["buscar_servicio"]`;
- 58 "tasa del marbete": `herramientas_incluye: ["estimar_tasa"]`, `texto_coincide` on `aproximad`.

Scenario 08 now gets a price (4M → tier 3000): drop `texto_no_coincide` and the `crear_solicitud` alternative, and expect `calcular_precio`.

All scenarios keep `prohibido.montos_fuera_de_herramientas: true`. Before using any key, check that it exists in `scripts/bot-eval-checks.js`.

- [ ] **Step 1:** Run `node --test test/bot-eval-checks.test.js` and record the baseline.
- [ ] **Step 2:** Edit the guide and the scenarios.
- [ ] **Step 3:** Run `npm test`. Expected: all PASS. Also run `node -e "for (const f of require('fs').readdirSync('test/agent/escenarios')) JSON.parse(require('fs').readFileSync('test/agent/escenarios/'+f))"`. Expected: no error.
- [ ] **Step 4: Commit.** `feat(bot): guía con fojas, originales, envío por Uber, mensajería y tasas aproximadas`

---

### Task 7: Dashboard Catálogo edits fojas

**Files:**
- Modify:
  - `guru-frontend-dev/apps/dashboard/src/pages/ServicesCatalog.tsx`
  - `guru-frontend-dev/apps/dashboard/src/services/api.ts` (`calculate` type)
- Test: `guru-frontend-dev/apps/dashboard/src/pages/ServicesCatalog.test.tsx` (create if missing, following `Settings.test.tsx`'s mocking pattern)

**Interfaces:**
- Consumes: from Task 3, PUT/POST accept `foja_tipo` and `fojas`, and the GET rows include them.

**Behaviour:**
- `Service` gets `foja_tipo: string | null; fojas: number | null`.
- **Form:** a "Precio por foja" select with these options: "No va por foja" (null), "Carta simple — RD$150", "Carta motivada — RD$300", "Legal simple — RD$250" and "Legal motivada — RD$350". When a type is selected:
  - a "Fojas estimadas" number input appears (min 1);
  - the digitación input shows a note: "Con precio por foja se ignora la digitación fija".
- **Save:** the payload includes `foja_tipo` and `fojas` (null when "No va por foja").
- **Card:** a foja service shows `RD$250 × 2 fojas = RD$500` instead of the fixed digitación.
- Rates come from one `FOJA_RATES` constant in the file, with a comment that it mirrors `src/models/fojaRates.js` in the backend.

- [ ] **Step 1: Write failing tests:**
  - `muestra el precio por foja en la tarjeta`: mocked service `foja_tipo:'legal_simple', fojas:2` → the text `RD$250 × 2 fojas`;
  - `editar y guardar manda foja_tipo y fojas`: open edit, choose "Carta motivada", set fojas 3, save → `serviceCatalogAPI.update` is called with `foja_tipo:'carta_motivada', fojas:3`.
- [ ] **Step 2:** Run `npx vitest run src/pages/ServicesCatalog.test.tsx` in `apps/dashboard`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run `npx vitest run` and `npx tsc --noEmit -p .` in `apps/dashboard`. Expected: PASS with no type errors.
- [ ] **Step 5: Commit** in `guru-frontend-dev`. Message: `feat(catálogo): precio por foja editable en el catálogo de servicios`

---

## Ruling recorded at planning

The spec §2 says "Cotizaciones deja poner las fojas en la línea". The quote editor in Cotizaciones has free-text lines and does not use the catalog, so there is nothing to price there. Fojas reach quotes through the bot (Task 3) and the catalog's `/calculate`. If this is wrong, the cost is a small UI follow-up.

## Production run order (Jay)

1. `railway run npm run db:migrate` (Task 1 migration)
2. `railway run node scripts/fojas/apply.js --dry-run`, then without `--dry-run`
3. The frontend deploy as usual
