// OWNER: Adil — channel + backend
// Butterbase: auth, decisions log, AI Model Gateway.
// Stage A: composeReply returns a templated mock string; logDecision is in-memory.
// Stage D: route every reply through the OpenAI-compatible gateway and insert
//          into the `decisions` table.
//
// IMPORTANT: Doniv's brain calls these as INJECTED functions — keep this module
// channel/brain-agnostic and don't import anything from src/brain/.

import OpenAI from "openai";
import { config } from "../config.js";
import type { ComposeReply, LogDecision } from "../brain/types.js";

// ---------- composeReply ----------
// OpenAI-compatible gateway is the verified Butterbase shape; only the base URL
// and model id need confirming in the live docs.

let _gateway: OpenAI | null = null;

function gatewayClient(): OpenAI {
  if (_gateway) return _gateway;
  if (!config.butterbase.gatewayKey || !config.butterbase.gatewayUrl) {
    throw new Error("BUTTERBASE_GATEWAY_KEY / BUTTERBASE_GATEWAY_URL not set");
  }
  _gateway = new OpenAI({
    apiKey: config.butterbase.gatewayKey,
    baseURL: config.butterbase.gatewayUrl,
  });
  return _gateway;
}

export const composeReply: ComposeReply = async (systemPrompt, userPrompt) => {
  if (config.useMocks) {
    return mockComposeReply(systemPrompt, userPrompt);
  }
  const client = gatewayClient();
  const r = await client.chat.completions.create({
    // TODO(doc): confirm the exact model id Butterbase's gateway accepts.
    model: config.butterbase.gatewayModel ?? "claude-3-5-sonnet",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });
  return r.choices[0]?.message.content ?? "";
};

/**
 * Stage-A mock: deterministic, no network. Looks at the userPrompt to choose
 * between conflict + confirm replies so the demo loop FEELS like the real one.
 */
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

// ---------- logDecision ----------
// Stage A: in-memory log. Stage D: insert into the auto-generated REST endpoint
// for the `decisions` table, or use @butterbase/sdk directly.

const _mockLog: Array<Record<string, unknown>> = [];

export const logDecision: LogDecision = async (row) => {
  if (config.useMocks) {
    _mockLog.push({ ...row, loggedAt: new Date().toISOString() });
    return;
  }
  // TODO(doc): exact SDK shape from https://www.npmjs.com/package/@butterbase/sdk
  //   import { Butterbase } from "@butterbase/sdk";
  //   const bb = new Butterbase({ projectId: config.butterbase.projectId!, apiKey: ... });
  //   await bb.from("decisions").insert(row);
  //
  // Fallback while SDK names are unverified: hit the auto-generated REST endpoint.
  //   await fetch(`${BASE}/decisions`, { method: "POST", headers: { Authorization: `Bearer ${jwt}` }, body: JSON.stringify(row) });
  throw new Error("Butterbase real logDecision not wired yet — STUB.");
};

/** For Stage-A debugging only. */
export function _dumpMockLog(): Array<Record<string, unknown>> {
  return [..._mockLog];
}

// ---------- auth (Stage D) ----------
// TODO(doc): JWT helper — email/Google/GitHub/magic-link. For the demo, a single
// service token signed by Butterbase is enough; expose getServiceJwt() here when wired.
