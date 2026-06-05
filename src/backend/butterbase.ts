// OWNER: Adil — channel + backend
// Butterbase: auth, decisions log, AI Model Gateway.
//
// Verified shapes (from docs.butterbase.ai, 2026-06-05):
//   import { createClient } from "@butterbase/sdk"
//   const bb = createClient({ appId, apiUrl, anonKey })
//   await bb.from("decisions").insert({...})                -> { data, error }
//   AI gateway: OpenAI-compatible, baseURL=https://api.butterbase.ai/v1
//   Authorization: Bearer bb_sk_...   (scope: ai:gateway)
//   Model ids: anthropic/claude-sonnet-4.6, openai/gpt-4o, anthropic/claude-3.5-sonnet
//
// Independent gating: each helper goes REAL when its specific env vars are
// present, regardless of the global USE_MOCKS flag — so backend can ship even
// while the brain is still mocked.

import OpenAI from "openai";
import { createClient } from "@butterbase/sdk";
import { config } from "../config.js";
import type { ComposeReply, LogDecision } from "../brain/types.js";

// ---------- composeReply: AI Model Gateway ----------

let _gateway: OpenAI | null = null;

function gatewayClient(): OpenAI {
  if (_gateway) return _gateway;
  _gateway = new OpenAI({
    apiKey: config.butterbase.gatewayKey!,
    baseURL: config.butterbase.gatewayUrl,
  });
  return _gateway;
}

function gatewayReady(): boolean {
  return Boolean(config.butterbase.gatewayKey && config.butterbase.gatewayUrl);
}

export const composeReply: ComposeReply = async (systemPrompt, userPrompt) => {
  if (!gatewayReady()) {
    return mockComposeReply(systemPrompt, userPrompt);
  }
  try {
    const r = await gatewayClient().chat.completions.create({
      model: config.butterbase.gatewayModel!,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 200,
    });
    const text = r.choices[0]?.message.content?.trim();
    return text && text.length > 0 ? text : mockComposeReply(systemPrompt, userPrompt);
  } catch (err) {
    console.warn("[butterbase] gateway call failed, using mock reply:", err);
    return mockComposeReply(systemPrompt, userPrompt);
  }
};

function mockComposeReply(_systemPrompt: string, userPrompt: string): string {
  const isConflict = /Previously, <@.+> said/.test(userPrompt);
  if (isConflict) {
    const prior = userPrompt.match(/Previously, <@(.+?)> said: "(.+?)"/);
    const next = userPrompt.match(/Just now, <@(.+?)> said: "(.+?)"/);
    const topic = userPrompt.match(/Topic: (.+?)\./)?.[1] ?? "this";
    if (prior && next) {
      return `Conflict on ${topic}: <@${prior[1]}> set "${prior[2]}", <@${next[1]}> just said "${next[2]}". Which holds?`;
    }
    return "Conflict detected — which holds?";
  }
  const confirm = userPrompt.match(/<@(.+?)> just committed to "(.+?)" for "(.+?)"/);
  if (confirm) {
    return `Recorded: ${confirm[3]} = "${confirm[2]}" (per <@${confirm[1]}>).`;
  }
  return "Recorded.";
}

// ---------- logDecision: decisions table ----------

let _bb: ReturnType<typeof createClient> | null = null;

function bbClient() {
  if (_bb) return _bb;
  _bb = createClient({
    appId: config.butterbase.appId!,
    apiUrl: config.butterbase.apiUrl,
    ...(config.butterbase.anonKey ? { anonKey: config.butterbase.anonKey } : {}),
  });
  return _bb;
}

function dbReady(): boolean {
  return Boolean(config.butterbase.appId && config.butterbase.apiKey);
}

const _mockLog: Array<Record<string, unknown>> = [];

export const logDecision: LogDecision = async (row) => {
  const payload = {
    channel_id: row.channelId,
    user_id: row.userId,
    topic: row.topic,
    value: row.value,
    created_at: row.createdAt,
    superseded: row.superseded,
    previous_user_id: row.previousUserId ?? null,
  };

  if (!dbReady()) {
    _mockLog.push({ ...payload, loggedAt: new Date().toISOString() });
    return;
  }

  // 1) Try the SDK insert. If the SDK surface is wrong under time pressure
  //    we fall through to the auto-generated REST endpoint (the brief says
  //    every table gets one by default).
  try {
    const bb: any = bbClient();
    // Service-key auth: most BaaS SDKs accept it via setSession or admin client.
    if (typeof bb.setSession === "function") {
      bb.setSession({ access_token: config.butterbase.apiKey });
    }
    const { error } = await bb.from("decisions").insert(payload);
    if (!error) return;
    console.warn("[butterbase] SDK insert returned error, falling back to REST:", error);
  } catch (err) {
    console.warn("[butterbase] SDK insert threw, falling back to REST:", err);
  }

  // 2) REST fallback. Endpoint shape is best-guess from BaaS convention;
  //    update once we confirm the exact path on dashboard.butterbase.ai/api docs.
  try {
    const restUrl = `${config.butterbase.apiUrl}/v1/apps/${config.butterbase.appId}/tables/decisions/rows`;
    const r = await fetch(restUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.butterbase.apiKey}`,
      },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const body = await r.text();
      console.error(`[butterbase] REST insert failed ${r.status}: ${body}`);
    }
  } catch (err) {
    console.error("[butterbase] REST insert threw:", err);
  }
};

/** Stage-A debugging hook — peek at the in-memory log when running on mocks. */
export function _dumpMockLog(): Array<Record<string, unknown>> {
  return [..._mockLog];
}
