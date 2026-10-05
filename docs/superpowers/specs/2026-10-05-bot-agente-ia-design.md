# Bot de WhatsApp como asistente de IA con herramientas — Diseño

Fecha: 2026-10-05 · Estado: borrador para revisión de Jay y Leandro
Auditoría de la documentación: `guru-soluciones/docs/bot-ia/2026-10-05-auditoria-documentacion.md`

## 1. Objetivo

Que el bot de WhatsApp de Gurú converse de forma natural, sin menús numerados ni pasos fijos. Mientras conversa:
- responde con los precios y reglas reales del negocio;
- recoge los datos del cliente;
- crea la solicitud;
- prepara la cotización para que el admin la apruebe;
- pasa el chat a una persona cuando hace falta.

Es una de las funciones principales que Leandro pagó, así que la calidad se mide con pruebas antes de usarlo con clientes reales.

**Éxito significa:**
- en la batería de pruebas, ninguna conversación se tranca;
- nunca da un precio que no esté en el catálogo;
- nunca entrega nada sin aprobación humana;
- Leandro lee las conversaciones de prueba y reconoce su forma de atender.

**Fuera de alcance de esta fase:**
- generar y enviar documentos legales por WhatsApp (va en la fase 2, con revisión del digitador);
- campañas y mensajes salientes con plantillas de Meta;
- editor del comportamiento en el panel (fase 3).

## 2. Cómo funciona

```
Mensaje de WhatsApp (Meta)
  → handler: agrupa 3 s, guarda medios, transcribe notas de voz, analiza fotos (ya existe)
  → si el chat usa el motor nuevo: agent.respond(phone, texto, medios)
       1. arma el contexto
       2. llama al modelo con las herramientas
       3. ejecuta las herramientas que pida (máx. 6 por turno) y vuelve a llamar
       4. devuelve el texto final
  → se envía por Meta y se guarda en Mensajes, con las herramientas que usó
```

**El contexto de cada turno:**
- **Guía del bot**: identidad, tono, reglas y ejemplos. Texto fijo y versionado, **sin precios**.
- **Datos del negocio**: horario, dirección, formas de pago. Sale de la base de datos, no del texto.
- **Ficha del cliente**:
  - nombre;
  - perfil legal (los datos que ya dio);
  - solicitudes abiertas y su estado;
  - resumen de conversaciones anteriores.
- **Conversación**: los últimos 30 mensajes del chat.

Los precios **no van en el contexto**: el bot los consulta con herramientas. Así un precio cambiado en el panel se nota de inmediato, y no hay cuatro copias que se contradigan.

**Modelo intercambiable:** el código habla con un adaptador (`BOT_AI_PROVIDER=gemini|claude`).
- Empezamos con Gemini 2.5 Flash, que ya está pagado.
- La misma batería de pruebas corre con los dos, para decidir con datos.

**Encendido por chat:**
- La variable `BOT_ENGINE=legacy|agent` decide el motor por defecto.
- Se puede activar el motor nuevo solo en chats elegidos (el número de prueba), igual que el modo Seleccionados.
- El motor viejo queda intacto hasta que el nuevo lo reemplace.

## 3. Herramientas

| Herramienta | Qué hace | ¿Solo o con aprobación? |
|---|---|---|
| `buscar_servicio(consulta)` | Busca en el catálogo por nombre o nombre alternativo ("traspaso", "venta del carro"). Devuelve precio, qué incluye, reglas y requisitos | Solo |
| `calcular_precio(servicio, valor_del_bien?, cantidad?, con_notarizacion?)` | Usa el cálculo del catálogo que ya existe, con los tramos por valor | Solo |
| `ver_tramite(nombre)` | Pasos, preguntas obligatorias y servicios que suman el total de un trámite (traspaso, salida de menor, apostilla…) | Solo |
| `guardar_datos_cliente(campos)` | Guarda lo que el cliente dijo (nombre, cédula, estado civil, dirección…) en su ficha y su perfil legal. Nunca borra un dato: si cambia, guarda el nuevo y deja constancia | Solo |
| `leer_documento(archivo)` | Extrae los datos de una cédula, matrícula o título que el cliente envió. El bot le confirma al cliente lo que leyó antes de guardarlo | Solo |
| `crear_solicitud(servicio, detalles)` | Registra al cliente si es nuevo, crea la solicitud (caso), la asigna según el modo de asignación del panel y avisa al digitador | Solo |
| `preparar_cotizacion(partidas)` | Crea la cotización como si fuera un digitador: queda **por aprobar** por el admin, igual que en el panel. El bot le dice al cliente que se la confirma enseguida | **Aprobación del admin** |
| `estado_solicitud()` | Estado de las solicitudes del cliente (responde a "ESTADO DE MI SOLICITUD") | Solo |
| `pasar_a_humano(motivo)` | Pone el chat en modo manual, avisa al asignado (o al admin) y responde con el mensaje de espera según el horario | Solo |

