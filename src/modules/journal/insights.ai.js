const { llm, ask, parseJson } = require('../../utils/llm');

// Part of each saved reading's fingerprint: bump it when the prompt changes, so readings made
// with an older prompt are made again the next time their day is opened.
const PROMPT_VERSION = 3;

// The model is asked for JSON in the prompt too: Ollama's `format` option is ignored by some cloud models.
const SYSTEM_PROMPT = `You help a person reflect on their perception journal: what they noticed in nature and daily life, how it felt, and any meaningful coincidences.
You receive one day of their entries, and the six-letter clue they drew that day if any.
Reply with ONLY a JSON object, no other text, in exactly this shape:
{"refined": "<the day's entries rewritten as one clear, well-written reflection in the first person>"}

For "refined":
- Keep their meaning, voice and language. Fix grammar and repetition, and join the entries into a natural flow.
- Never invent events, feelings, people or details that are not in the entries.
- Do not add advice, interpretation, questions or commentary of your own.`;

// Claude's reply is constrained to this shape, so it always parses.
const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    refined: { type: 'string' },
  },
  required: ['refined'],
  additionalProperties: false,
};

function describeDay(entries) {
  const clues = [...new Set(entries.map((e) => e.clue?.clue).filter(Boolean))];
  const lines = entries.map((e) => `- (${e.source === 'voice' ? 'spoken' : 'written'}) ${e.text.replace(/\s+/g, ' ').trim()}`);
  return `${clues.length ? `Clue of the day: ${clues.join(', ')}` : 'No clue drawn yet.'}\n\nEntries:\n${lines.join('\n')}`;
}

/** The refined text from a reply, or null when it is missing. */
function parseReply(content) {
  const parsed = parseJson(content);
  const refined = typeof parsed?.refined === 'string' ? parsed.refined.trim() : '';
  return refined ? { refined } : null;
}

/** Refines one day of entries into one reflection. Retries once if the reply is not usable JSON. */
function readDay(entries) {
  return ask(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: describeDay(entries) },
    ],
    REPLY_SCHEMA,
    parseReply,
  );
}

module.exports = { readDay, parseReply, describeDay, llm, PROMPT_VERSION };
