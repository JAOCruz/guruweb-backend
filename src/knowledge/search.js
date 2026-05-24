const LEGAL_TOPICS = require('./legalTopics');
const INSTITUTIONS = require('./institutions');
const { normalize } = require('../conversation/nlp');

function searchKnowledge(query) {
  const norm = normalize(query);
  const words = norm.split(/\s+/).filter(w => w.length > 2);
  const results = [];

  // Search legal topics
  for (const [key, topic] of Object.entries(LEGAL_TOPICS)) {
    let score = 0;
    for (const word of words) {
      for (const kw of topic.keywords) {
        if (kw.includes(word) || word.includes(kw)) score++;
      }
      if (topic.title.toLowerCase().includes(word)) score += 2;
    }
    if (score > 0) results.push({ type: 'legal_topic', key, score, data: topic });
  }

  // Search institutions
  for (const [key, inst] of Object.entries(INSTITUTIONS)) {
    let score = 0;
    for (const word of words) {
      for (const kw of inst.keywords) {
        if (kw.includes(word) || word.includes(kw)) score++;
      }
      if (inst.name.toLowerCase().includes(word)) score += 2;
    }
    if (score > 0) results.push({ type: 'institution', key, score, data: inst });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

function getTopicByKey(key) {
  return LEGAL_TOPICS[key] || null;
}

function getInstitutionByKey(key) {
  return INSTITUTIONS[key] || null;
}

function formatTopicResult(topic) {
  let text = topic.content;
  if (topic.law_refs && topic.law_refs.length > 0) {
    text += `\n\n📚 *Base legal:* ${topic.law_refs.join(', ')}`;
  }
  return text;
}

function formatInstitutionResult(inst) {
  return `🏛️ *${inst.name}*\n\n` +
    `${inst.description}\n\n` +
    `🔗 ${inst.url}`;
}

function formatSearchResults(results, maxResults = 3) {
  if (results.length === 0) return null;

  const top = results.slice(0, maxResults);
  let text = '';

  for (const result of top) {
    if (result.type === 'legal_topic') {
      text += formatTopicResult(result.data) + '\n\n';
    } else if (result.type === 'institution') {
      text += formatInstitutionResult(result.data) + '\n\n';
    }
  }

  return text.trim();
}

module.exports = { searchKnowledge, getTopicByKey, getInstitutionByKey, formatTopicResult, formatInstitutionResult, formatSearchResults };
