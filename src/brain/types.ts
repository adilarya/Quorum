// OWNER: Doniv — brain
// The types that ride on the processMessage contract. Adil consumes
// `ProcessResult` only; everything else is internal to src/brain/.

export interface ExtractResult {
  isDecision: boolean;
  topic: string;        // e.g. "beta ship date"
  value: string;        // e.g. "June 20"
  /** Set by the pipeline if it already knows this collides with a prior fact. */
  conflictsWith?: string;
}

export interface Decision {
  channelId: string;
  userId: string;
  topic: string;
  value: string;
  createdAt: string;    // ISO
  superseded: boolean;
}

export interface ProcessResult {
  /** null = stay silent (not a decision worth replying to). */
  reply: string | null;
}

/**
 * Injected by the boot code (src/index.ts) so the brain never imports
 * src/backend/*. Lets us swap the gateway (Butterbase real → mock → iMessage
 * kill-switch) without touching anything under src/brain/.
 */
export type ComposeReply = (
  systemPrompt: string,
  userPrompt: string,
) => Promise<string>;

/**
 * Same injection pattern for the decision log — keeps backend code out of the brain.
 */
export type LogDecision = (row: Decision & { previousUserId?: string }) => Promise<void>;

export interface BrainDeps {
  composeReply: ComposeReply;
  logDecision: LogDecision;
}
