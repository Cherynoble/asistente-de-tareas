/** A message as stored in app.db, fed to the extractor. */
export interface IngestedMessage {
  id: number;
  chatName: string | null;
  sender: string | null;
  direction: 'incoming' | 'outgoing';
  body: string;
  ts: number;
}

/** Optional context: who a client is and what they buy/need. */
export interface ClientContext {
  name: string;
  productNeed: string;
}

/** A task the AI proposes from the messages. */
export interface ProposedTask {
  title: string;
  detail: string;
  sourceMessageId: number | null; // app.db messages.id that triggered it
  sourceQuote: string; // verbatim snippet to search in WhatsApp/iMessage
  clientHint: string | null; // chat/sender the task relates to
}

/** An already-open task, passed in so the extractor doesn't re-propose duplicates. */
export interface ExistingTask {
  title: string;
  clientHint: string | null;
}

/**
 * Provider-agnostic extraction interface. Implementations (Claude/Haiku, a
 * local Ollama model, Gemini, ...) all satisfy this, so we can A/B them on real
 * data without touching the rest of the app.
 */
export interface TaskExtractor {
  readonly name: string;
  proposeTasks(
    messages: IngestedMessage[],
    clients?: ClientContext[],
    existingTasks?: ExistingTask[],
  ): Promise<ProposedTask[]>;
}