**Aprobaciones:**
- Cuando el admin aprueba una cotización en el panel, el sistema se la envía al cliente por WhatsApp (ya existe el envío desde Cotizaciones).
- El pago lo confirma siempre una persona. El bot solo pide el comprobante.

## 4. Reglas fijas

Salen de la documentación más nueva: Esqueletos, Índice, bot-spec-v2, Customer Service Workflow y Persona IA.

1. **Precios:**
   - Solo da precios del catálogo.
   - Nunca inventa ni descuenta.
   - Si un servicio no tiene precio, dice que lo confirma y pasa el caso al digitador.
2. **Entregas:** nunca entrega documentos ni confirma pagos. Siempre lo hace un humano.
3. **Confidencialidad:** nunca revela al notario ni las comisiones.
4. **Apostilla:**
   - Antes de cotizar, pregunta cuántos documentos son y para qué país.
   - Explica el camino real: notarial → Procuraduría → MIREX.
5. **Trámites:**
   - Hace las preguntas obligatorias del Índice. Ejemplos: "¿el documento lo elaboramos nosotros o lo trae usted?", "¿dónde está el vehículo?".
   - No acepta un permiso de menor con menos de 24 h.
6. **Reglas de servicio:**
   - Más de 3 modificaciones = recomendar una redacción.
   - Máximo 2 originales notariados.
   - Certificaciones con 48 h de antelación.
   - Mensajería y trámites con un mínimo de 24 h.
7. **Pagos:**
   - Por transferencia o en efectivo.
   - Envío y recogida dentro del horario.
   - Dirección: Av. Independencia 1607, Santo Domingo.
8. **Horario y traspaso a una persona:**
   - El horario es de lunes a viernes, de 9:00 a 18:00.
   - Al pasar el chat a una persona, el bot responde: "Un miembro de nuestro equipo se comunicará con usted a la brevedad. ⏰ Horario de atención: Lunes a Viernes, 9:00 a 18:00 hrs. Si su asunto es urgente fuera de horario, escriba 'urgente'."
   - Si el cliente escribe "urgente" fuera de horario, el aviso al admin va marcado como urgente.
9. **Tono:**
   - Dominicano y cercano, con los emojis oficiales de Persona IA.
   - Pregunta antes de cotizar.
   - Mensajes cortos.
   - El trato (tú o usted) queda definido por los ejemplos que mande Leandro.
10. **Asesoría legal:** no da asesoría legal definitiva. Los temas delicados van a una persona (lista pendiente de Leandro).
11. **Devoluciones:** no promete reembolsos. Explica la política escrita (30% si un trámite se cae) y lo pasa al admin.

## 5. Cambios en la base de datos

**`service_catalog`** (columnas nuevas):
- `descripcion`;
- `incluye`;
- `reglas`;
- `requisitos` (qué debe traer el cliente);
- `alias` (nombres con que lo pide la gente);
- `notarizacion` (opcional / obligatoria / no aplica);
- `template_id` (modelo de Word, si existe);
- `tiempo_entrega` (puede quedar vacío).

Además:
- Corregir las categorías mal puestas: instancias y notificaciones.
- Corregir los duplicados.
- Unificar las dos tablas de tramos de los actos de venta.

