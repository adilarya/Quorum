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
    prompt:
      "The team's scheduling commitments: meeting times, deadlines, appointments, due dates, " +
      "ship/launch dates. Each fact is a topic + a time/date the team has agreed on. Keep one " +
      "current value per topic — supersede older values when a new one is committed.",
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
        // XTrace's extractor is trained on personal facts. Frame this as a
        // first-person commitment ("I'm locking in...") with both the
        // structured topic+value AND an explicit "please remember" cue, so
        // the classifier treats it as a durable scheduling fact instead of
        // chit-chat.
        {
          role: "user",
          content:
            `Please remember this scheduling commitment for my team: ` +
            `the ${topic} is set to ${value}. ` +
            `I'm locking this in as our current agreed value. ` +
            `If I update it later, replace this with the new value.`,
        },
        {
          role: "assistant",
          content:
            `Recorded. I'll remember that your team's ${topic} is ${value}. ` +
            `I'll supersede this if you give me a new value for the same topic.`,
        },
      ],
      user_id: userId,
      conv_id: channelId,
      group_ids: [groupId],
    },
    { wait: true },
  );
  const done = await client.memories.jobs.pollUntilDone(job.id);
  console.log(`[memory] ingest topic="${topic}" value="${value}" -> result:`, JSON.stringify((done as any)?.result ?? done, null, 0));

  const supersededPrior =
    prior && !isValueRestatement(prior.value, value) ? prior : null;
  if (supersededPrior) {
    console.log(`[memory] conflict on "${topic}": prior="${prior!.value}" new="${value}"`);
  }
  return { supersededPrior };
}

async function realRecall(channelId: string, topic: string): Promise<RecallHit | null> {
  const groupId = await realEnsureGroup(channelId);
  // Richer query gives XTrace more semantic surface to match against the
  // facts we ingested ("The team's <topic> is <value>").
  const { memories } = await client.memories.recall({
    query: `What is the team's current ${topic}?`,
    pools: [{ group_ids: [groupId] }],
  });

  const top = memories?.[0];
  if (!top) {
    console.log(`[memory] recall miss for topic="${topic}"`);
    return null;
  }
  console.log(`[memory] recall hit  for topic="${topic}": "${top.text}"`);

  // XTrace paraphrases. Don't try to re-parse a "topic: value" shape — just
  // hand back the stored text as the value and let isValueRestatement decide
  // whether the new statement is a conflict or a restatement.
  return {
    topic,
    value: top.text,
    userId: top.user_id ?? "",
    createdAt: top.created_at ?? new Date().toISOString(),
  };
}

/**
 * True when `newValue` is contained inside `priorValue` token-wise —
 * i.e. the new statement is a restatement of the prior one, not a conflict.
 *   isValueRestatement("Beta will ship on March 20", "March 20")  -> true
 *   isValueRestatement("Beta will ship on March 20", "June 20")   -> false
 *   isValueRestatement("end-of-Q2 public beta target", "early Q3") -> false
 */
export function isValueRestatement(priorValue: string, newValue: string): boolean {
  if (priorValue.toLowerCase() === newValue.toLowerCase()) return true;
  const pl = priorValue.toLowerCase();
  const words = newValue
    .toLowerCase()
    .split(/[\s,.\-/]+/)
    .filter((w) => w.length > 1);
  if (words.length === 0) return false;
  return words.every((w) => pl.includes(w));
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

