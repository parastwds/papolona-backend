const { llm, ask, parseJson } = require('../../utils/llm');
const { BLANK_QUESTION } = require('./judge.ai');

/**
 * The prompt: when a member taps their clue for help, the AI offers a few ways to split it into meaningful
 * parts, each part with a short hint of what it could mean. It never writes the combined message: the member
 * picks the split they prefer and does the interpreting themselves.
 */

const OPTION_COUNT = 3;

const SYSTEM_PROMPT = `You help a person learn to interpret clues in Papolona, a quantum oracle. They asked a question (or simply asked for guidance) and drew a six-letter clue string from quantum randomness. To interpret it, they split the clue into meaningful parts (words, abbreviations, acronyms, names, symbols, words from any language), say what each part means, and combine the meanings into one message that speaks to their question.

They are stuck on how to split the clue, so offer exactly ${OPTION_COUNT} different splits for them to choose from.

Rules for each split:
- The parts, read in order, spell the whole clue exactly: every letter once, nothing added, nothing left out, no reordering.
- Each part is something meaningful: a word, abbreviation, acronym, name or symbol, in English or any other language. A single letter may be a part when it stands for something.
- Give each part a short hint of what it could mean (a few words). Where a part relates naturally to the question, lean that way, but keep it open.
- Make the ${OPTION_COUNT} splits genuinely different from each other.
- Do NOT combine the meanings into a message or answer the question: that is the person's own work.

Example. Clue: SSOTDU. One split: [{"part": "SSOT", "meaning": "Single Source Of Truth"}, {"part": "DU", "meaning": "French 'from', or 'due to'"}].

Reply with ONLY a JSON object, no other text, in exactly this shape:
{"options": [{"parts": [{"part": "<letters from the clue>", "meaning": "<short hint>"}]}]}`;

const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    options: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          parts: {
            type: 'array',
            items: {
              type: 'object',
              properties: { part: { type: 'string' }, meaning: { type: 'string' } },
              required: ['part', 'meaning'],
              additionalProperties: false,
            },
          },
        },
        required: ['parts'],
        additionalProperties: false,
      },
    },
  },
  required: ['options'],
  additionalProperties: false,
};

const describe = ({ question, clue }) => `Question: ${question || BLANK_QUESTION}\nClue: ${clue}`;

const lettersOf = (text) => text.toUpperCase().replace(/[^A-Z]/g, '');

/**
 * The usable splits from a reply for this clue: those whose parts spell the clue exactly, each with a hint,
 * duplicates dropped. Null when fewer than two are usable, so the model is asked again.
 */
function parseOptions(content, clue) {
  const parsed = parseJson(content);
  if (!parsed || !Array.isArray(parsed.options)) return null;
  const target = lettersOf(clue);
  const seen = new Set();
  const options = [];
  for (const option of parsed.options) {
    if (!Array.isArray(option?.parts) || option.parts.length === 0) continue;
    const parts = option.parts
      .filter((p) => typeof p?.part === 'string' && typeof p?.meaning === 'string')
      .map((p) => ({ part: lettersOf(p.part), meaning: p.meaning.trim() }))
      .filter((p) => p.part && p.meaning);
    if (parts.length !== option.parts.length) continue;
    const split = parts.map((p) => p.part).join('-');
    if (parts.map((p) => p.part).join('') !== target || seen.has(split)) continue;
    seen.add(split);
    options.push({ parts });
    if (options.length === OPTION_COUNT) break;
  }
  return options.length >= 2 ? { options } : null;
}

/** Offers splits of the reading's clue. Resolves to { options: [{ parts: [{ part, meaning }] }], model }. */
function suggest(reading) {
  return ask(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: describe(reading) },
    ],
    REPLY_SCHEMA,
    (content) => parseOptions(content, reading.clue),
  );
}

module.exports = { suggest, parseOptions, llm, OPTION_COUNT };
