import Anthropic from '@anthropic-ai/sdk';

/** The three models offered in the picker. Default first. */
export const MODELS = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
] as const;

export const DEFAULT_MODEL = MODELS[0].id;

/**
 * The read_topic tool: Q&A retrieval. Answered locally from the fetched corpus,
 * never over the network.
 */
export const READ_TOPIC_TOOL: Anthropic.Tool = {
  name: 'read_topic',
  description:
    'Read the full Atlas article for a topic id. Call this before answering whenever the summaries are not enough; call once per relevant topic (max 3 per question).',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'e.g. "caching/cdn"' },
    },
    required: ['id'],
    additionalProperties: false,
  },
};

// After this many tool-resolution rounds, force a final text answer.
const MAX_TOOL_ROUNDS = 3;
const CAP_NOTE =
  "You have reached the maximum number of topic reads for this question. Answer now, using what you've read; do not ask to read more.";

/**
 * Construct the browser Anthropic client. Sends the CORS opt-in header
 * (anthropic-dangerous-direct-browser-access). Call only after a key exists.
 * The key is sent only to api.anthropic.com by the SDK — never logged or
 * URL-encoded here.
 */
export function makeClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

export interface StreamTurnArgs {
  client: Anthropic;
  model: string;
  system: string;
  /** Conversation so far (must already include the new user turn). */
  history: Anthropic.MessageParam[];
  /** Q&A mode only. Omit for interview mode (no tools). */
  tools?: Anthropic.Tool[];
  /** Resolve a read_topic call locally; return null for an unknown id. */
  readTopic?: (id: string) => string | null;
  /**
   * Called at the start of each assistant round (before streaming). Lets the
   * caller reset its text accumulator so pre-tool narration from an earlier
   * round is not prepended to the final synthesis round's answer.
   */
  onRoundStart?: () => void;
  /** Called with each streamed text delta. */
  onText: (delta: string) => void;
  signal?: AbortSignal;
}

/**
 * Stream one assistant turn, running the manual read_topic tool loop when tools
 * are supplied. Returns the messages to append to history (the assistant turn,
 * plus any tool-result user turns). Streaming text is delivered via onText.
 *
 * Errors (typed SDK exceptions, AbortError) propagate to the caller.
 */
export async function streamTurn(args: StreamTurnArgs): Promise<Anthropic.MessageParam[]> {
  const { client, model, system, tools, readTopic, onRoundStart, onText, signal } = args;
  const canUseTools = Boolean(tools && tools.length && readTopic);

  const appended: Anthropic.MessageParam[] = [];
  const messages: Anthropic.MessageParam[] = [...args.history];

  for (let round = 0; ; round++) {
    // On the final round, drop tools so the model must produce a text answer
    // (guaranteeing no dangling tool_use is left in the transcript).
    const withTools = canUseTools && round < MAX_TOOL_ROUNDS;

    // Start of a new assistant round — let the caller clear its display buffer.
    onRoundStart?.();

    const stream = client.messages.stream(
      {
        model,
        max_tokens: 8192,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages,
        ...(withTools ? { tools } : {}),
      },
      { signal },
    );
    stream.on('text', (delta) => onText(delta));
    const msg = await stream.finalMessage();

    const assistant: Anthropic.MessageParam = { role: 'assistant', content: msg.content };
    messages.push(assistant);
    appended.push(assistant);

    if (!withTools || msg.stop_reason !== 'tool_use') break;

    const toolUses = msg.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    if (toolUses.length === 0) break;

    const nextIsFinal = round + 1 >= MAX_TOOL_ROUNDS;
    const results: Anthropic.ContentBlockParam[] = toolUses.map((tu) => {
      const input = tu.input as { id?: unknown };
      const id = typeof input?.id === 'string' ? input.id : '';
      const body = readTopic ? readTopic(id) : null;
      if (body === null) {
        return {
          type: 'tool_result',
          tool_use_id: tu.id,
          content: 'unknown topic id',
          is_error: true,
        };
      }
      return { type: 'tool_result', tool_use_id: tu.id, content: body };
    });

    const content: Anthropic.ContentBlockParam[] = nextIsFinal
      ? [...results, { type: 'text', text: CAP_NOTE }]
      : results;
    const userTurn: Anthropic.MessageParam = { role: 'user', content };
    messages.push(userTurn);
    appended.push(userTurn);
  }

  return appended;
}
