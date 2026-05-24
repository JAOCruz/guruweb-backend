const { transitionTo } = require('../stateManager');
const { MSG } = require('../messages');
const { SERVICE_CATEGORIES, formatCategory, formatAllCategories } = require('../../knowledge/services');

const CATEGORY_KEYS = Object.keys(SERVICE_CATEGORIES);

async function handle(session, text) {
  const step = session.step;

  switch (step) {
    case 'menu': {
      const choice = parseInt(text.trim(), 10);

      if (choice === 0) {
        await transitionTo(session, 'main_menu', 'show', {});
        return MSG.MAIN_MENU;
      }

      if (!isNaN(choice) && choice >= 1 && choice <= CATEGORY_KEYS.length) {
        const catText = formatCategory(CATEGORY_KEYS[choice - 1]);
        await transitionTo(session, 'services', 'post_category', {});
        return catText + '\n\n' + POST_CATEGORY_MENU;
      }

      return 'Por favor, seleccione un número válido de la lista.';
    }

    case 'post_category': {
      const choice = text.trim();
      if (choice === '1') {
        await transitionTo(session, 'services', 'menu');
        return formatAllCategories();
      }
      if (choice === '2') {
        await transitionTo(session, 'main_menu', 'show', {});
        return MSG.MAIN_MENU;
      }
      return MSG.INVALID_OPTION;
    }

    default:
      await transitionTo(session, 'services', 'menu');
      return formatAllCategories();
  }
}

const POST_CATEGORY_MENU =
  `¿Qué desea hacer?\n\n` +
  `1️⃣ Ver otra categoría\n` +
  `2️⃣ Regresar al menú principal`;

module.exports = { handle };
