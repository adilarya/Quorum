// OWNER: Doniv — brain
// XTrace wrapper: ensureGroup, ingestDecision, recallCurrent.
// Stage A: in-memory Map keyed by channelId+topic — proves the conflict-bust loop.
// Stage B: real XTrace — re-ingest supersedes; recall pulls reconciled context.
//
// XTrace API surface (VERIFIED from docs):
//   new MemoryClient({ apiKey, orgId })
//   groups.create({ name, prompt })                                  -> { id }
//   memories.ingest({ messages, user_id, conv_id, group_ids }, { wait: true })
//     -> job; memories.jobs.pollUntilDone(job.id)
//   memories.recall({ query, pools: [{ group_ids: [...] }] })
//     -> { prompt, memories }
//   NO update() — re-ingest the new statement to supersede.

import { config } from "../config.js";

// ---------- shared types ----------
export interface StoredFact {
  channelId: string;
  userId: string;
  topic: string;
  value: string;
  createdAt: string;
  superseded: boolean;
}

export interface RecallHit {
  topic: string;
  value: string;
  userId: string;          // who set the current belief
  createdAt: string;
}

// ---------- Stage A: in-memory store ----------
// One channel = one "team brain". Keyed by `${channelId}::${topic}`.
const mockStore = new Map<string, StoredFact>();
const mockGroupIds = new Map<string, string>();   // channelId -> groupId

function key(channelId: string, topic: string): string {
  return `${channelId}::${topic.toLowerCase()}`;
}

async function mockEnsureGroup(channelId: string): Promise<string> {
  let id = mockGroupIds.get(channelId);
  if (!id) {
    id = `grp_mock_${channelId}`;
    mockGroupIds.set(channelId, id);
  }
  return id;
}

async function mockRecall(channelId: string, topic: string): Promise<RecallHit | null> {
  const f = mockStore.get(key(channelId, topic));
  if (!f || f.superseded) return null;
  return {
    topic: f.topic,
    value: f.value,
    userId: f.userId,
    createdAt: f.createdAt,
  };
}

async function mockIngest(
  channelId: string,
  userId: string,
  topic: string,
  value: string,
): Promise<{ supersededPrior: RecallHit | null }> {
  const k = key(channelId, topic);
  const prior = mockStore.get(k);
  const supersededPrior: RecallHit | null =
    prior && !prior.superseded && prior.value.toLowerCase() !== value.toLowerCase()
      ? {
          topic: prior.topic,
          value: prior.value,
          userId: prior.userId,
          createdAt: prior.createdAt,
        }
      : null;
  if (prior) prior.superseded = true;
  mockStore.set(k, {
    channelId,
    userId,
    topic,
    value,
    createdAt: new Date().toISOString(),
    superseded: false,
  });
  return { supersededPrior };
}

// ---------- Stage B: real XTrace client (STUB until wired) ----------
// TODO(doc): https://docs.xtrace.ai/guides/typescript-sdk
//   import { MemoryClient } from "@xtraceai/memory";
//   const client = new MemoryClient({ apiKey: config.xtrace.apiKey!, orgId: config.xtrace.orgId! });
let _client: unknown = null;

async function realEnsureGroup(_channelId: string): Promise<string> {
  // TODO(doc): cache groupId per channelId in a Map. On miss:
  //   const g = await client.groups.create({
  //     name: `team-quorum-${_channelId}`,
  //     prompt: "Decisions the team has committed to: dates, owners, tech choices, commitments.",
  //   });
  //   return g.id;
  throw new Error("XTrace real ensureGroup not wired yet — STUB.");
}

async function realIngestDecision(
  _channelId: string,
  _userId: string,
  _topic: string,
  _value: string,
): Promise<{ supersededPrior: RecallHit | null }> {
  // TODO(doc):
  //   const groupId = await realEnsureGroup(_channelId);
  //   const prior  = await realRecall(_channelId, _topic);
  //   const job = await client.memories.ingest(
  //     {
  //       messages: [
  //         { role: "user", content: `${_topic}: ${_value}` },
  //         { role: "assistant", content: "Recorded." },
  //       ],
  //       user_id: _userId,
  //       conv_id: _channelId,
  //       group_ids: [groupId],
  //     },
  //     { wait: true },
  //   );
  //   await client.memories.jobs.pollUntilDone(job.id);
  //   const supersededPrior = (prior && prior.value.toLowerCase() !== _value.toLowerCase()) ? prior : null;
  //   return { supersededPrior };
  throw new Error("XTrace real ingestDecision not wired yet — STUB.");
}

async function realRecall(_channelId: string, _topic: string): Promise<RecallHit | null> {
  // TODO(doc):
  //   const groupId = await realEnsureGroup(_channelId);
  //   const { memories } = await client.memories.recall({
  //     query: `current value for: ${_topic}`,
  //     pools: [{ group_ids: [groupId] }],
  //   });
  //   parse out topic/value/userId from the top-ranked memory.
  throw new Error("XTrace real recall not wired yet — STUB.");
}

// ---------- public wrapper surface ----------

export async function ensureGroup(channelId: string): Promise<string> {
  return config.useMocks ? mockEnsureGroup(channelId) : realEnsureGroup(channelId);
}

export async function recallCurrent(
  channelId: string,
  topic: string,
): Promise<RecallHit | null> {
  return config.useMocks ? mockRecall(channelId, topic) : realRecall(channelId, topic);
}

/**
 * The reconciliation primitive. Always writes; returns the prior belief it
 * superseded, if any (so processMessage can name both people in the reply).
 */
export async function ingestDecision(
  channelId: string,
  userId: string,
  topic: string,
  value: string,
): Promise<{ supersededPrior: RecallHit | null }> {
  return config.useMocks
    ? mockIngest(channelId, userId, topic, value)
    : realIngestDecision(channelId, userId, topic, value);
}

// Keep linter quiet about the unused real client placeholder.
void _client;
