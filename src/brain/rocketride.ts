// OWNER: Doniv (now maintained by Adil) — brain
// runPipeline() wrapper with a three-tier fallback chain:
//   1) RocketRide pipeline (preferred, deep integration)
//      - chat → prompt → llm (Butterbase gateway) → response_answers
//      - requires the RocketRide engine to be reachable at the URI in .env
//   2) Direct Butterbase AI Model Gateway call (same prompt, same model)
//      - kicks in when RocketRide is unreachable but the gateway is configured
//      - gives LLM-quality extraction without depending on a running engine
//   3) Keyword heuristic (last resort)
//
// USE_MOCKS=true bypasses 1 and 2 entirely.

import OpenAI from "openai";
import { RocketRideClient, Question } from "rocketride";
import { config } from "../config.js";
import type { ExtractResult } from "./types.js";

// ---------- 3) keyword heuristic (Stage A mock + final fallback) ----------

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

// ---------- 2) direct Butterbase gateway extraction ----------

const EXTRACTION_SYSTEM_PROMPT = [
  "You are the extractor for Quorum, a team SCHEDULING assistant. Your ONLY job is to spot commitments about WHEN something happens — a date, a time, a deadline, a meeting time, an appointment.",
  "Nothing else counts. Tech choices, opinions, jokes, names, prices, plans without a time → isDecision=false.",
  "",
  "You will receive:",
  "- 'Existing decisions': the team's current scheduling commitments in this conversation (may be empty).",
  "- 'New message': one short message from a team member.",
  "",
  "Pick ONE of three classifications for the new message:",
  "  1. Off-topic / chit-chat / no when-commitment → {\"isDecision\": false, \"topic\": \"\", \"value\": \"\"}",
  "  2. A NEW scheduling commitment. This is the DEFAULT when the message has both a SUBJECT and a TIME/DATE (e.g. 'lets grab dinner at 7pm', 'beta ships June 20', 'math hw due 6/10').",
  "     Coin a fresh short kebab-shaped topic such as: 'dinner time', 'meeting time', 'standup time', 'deadline for <thing>', '<thing> due date', 'launch date', 'ship date', 'lunch time', 'coffee time', '<person> appointment', 'sync time'.",
  "     DO NOT reuse an existing topic just because the subject is vaguely similar (dinner ≠ pizza, math hw ≠ english hw, beta ≠ alpha).",
  "  3. An UPDATE to one of the 'Existing decisions'. Use this ONLY when the message is clearly an elliptical follow-up that omits the subject:",
  "     'actually X', 'no wait', 'scratch that, X', 'make it X', 'push to X', 'move to X', 'change it to X', or a bare time/date that obviously refers to the most-recent existing commitment.",
  "     In this case AND ONLY THIS CASE, reuse the EXACT topic name from the existing list. This is how conflict detection fires.",
  "     If the message names its own subject, it is rule 2 (NEW), not rule 3.",
  "",
  "For 'value': a short normalised string with the time/date. Keep the user's wording but clean it:",
  "   '3pm Tuesday', 'June 20', '6/7/2026', 'tomorrow 5pm', 'next Friday at 10am', 'end of Q2'.",
  "",
  "Return ONLY this JSON. No prose, no code fence, no trailing comment:",
  `{"isDecision": boolean, "topic": string, "value": string}`,
  "",
  "Examples:",
  `Existing: (none). New: "meeting at 3pm tomorrow" -> {"isDecision": true, "topic": "meeting time", "value": "3pm tomorrow"}`,
  `Existing: (none). New: "math hw due 6/7" -> {"isDecision": true, "topic": "math homework due date", "value": "6/7"}`,
  `Existing: (none). New: "beta ships June 20" -> {"isDecision": true, "topic": "beta ship date", "value": "June 20"}`,
  `Existing: (none). New: "let's grab coffee at 9am wednesday" -> {"isDecision": true, "topic": "coffee time", "value": "9am Wednesday"}`,
  `Existing: (none). New: "we're using Postgres" -> {"isDecision": false, "topic": "", "value": ""}`,
  `Existing: (none). New: "lol same" -> {"isDecision": false, "topic": "", "value": ""}`,
  `Existing: ["meeting time: 3pm tomorrow"]. New: "actually 4pm" -> {"isDecision": true, "topic": "meeting time", "value": "4pm tomorrow"}`,
  `Existing: ["coffee time: 9am Wednesday"]. New: "make it 10am instead" -> {"isDecision": true, "topic": "coffee time", "value": "10am Wednesday"}`,
  `Existing: ["beta ship date: June 20"]. New: "push to July 5" -> {"isDecision": true, "topic": "beta ship date", "value": "July 5"}`,
  `Existing: ["math homework due date: 6/7"]. New: "wait, hw is due 6/8" -> {"isDecision": true, "topic": "math homework due date", "value": "6/8"}`,
  `Existing: ["pizza time: 7pm Friday"]. New: "lets grab dinner at 7pm friday" -> {"isDecision": true, "topic": "dinner time", "value": "7pm Friday"}  // ← NEW topic, has its own subject`,
  `Existing: ["dinner time: 7pm Friday"]. New: "lock in 8pm friday" -> {"isDecision": true, "topic": "dinner time", "value": "8pm Friday"}  // ← elliptical follow-up, reuse topic`,
  `Existing: ["standup time: 9am daily"]. New: "thanks!" -> {"isDecision": false, "topic": "", "value": ""}`,
].join("\n");

// Per-channel rolling list of recent decisions so the extractor can reuse
// the canonical topic name when a follow-up refers to one of them.
const recentByChannel = new Map<string, Array<{ topic: string; value: string }>>();

