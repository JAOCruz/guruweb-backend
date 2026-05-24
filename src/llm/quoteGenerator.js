const { SERVICE_CATEGORIES } = require('../knowledge/services');

/**
 * Extract quantities and item names from user message
 * Handles patterns like "16 hojas blancas", "5 folders", etc.
 */
function extractItemsFromMessage(text) {
  const items = [];
  const seen = new Set(); // Track to avoid duplicates

  // Pattern: "número item(s)" — matches "16 hojas blancas", "5 folders", "2 sacapuntas"
  // Lookahead to stop before next number or end of message
  const pattern = /(\d+)\s+(?:de\s+)?([a-záéíóúñüü\s]+?)(?=\s+\d+|$)/gi;

  let match;
  while ((match = pattern.exec(text)) !== null) {
    const quantity = parseInt(match[1]);
    const itemName = match[2].trim().toLowerCase();

    // Skip duplicates and short items
    if (itemName.length < 2) continue;
    const key = `${quantity}-${itemName}`;
    if (seen.has(key)) continue;
    seen.add(key);

    items.push({ quantity, item: itemName });
  }

  return items;
}

/**
 * Find matching catalog item by name (fuzzy matching with synonyms)
 */
function findCatalogItem(searchTerm) {
  const searchLower = searchTerm.toLowerCase().trim();

  // Synonyms for common office supply terms
  const synonyms = {
    'hojas': ['papel', 'hoja', 'papeles', 'papel bon'],
    'blancas': ['blanco', 'blanc', 'white'],
    'folders': ['folder', 'carpeta', 'carpetas', 'manila'],
    'sacpntas': ['sacapuntas', 'sacapunta', 'sacpnta', 'saca puntas', 'saca punta'],
    'bolígrafos': ['bolígrafo', 'boligrafo', 'lapicero', 'lapiceros'],
    'lápices': ['lápiz', 'lapiz', 'lapices'],
  };

  // Expand search term with synonyms
  let searchVariations = [searchLower];
  for (const [key, values] of Object.entries(synonyms)) {
    if (searchLower.includes(key)) {
      values.forEach(syn => {
        searchVariations.push(searchLower.replace(key, syn));
      });
    }
  }

  // Search ONLY in tienda_fisica for office supply quote requests
  const category = SERVICE_CATEGORIES.tienda_fisica;
  if (!category || !category.items) return null;

  // First pass: exact substring match
  for (const item of category.items) {
    const itemNameLower = item.name.toLowerCase();
    for (const variation of searchVariations) {
      if (itemNameLower.includes(variation)) {
        return { ...item, category: 'tienda_fisica', categoryName: category.name };
      }
    }
  }

  // Second pass: word-based matching (more lenient)
  for (const item of category.items) {
    const itemNameLower = item.name.toLowerCase();
    const itemWords = itemNameLower.split(/\s+/);

    for (const variation of searchVariations) {
      const searchWords = variation.split(/\s+/).filter(w => w.length > 2);
      if (searchWords.length === 0) continue;

      // Match if ANY search word starts same as ANY item word
      for (const searchWord of searchWords) {
        for (const itemWord of itemWords) {
          // Exact word match or good prefix match
          if (itemWord === searchWord || (itemWord.length > 3 && searchWord.length > 3 &&
              itemWord.substring(0, 4) === searchWord.substring(0, 4))) {
            return { ...item, category: 'tienda_fisica', categoryName: category.name };
          }
        }
      }
    }
  }

  return null;
}

/**
 * Get price for an item based on quantity
 * For range prices, defaults to higher value unless specific type requested
 */
function getPrice(item, quantity, userMessage = '') {
  if (!item.prices) return null;

  const prices = item.prices;

  if (prices.unidad) {
    return prices.unidad * quantity;
  } else if (prices.desde && prices.hasta) {
    // Range price: default to higher value (metal/premium)
    // Unless user is asking about types/options
    const useHigher = !/(cual|que tipo|plastico|metal|opciones|tipos)/i.test(userMessage);
    const unitPrice = useHigher ? prices.hasta : Math.floor((prices.desde + prices.hasta) / 2);
    return unitPrice * quantity;
  } else if (prices.unico) {
    return prices.unico;
  }

  return null;
}

/**
 * Generate a quote from user message
 * Returns { success, items: [], total, message }
 */
function generateQuote(userMessage) {
  const extracted = extractItemsFromMessage(userMessage);

  if (extracted.length === 0) {
    return { success: false, message: null };
  }

  const quote = { items: [], total: 0 };
  let message = `*COTIZACIÓN* 📋\n\n`;

  for (const { quantity, item: itemName } of extracted) {
    const catalogItem = findCatalogItem(itemName);

    if (!catalogItem) {
      // Item not found - might not be a quote request
      return { success: false, message: null };
    }

    const itemTotal = getPrice(catalogItem, quantity, userMessage);
    if (!itemTotal) {
      return { success: false, message: null };
    }

    // Check if user is asking about item types/options
    const isAskingAboutTypes = /(cual|que tipo|plastico|metal|opciones|tipos)/i.test(userMessage);
    const hasRangePrice = catalogItem.prices && catalogItem.prices.desde && catalogItem.prices.hasta;

    // Get unit price for display
    let unitPrice;
    if (catalogItem.prices.unidad) {
      unitPrice = catalogItem.prices.unidad;
    } else if (catalogItem.prices.desde && catalogItem.prices.hasta) {
      const useHigher = !isAskingAboutTypes;
      unitPrice = useHigher ? catalogItem.prices.hasta : Math.floor((catalogItem.prices.desde + catalogItem.prices.hasta) / 2);
    } else {
      unitPrice = catalogItem.prices.unico;
    }

    // Add "metal" label for sacapuntas when using higher price
    let displayName = catalogItem.name;
    if (catalogItem.name.toLowerCase().includes('sacapunta') && hasRangePrice && !isAskingAboutTypes) {
      displayName = `${catalogItem.name} (metal)`;
    }

    quote.items.push({
      name: displayName,
      originalName: catalogItem.name,
      quantity,
      unitPrice,
      total: itemTotal,
      hasOptions: hasRangePrice && catalogItem.name.toLowerCase().includes('sacapunta'),
    });

    quote.total += itemTotal;

    // Add note if item has options and user is asking about them
    const optionNote = (hasRangePrice && isAskingAboutTypes) ?
      `\n  (${catalogItem.prices.desde} RD$ plástico / ${catalogItem.prices.hasta} RD$ metal)` : '';

    message += `• ${quantity}x ${displayName}${optionNote}\n  RD$ ${itemTotal.toLocaleString('es-DO')}\n\n`;
  }

  if (quote.items.length === 0) {
    return { success: false, message: null };
  }

  message += `───────────────────\n`;
  message += `*TOTAL: RD$ ${quote.total.toLocaleString('es-DO')}*\n\n`;
  message += `¿Es todo lo que necesita? Escriba *SÍ* para confirmar y recibir la factura, o cuénteme si falta algo.`;

  return {
    success: true,
    items: quote.items,
    total: quote.total,
    message,
  };
}

/**
 * Check if message is asking for a quote
 */
function isQuoteRequest(text) {
  const quoteKeywords = [
    'cotiza',
    'cuanto',
    'precio',
    'costo',
    'cuánto',
    'cuanto es',
    'me vende',
    'venden',
  ];

  const lowerText = text.toLowerCase();
  return quoteKeywords.some(keyword => lowerText.includes(keyword));
}

module.exports = {
  generateQuote,
  isQuoteRequest,
  extractItemsFromMessage,
  findCatalogItem,
};
