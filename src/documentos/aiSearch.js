// "Buscar con IA": the person describes what they need; Gemini picks models from our selection.
let generator = null;

function setGenerator(fn) {
  generator = fn;
}

async function defaultGenerate(prompt) {
  const { model, fallbackModel } = require('../llm/client');
  try {
    return (await model.generateContent(prompt)).response.text();
  } catch {
    return (await fallbackModel.generateContent(prompt)).response.text();
  }
}

async function aiSearchTemplates(query, catalog) {
  const lines = catalog.map((t) => `${t.id} | ${t.name} | ${t.category || ''}`).join('\n');
  const prompt = `Eres asistente de una oficina de servicios legales en República Dominicana.
Una persona busca un modelo de documento y lo describe así: "${String(query).slice(0, 500)}"

Catálogo de modelos disponibles (id | nombre | categoría):
${lines}

Elige hasta 5 modelos del catálogo que mejor sirvan, del más al menos adecuado. Usa SOLO ids del catálogo.
Responde SOLO con JSON: [{"id": <id>, "reason": "<una frase corta en español de por qué sirve>"}]`;
  const raw = await (generator || defaultGenerate)(prompt);
  const json = String(raw).replace(/```(?:json)?/g, '').trim();
  let picks;
  try {
    picks = JSON.parse(json.slice(json.indexOf('['), json.lastIndexOf(']') + 1));
  } catch {
    return [];
  }
  const byId = new Map(catalog.map((t) => [Number(t.id), t]));
  const seen = new Set();
  return picks
    .filter((p) => p && byId.has(Number(p.id)) && !seen.has(Number(p.id)) && seen.add(Number(p.id)))
    .slice(0, 5)
    .map((p) => ({ ...byId.get(Number(p.id)), reason: String(p.reason || '').slice(0, 200) }));
}

module.exports = { aiSearchTemplates, setGenerator };