function recentContextLines(channelId: string | undefined): string[] {
  if (!channelId) return [];
  const arr = recentByChannel.get(channelId);
  if (!arr || arr.length === 0) return [];
  return arr.map((d) => `- ${d.topic}: ${d.value}`);
}

export function recordRecentDecision(
  channelId: string,
  topic: string,
  value: string,
  userId: string,
): void {
  let arr = recentDetailedByChannel.get(channelId);
  if (!arr) {
    arr = [];
    recentDetailedByChannel.set(channelId, arr);
  }
  // Replace any prior entry with the same topic (case-insensitive) so the
  // store holds the *current* belief per topic, not the history.
  const idx = arr.findIndex((d) => d.topic.toLowerCase() === topic.toLowerCase());
  if (idx >= 0) arr.splice(idx, 1);
  arr.push({ topic, value, userId });
  if (arr.length > 50) arr.shift();

  // Keep the simple list used by recentContextLines() in sync.
  let simple = recentByChannel.get(channelId);
  if (!simple) {
    simple = [];
    recentByChannel.set(channelId, simple);
  }
  const sIdx = simple.findIndex((d) => d.topic.toLowerCase() === topic.toLowerCase());
  if (sIdx >= 0) simple.splice(sIdx, 1);
  simple.push({ topic, value });
  if (simple.length > 10) simple.shift();
}

/**
 * Deterministic source of truth for "what does the team currently believe
 * about this topic in this channel?" Used by the brain for conflict
 * detection — independent of XTrace's eventual-consistency behaviour.
 */
export function getCurrentDecision(
  channelId: string,
  topic: string,
): { topic: string; value: string; userId: string } | null {
  const arr = recentDetailedByChannel.get(channelId);
  if (!arr) return null;
  const hit = arr.find((d) => d.topic.toLowerCase() === topic.toLowerCase());
  return hit ?? null;
}

const recentDetailedByChannel = new Map<
  string,
  Array<{ topic: string; value: string; userId: string }>
>();

let _gateway: OpenAI | null = null;

function gatewayClient(): OpenAI {
  if (_gateway) return _gateway;
  if (!config.butterbase.gatewayKey) {
    throw new Error("BUTTERBASE_GATEWAY_KEY required for gateway extraction");
  }
  _gateway = new OpenAI({
    apiKey: config.butterbase.gatewayKey,
    baseURL: config.butterbase.gatewayUrl,
  });
  return _gateway;
}

async function gatewayExtract(text: string, channelId?: string): Promise<ExtractResult> {
  const ctxLines = recentContextLines(channelId);
  const userContent = ctxLines.length === 0
    ? `Existing decisions: (none yet)\nNew message: "${text}"`
    : `Existing decisions:\n${ctxLines.join("\n")}\n\nNew message: "${text}"`;

  const r = await gatewayClient().chat.completions.create({
    model: config.butterbase.gatewayModel ?? "anthropic/claude-sonnet-4.6",
    messages: [
      { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
    max_tokens: 200,
    temperature: 0,
  });

  const content = r.choices[0]?.message.content?.trim() ?? "";
  // Model occasionally wraps JSON in a code fence or adds prose. Grab the
  // first balanced {...} block as the extraction result.
  const match = content.match(/\{[\s\S]*?\}/);
  if (!match) throw new Error(`no JSON in gateway response: ${content.slice(0, 120)}`);

  const parsed = JSON.parse(match[0]);
  return {
    isDecision: Boolean(parsed.isDecision),
    topic: String(parsed.topic ?? ""),
    value: String(parsed.value ?? ""),
  };
}

// ---------- 1) RocketRide pipeline ----------

let _client: RocketRideClient | null = null;
let _pipelineToken: string | null = null;

export async function initPipeline(): Promise<void> {
  if (config.useMocks) return;

  try {
    // Empty constructor: SDK reads ROCKETRIDE_URI / ROCKETRIDE_APIKEY from .env
    // (extension auto-syncs these when the user configures Direct Connect / Cloud).
    _client = new RocketRideClient();
    await _client.connect();
    const { token } = await _client.use({ filepath: config.rocketride.pipeline });
    _pipelineToken = token;
    console.log(`[rocketride] pipeline loaded (token=${token})`);
  } catch (error) {
    console.warn("[rocketride] engine unreachable — will use Butterbase gateway fallback:", error);
    _client = null;
    _pipelineToken = null;
  }
}

async function rocketrideExtract(text: string): Promise<ExtractResult> {
  if (!_client || !_pipelineToken) throw new Error("rocketride not initialised");

  const question = new Question({ expectJson: true });
  question.addQuestion(text);

  const response: any = await _client.chat({ token: _pipelineToken, question });
  const answer = extractAnswer(response);
  if (!answer || typeof answer !== "object") throw new Error("no parseable answer from pipeline");

  return {
    isDecision: Boolean(answer.isDecision),
    topic: String(answer.topic ?? ""),
    value: String(answer.value ?? ""),
  };
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

// ---------- public surface ----------

export async function runPipeline(text: string, channelId?: string): Promise<ExtractResult> {
  if (config.useMocks) return mockExtract(text);

  // Tier 1: RocketRide pipeline (if engine reachable)
  if (_client && _pipelineToken) {
    try {
      return await rocketrideExtract(text);
    } catch (error) {
      console.warn("[rocketride] call failed, trying gateway fallback:", error);
    }
  }

  // Tier 2: direct Butterbase gateway extraction with channel context
  if (config.butterbase.gatewayKey) {
    try {
      return await gatewayExtract(text, channelId);
    } catch (error) {
      console.warn("[gateway] extract fallback failed, using heuristic:", error);
    }
  }

  // Tier 3: keyword heuristic
  return mockExtract(text);
}
