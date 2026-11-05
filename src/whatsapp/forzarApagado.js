// Seguro de Railway para tener el número real en modo manual: con BOT_FORZAR_APAGADO el bot no le escribe a
// ningún cliente, sin importar lo que diga la base o si se pudo leer. Un valor mal escrito también apaga:
// solo vacío, false, 0 o no lo dejan como estaba.
function botForzadoApagado() {
  const value = String(process.env.BOT_FORZAR_APAGADO ?? '').trim().toLowerCase();
  return !['', 'false', '0', 'no'].includes(value);
}

module.exports = { botForzadoApagado };
