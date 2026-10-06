// Minúsculas, sin acentos, espacios simples.
function fold(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

module.exports = { fold };
