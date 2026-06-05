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

// ---------- Stage B: real XTrace client ----------
import { MemoryClient } from "@xtraceai/memory";

const client = new MemoryClient({
  apiKey: config.xtrace.apiKey!,
  orgId: config.xtrace.orgId!,
});

// Cache groupId per channelId to avoid creating duplicate groups
const realGroupIds = new Map<string, string>();

async function realEnsureGroup(channelId: string): Promise<string> {
  const cached = realGroupIds.get(channelId);
  if (cached) return cached;

  const g = await client.groups.create({
    name: `team-quorum-${channelId}`,
    prompt: "Decisions the team has committed to: dates, owners, tech choices, commitments.",
  });
  realGroupIds.set(channelId, g.id);
  return g.id;
}

async function realIngestDecision(
  channelId: string,
  userId: string,
  topic: string,
  value: string,
): Promise<{ supersededPrior: RecallHit | null }> {
  const groupId = await realEnsureGroup(channelId);
  const prior = await realRecall(channelId, topic);

  const job = await client.memories.ingest(
    {
      messages: [
        { role: "user", content: `${topic}: ${value}` },
        { role: "assistant", content: "Recorded." },
      ],
      user_id: userId,
      conv_id: channelId,
      group_ids: [groupId],
    },
    { wait: true },
  );
  await client.memories.jobs.pollUntilDone(job.id);

  const supersededPrior =
    prior && prior.value.toLowerCase() !== value.toLowerCase() ? prior : null;
  return { supersededPrior };
}

async function realRecall(channelId: string, topic: string): Promise<RecallHit | null> {
  const groupId = await realEnsureGroup(channelId);
  const { memories } = await client.memories.recall({
    query: `current value for: ${topic}`,
    pools: [{ group_ids: [groupId] }],
  });

  const top = memories?.[0];
  if (!top) return null;

  // We store facts as `${topic}: ${value}` in realIngestDecision, so parse back.
  const match = top.text.match(/(.+?):\s*(.+)/);
  if (!match) return null;

  return {
    topic: match[1]!.trim(),
    value: match[2]!.trim(),
    userId: top.user_id ?? "",
    createdAt: top.created_at ?? new Date().toISOString(),
  };
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

