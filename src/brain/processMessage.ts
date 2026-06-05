// OWNER: Doniv — brain
// THE CONTRACT. Adil imports this and treats everything else as a black box.
// Signature is frozen — if you need to change it, talk to Adil and update the
// type, not the call sites.

import { runPipeline, recordRecentDecision, getCurrentDecision } from "./rocketride.js";
import { ingestDecision } from "./memory.js";
import { isValueRestatement } from "./memory.js";
import type { BrainDeps, ProcessResult } from "./types.js";

/**
 * Factory pattern: deps (composeReply, logDecision) come from the boot file
 * via injection, so this module never imports src/backend/*.
 */
export function makeProcessMessage(deps: BrainDeps) {
  return async function processMessage(
    channelId: string,
    userId: string,
    text: string,
  ): Promise<ProcessResult> {
    // 1) extract — pipeline says "is this a decision, and what about?"
    //    channelId gives the extractor recent decisions as context, so a
    //    follow-up like "actually 6pm" reuses the existing topic name.
    const extracted = await runPipeline(text, channelId);
    if (!extracted.isDecision) {
      return { reply: null };
    }

    // 2) Conflict detection — deterministic. We use the in-memory cache as
    //    the source of truth for "what does the team currently believe?",
    //    independent of XTrace's eventual-consistency behaviour.
    const prior = getCurrentDecision(channelId, extracted.topic);
    const conflicted =
      prior && !isValueRestatement(prior.value, extracted.value)
        ? { topic: prior.topic, value: prior.value, userId: prior.userId, createdAt: new Date().toISOString() }
        : null;

    // 3) Ingest into XTrace as historical memory — best-effort, not on the
    //    critical path. If XTrace silently drops it, we don't care; the
    //    conflict has already been decided above.
    void ingestDecision(channelId, userId, extracted.topic, extracted.value).catch((err) => {
      console.warn("[memory] ingest failed (non-fatal):", err);
    });

    // 4) Update the cache so the next message sees this as the current belief.
    recordRecentDecision(channelId, extracted.topic, extracted.value, userId);

    // 4) log to Butterbase (injected — brain stays backend-agnostic)
    await deps.logDecision({
      channelId,
      userId,
      topic: extracted.topic,
      value: extracted.value,
      createdAt: new Date().toISOString(),
      superseded: false,
      ...(conflicted ? { previousUserId: conflicted.userId } : {}),
    });

    // 5) compose the reply via Butterbase gateway (also injected)
    const systemPrompt = [
      "You are Quorum, an in-channel assistant that keeps a team's decisions consistent.",
      "Reply in ONE short sentence. No preamble. Name the people involved when there is a conflict.",
    ].join(" ");

    const userPrompt = conflicted
      ? buildConflictPrompt({
          newUserId: userId,
          newValue: extracted.value,
          priorUserId: conflicted.userId,
          priorValue: conflicted.value,
          topic: extracted.topic,
        })
      : buildConfirmPrompt({
          userId,
          topic: extracted.topic,
          value: extracted.value,
        });

    const reply = await deps.composeReply(systemPrompt, userPrompt);
    return { reply };
  };
}

// ---------- prompt helpers ----------

function buildConflictPrompt(args: {
  newUserId: string;
  newValue: string;
  priorUserId: string;
  priorValue: string;
  topic: string;
}): string {
  return [
    `Topic: ${args.topic}.`,
    `Previously, <@${args.priorUserId}> said: "${args.priorValue}".`,
    `Just now, <@${args.newUserId}> said: "${args.newValue}".`,
    `Acknowledge the conflict, name both people, and ask which holds.`,
  ].join(" ");
}

function buildConfirmPrompt(args: {
  userId: string;
  topic: string;
  value: string;
}): string {
  return [
    `<@${args.userId}> just committed to "${args.value}" for "${args.topic}".`,
    `Confirm we've recorded it. Keep it under 12 words.`,
  ].join(" ");
}
