// buscar_ley: micro asesorías con base legal. Devuelve artículos de las leyes cargadas (con su fuente) y los temas e
// instituciones que escribió el equipo. El bot solo cita lo que viene aquí.
const library = require('../../legal/library');

const MAX_TEXT = 1200;

async function buscar_ley(args) {
  const consulta = typeof args?.consulta === 'string' ? args.consulta.trim() : '';
  if (!consulta) return { error: 'falta la consulta' };
  try {
    const { articles, topics } = await library.search(consulta);
    const out = {
      temas: topics.map((t) => ({
        tipo: t.kind, titulo: t.title, explicacion: t.body, base_legal: t.legal_basis || null, enlace: t.url || null,
      })),
      articulos: articles.map((a) => ({
        ley: a.short, articulo: a.num, seccion: a.section || null,
        texto: a.text.length > MAX_TEXT ? `${a.text.slice(0, MAX_TEXT)}…` : a.text, fuente: a.source_url || null,
      })),
    };
    if (!out.temas.length && !out.articulos.length) {
      out.nota = 'No hay nada en la biblioteca sobre esto: no cite leyes ni artículos. Explique en general o pase a una persona.';
    }
    return out;
  } catch (err) {
    if (err.code === '42P01') return { error: 'la biblioteca legal aún no está cargada' };
    throw err;
  }
}

module.exports = { buscar_ley };
