// Fojas y tipo de foja de un modelo (.docx), para su precio: fojas × tarifa del tipo (pricing_rates.foja).
// - Tamaño: el de la primera sección (w:pgSz). Alto ≥ 19000 twips (8.5×14 = 20160) es legal; carta y A4 son carta.
// - Fojas: las páginas que guardó Word (docProps/app.xml <Pages>), calculadas con las fuentes reales del documento.
//   Sin ese dato se estiman por palabras: 1 foja cada PALABRAS_POR_FOJA, mínimo 1. (LibreOffice se probó el
//   2026-11-23 y no es más exacto: sin las fuentes de Word agrega páginas.)
// - Motivada: escritos, instancias, demandas, recursos y actos de alguacil (Leandro, 2026-10-28: "esas son
//   documentaciones motivadas, las que cuestan por fojas"). Lo demás (contratos, poderes, declaraciones) es simple.
const path = require('path');
const { execFile } = require('child_process');
const { FOJA_RATES } = require('../models/fojaRates');

const SCRIPT = path.join(__dirname, 'docx_pagina.py');
// { h, pages, words } de un .docx (docx_pagina.py, solo librería estándar de Python)
function pageInfo(file) {
  return new Promise((resolve, reject) => {
    execFile(process.env.PYTHON_BIN || 'python3', [SCRIPT, file], { timeout: 30_000 }, (err, out) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

const LEGAL_MIN_TWIPS = 19000;
const PALABRAS_POR_FOJA = 450;
const MOTIVADA = /DEMANDA|RECURS|ESCRITO|INSTANCIA|ALGUACIL|NOTIFICACI/i;

// info: { h, pages, words } de pageInfo. clasificacion: texto con la carpeta y la categoría del modelo.
function clasificarModelo({ h = 0, pages = null, words = 0 } = {}, clasificacion = '') {
  const size = Number(h) >= LEGAL_MIN_TWIPS ? 'legal' : 'carta';
  const tipo = `${size}_${MOTIVADA.test(clasificacion) ? 'motivada' : 'simple'}`;
  if (Number.isInteger(pages) && pages > 0) return { fojas: pages, foja_tipo: tipo, estimadas: false };
  return { fojas: Math.max(1, Math.ceil((Number(words) || 0) / PALABRAS_POR_FOJA)), foja_tipo: tipo, estimadas: true };
}

async function fojasDeModelo(file, clasificacion = '') {
  return clasificarModelo(await pageInfo(file), clasificacion);
}

// Precio con las tarifas cargadas (llame antes a refreshRates). null si falta algo.
function precioDeModelo({ fojas, foja_tipo } = {}) {
  const rate = FOJA_RATES[foja_tipo];
  return Number.isInteger(fojas) && fojas > 0 && rate ? fojas * rate : null;
}

module.exports = { clasificarModelo, fojasDeModelo, precioDeModelo, MOTIVADA };
