const Anthropic = require('@anthropic-ai/sdk');
const env = require('../config/env');
const ApiError = require('./ApiError');
const logger = require('./logger');

/**
 * The language model behind the journal reading and the clue judge: Claude when ANTHROPIC_API_KEY
 * is set, otherwise Ollama when OLLAMA_URL is set. Callers send chat messages and a JSON schema
 * for the reply; Claude is held to the schema, Ollama only by the prompt.
 */

const unavailable = () =>
  new ApiError(502, 'AI_UNAVAILABLE', 'The journal assistant could not be reached. Please try again in a moment.');

const notConfigured = () => new ApiError(503, 'AI_NOT_CONFIGURED', 'The journal assistant is not available right now.');

// Low, for Ollama: replies should stay close to what the user wrote.
// Claude takes no temperature: its API rejects sampling settings.
const TEMPERATURE = 0.3;

let client;
const anthropicClient = () => {
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: env.AI_TIMEOUT_SECONDS * 1000, maxRetries: 1 });
  return client;
};

/** POSTs a chat request and returns the parsed body, or throws AI_UNAVAILABLE. */
async function post(name, url, headers, body, timeoutSeconds) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
  } catch (err) {
    logger.error(`${name} request failed`, err);
    throw unavailable();
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    logger.error(`${name} responded ${response.status}`, payload?.error ?? payload);
    throw unavailable();
  }
  return payload;
}

const providers = {
  anthropic: {
    model: () => env.ANTHROPIC_MODEL,
    async chat(messages, schema) {
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      let response;
      try {
        response = await anthropicClient().messages.create({
          model: env.ANTHROPIC_MODEL,
          max_tokens: 4000,
          system,
          messages: messages.filter((m) => m.role !== 'system'),
          // Short tasks: low effort keeps them quick and cheap.
          output_config: { effort: 'low', ...(schema && { format: { type: 'json_schema', schema } }) },
        });
      } catch (err) {
        logger.error(`Anthropic request failed${err instanceof Anthropic.APIError ? ` (${err.status})` : ''}`, err.message);
        throw unavailable();
      }
      const text = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
      if (response.stop_reason === 'refusal' || !text) {
        logger.error(`Anthropic reply had no text (stop reason: ${response.stop_reason})`);
        throw unavailable();
      }
      return text;
    },
  },
  ollama: {
    model: () => env.OLLAMA_MODEL,
    async chat(messages) {
      const payload = await post(
        'Ollama',
        `${env.OLLAMA_URL.replace(/\/+$/, '')}/api/chat`,
        {},
        { model: env.OLLAMA_MODEL, messages, stream: false, options: { temperature: TEMPERATURE } },
        env.AI_TIMEOUT_SECONDS,
      );
      if (typeof payload?.message?.content !== 'string') {
        logger.error('Ollama reply had no message', payload);
        throw unavailable();
      }
      return payload.message.content;
    },
  },
};

/** Claude when ANTHROPIC_API_KEY is set, otherwise Ollama when OLLAMA_URL is set, otherwise null. */
const activeProvider = () => (env.ANTHROPIC_API_KEY ? providers.anthropic : env.OLLAMA_URL ? providers.ollama : null);

/** The model call. Kept on an object so tests can replace it. */
const llm = {
  model: () => activeProvider()?.model(),
  chat: (messages, schema) => activeProvider().chat(messages, schema),
};

/** The first {...} block of a reply, parsed, or null; models sometimes wrap JSON in prose or code fences. */
function parseJson(content) {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Sends the messages and returns `parse(reply)`, asking once more if that is null (unusable JSON).
 * Throws AI_NOT_CONFIGURED without a model, AI_UNAVAILABLE when it can't be reached or keeps failing.
 */
async function ask(messages, schema, parse) {
  if (!activeProvider()) throw notConfigured();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = parse(await llm.chat(messages, schema));
    if (result) return { ...result, model: llm.model() };
  }
  logger.error('The model reply was not the expected JSON twice in a row');
  throw unavailable();
}

module.exports = { llm, ask, parseJson };