**Tabla nueva `tramites`:**
- nombre y alias;
- pasos, cada uno con su servicio del catálogo y sus preguntas;
- preguntas obligatorias;
- reglas (24 h, reembolso del 30%).

El total de un trámite es la suma de los servicios de sus pasos (sin impuestos aparte, por ahora).

**Tabla nueva `business_info`:** horario, dirección, formas de pago y mensajes fijos. El panel podrá editarla en la fase 3.

**Tabla nueva `bot_memory`:** un resumen por cliente de lo hablado y lo pendiente. Se actualiza al cerrar cada conversación.

**Tabla nueva `bot_tool_log`:** cada herramienta que usó el bot, con qué datos y su resultado. Sirve para auditar y para verlo en Mensajes.

**Carga inicial:**
- Los ~60 precios de la documentación que faltan.
- Las reglas de Esqueletos.
- Los 7 trámites del Índice.
- Las descripciones las propongo yo a partir de la documentación, y Leandro las corrige.

**Limpieza:**
- Se quitan los precios escritos a mano en `systemPrompt.js` y `services.js`.
- El texto que queda es solo la guía de comportamiento.

## 6. Fallos y límites

| Situación | Qué hace el bot |
|---|---|
| El modelo falla o tarda más de 25 s | Reintenta una vez. Si vuelve a fallar, pasa el chat a una persona con el mensaje de espera. Nunca deja al cliente sin respuesta ni le contesta con un error técnico |
| Una herramienta falla | El bot lo sabe ("no pude guardar") y no inventa el resultado |
| Más de 6 herramientas en un turno | Corta y pasa a una persona |
| Cuota de IA agotada | Sigue el reintento diferido que ya existe |
| Cliente repite lo mismo 3 veces o se enoja | Pasa a una persona |

Además:
- Las fotos de cédula se guardan como hoy, en el volumen.
- Los registros no muestran el contenido de los mensajes.

## 7. Pruebas

1. **Batería automática** (`test/agent/escenarios/*.json`):
   - Contenido:
     - unas 40 conversaciones escritas como el cliente las diría;
     - las de Leandro se agregan cuando las mande.
   - Cada escenario verifica:
     - las herramientas esperadas (p. ej. "pidió un acto de venta y preguntó el valor del vehículo antes de dar precio");
     - prohibiciones (ningún precio fuera del catálogo, ninguna entrega);
     - que no termine trancado.
   - Una segunda IA califica el tono con una rúbrica.
   - Corre contra una base de datos de prueba con el catálogo real copiado.
2. **Comparación Gemini vs Claude** con la misma batería: aciertos, costo por conversación y tiempo de respuesta.
3. **Número de prueba de Meta**, en modo Seleccionados, con conversaciones reales de Jay y Leandro.
4. **Solo después**, un número real con un grupo pequeño de clientes.

## 8. Fases

- **Fase 1** (este diseño):
  - el bot nuevo con herramientas, catálogo enriquecido, trámites, ficha del cliente, solicitudes, cotización con aprobación y paso a una persona;
  - batería de pruebas;
  - en Mensajes se ven las herramientas usadas.
- **Fase 2:** preparar documentos de Word con los datos del perfil legal (lo que ya hace Documentos/Etiquetas) para que el digitador los revise y los envíe.
- **Fase 3:**
  - editor de la guía, horarios y mensajes en el panel;
  - métricas;
  - estrategia por tipo de cliente.

## 9. Pendiente de Leandro (va en un PDF aparte)

- Precios que faltan:
  - mensajería por distancia;
  - pasos de mensajería de los trámites;
  - originales adicionales;
  - ~120 modelos sin precio.
- Decidir los conflictos de precio:
  - estatus jurídico;
  - instancias;
  - estatutos y nómina;
  - foto 2x2;
  - tramos de los actos de venta.
- Lista de temas que siempre van a una persona.
- Ejemplos de conversaciones para situaciones frecuentes.
- Tiempos de entrega.
- Descuentos y devoluciones: quién decide.
- Privacidad de los datos.
- El archivo "GURU_PRECIOS_OFICIALES.pdf".
