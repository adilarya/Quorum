// OWNER: Doniv (now maintained by Adil) — brain
// runPipeline() wrapper around the RocketRide TS SDK.
// Pipeline: chat → prompt → llm (Butterbase gateway) → extract_data → response_answers
// Stage A: pure mock — keyword heuristic.
// Stage C: real RocketRide engine on :5565, executing pipelines/extract_decision.pipe.
//
// Per the RocketRide TS SDK docs: a pipeline whose source is `chat` must be
// driven with `client.chat({ token, question })` — NOT `client.send()`,
// which is for `webhook` / `dropper` sources. With `Question({ expectJson: true })`
// the answer is delivered already parsed.

import { RocketRideClient, Question } from "rocketride";
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

  const ship = lower.match(/(\w+)\s+(?:ships|launches|launch)\s+(?:on\s+)?(.+?)[.!?]?$/);
  if (ship) {
    return { isDecision: true, topic: `${ship[1]} ship date`, value: ship[2]!.trim() };
  }

  const dl = lower.match(/deadline\s*(?:is|:)\s*(.+?)[.!?]?$/);
  if (dl) {
    return { isDecision: true, topic: "deadline", value: dl[1]!.trim() };
  }

  const tech = lower.match(/(?:we'?re going with|let'?s use|we use|using)\s+([\w.+-]+)/);
  if (tech) {
    return { isDecision: true, topic: "tech choice", value: tech[1]!.trim() };
  }

  return { isDecision: false, topic: "", value: "" };
}

// ---------- Stage C: real RocketRide client ----------

let _client: RocketRideClient | null = null;
let _pipelineToken: string | null = null;

export async function initPipeline(): Promise<void> {
  if (config.useMocks) return;

  try {
    // Per RocketRide docs: prefer the empty constructor so URI + APIKEY come
    // from the extension-managed .env (ROCKETRIDE_URI / ROCKETRIDE_APIKEY).
    // Hardcoding here loses the extension's host config and always misses.
    _client = new RocketRideClient();
    await _client.connect();
    const { token } = await _client.use({ filepath: config.rocketride.pipeline });
    _pipelineToken = token;
    console.log(`[rocketride] pipeline loaded (token=${token})`);
  } catch (error) {
    console.warn("[rocketride] failed to initialize — falling back to mock pipeline:", error);
    _client = null;
    _pipelineToken = null;
  }
}

export async function runPipeline(text: string): Promise<ExtractResult> {
  if (config.useMocks) return mockExtract(text);

  if (!_client || !_pipelineToken) {
    return mockExtract(text);
  }

  try {
    const question = new Question({ expectJson: true });
    question.addQuestion(text);

    const response: any = await _client.chat({ token: _pipelineToken, question });

    // Resilient answer lookup (per RocketRide COMMON_MISTAKES guidance):
    //  1) Use result_types to find which key holds the "answers" lane.
    //  2) Fall back to the conventional `answers` key.
    //  3) Fall back to `output` (matches the laneName our .pipe currently sets).
    const answer = extractAnswer(response);
    if (!answer || typeof answer !== "object") {
      return mockExtract(text);
    }

    return {
      isDecision: Boolean(answer.isDecision),
      topic: String(answer.topic ?? ""),
      value: String(answer.value ?? ""),
    };
  } catch (error) {
    console.warn("[rocketride] pipeline call failed — falling back to mock:", error);
    return mockExtract(text);
  }
}

function extractAnswer(response: any): any | null {
  if (!response) return null;
  if (response.result_types && typeof response.result_types === "object") {
    for (const [key, lane] of Object.entries(response.result_types)) {
      if (lane === "answers" && Array.isArray(response[key]) && response[key].length > 0) {
        return response[key][0];
      }
    }
  }
  if (Array.isArray(response.answers) && response.answers.length > 0) return response.answers[0];
  if (Array.isArray(response.output) && response.output.length > 0) return response.output[0];
  return null;
}
