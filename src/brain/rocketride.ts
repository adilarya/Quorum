// OWNER: Doniv — brain
// runPipeline() wrapper around the RocketRide TS SDK.
// Stage A: pure mock — keyword heuristic that extracts simple "<topic> <verb> <value>".
// Stage C: connect engine on :5565, load .pipe, call send() per message.

import { config } from "../config.js";
import type { ExtractResult } from "./types.js";

// ---------- Stage A: mock implementation ----------

/**
 * Very small heuristic so the Stage-A demo actually surfaces decisions.
 * Patterns it catches:
 *   "beta ships June 20"           -> { topic: "beta ship date", value: "June 20" }
 *   "deadline is July 5"           -> { topic: "deadline", value: "July 5" }
 *   "we're going with Postgres"    -> { topic: "database choice", value: "Postgres" }
 * Everything else is treated as chit-chat (isDecision: false).
 */
function mockExtract(text: string): ExtractResult {
  const t = text.trim();
  const lower = t.toLowerCase();

  // pattern: "<X> ships <when>"  or  "<X> launches <when>"
  const ship = lower.match(/(\w+)\s+(?:ships|launches|launch)\s+(?:on\s+)?(.+?)[.!?]?$/);
  if (ship) {
    return { isDecision: true, topic: `${ship[1]} ship date`, value: ship[2]!.trim() };
  }

  // pattern: "deadline is <when>"  or  "deadline: <when>"
  const dl = lower.match(/deadline\s*(?:is|:)\s*(.+?)[.!?]?$/);
  if (dl) {
    return { isDecision: true, topic: "deadline", value: dl[1]!.trim() };
  }

  // pattern: "we'?re going with <X>"  or  "use <X>"  for tech choices
  const tech = lower.match(/(?:we'?re going with|let'?s use|we use|using)\s+([\w.+-]+)/);
  if (tech) {
    return { isDecision: true, topic: "tech choice", value: tech[1]!.trim() };
  }

  return { isDecision: false, topic: "", value: "" };
}

// ---------- Stage C: real RocketRide client ----------
import { RocketRideClient } from "rocketride";

const client = new RocketRideClient({ uri: config.rocketride.url });

let _pipelineToken: string | null = null;

export async function initPipeline(): Promise<void> {
  if (config.useMocks) return;

  try {
    const { token } = await client.use({ filepath: config.rocketride.pipeline });
    _pipelineToken = token;
  } catch (error) {
    console.warn("RocketRide client failed to initialize — falling back to mock pipeline:", error);
  }
}

export async function runPipeline(text: string): Promise<ExtractResult> {
  if (config.useMocks) return mockExtract(text);

  // If RocketRide isn't initialized, fall back to mock
  if (!_pipelineToken) {
    return mockExtract(text);
  }

  try {
    const resp = await client.send(_pipelineToken, text);
    if (!resp) {
      return mockExtract(text);
    }
    const json = JSON.parse(resp.output);

    // Map RocketRide output to our ExtractResult format
    return {
      isDecision: json.isDecision ?? false,
      topic: json.topic ?? "",
      value: json.value ?? "",
    };
  } catch (error) {
    console.warn("RocketRide pipeline failed — falling back to mock:", error);
    return mockExtract(text);
  }
}
