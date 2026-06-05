// OWNER: SHARED — change only by agreement; frozen after Stage A.
// Define ALL keys here up front. Neither owner should add new env reads
// in their own files — add them here and import.

import "dotenv/config";

type Provider = "terminal" | "slack" | "imessage";

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

function req(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v && v.length > 0) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var ${name}`);
}

function opt(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

export const config = {
  useMocks: bool(process.env.USE_MOCKS, true),
  provider: (opt("PROVIDER") ?? "terminal") as Provider,

  xtrace: {
    apiKey: opt("XTRACE_API_KEY"),
    orgId: opt("XTRACE_ORG_ID"),
  },

  rocketride: {
    url: opt("ROCKETRIDE_URL") ?? "http://localhost:5565",
    pipeline: opt("ROCKETRIDE_PIPELINE") ?? "pipelines/extract_decision.pipe",
  },

  butterbase: {
    appId: opt("BUTTERBASE_APP_ID"),
    apiKey: opt("BUTTERBASE_API_KEY"),
    apiUrl: opt("BUTTERBASE_API_URL") ?? "https://api.butterbase.ai",
    anonKey: opt("BUTTERBASE_ANON_KEY"),
    gatewayUrl: opt("BUTTERBASE_GATEWAY_URL") ?? "https://api.butterbase.ai/v1",
    gatewayKey: opt("BUTTERBASE_GATEWAY_KEY"),
    gatewayModel: opt("BUTTERBASE_GATEWAY_MODEL") ?? "anthropic/claude-sonnet-4.6",
  },

  spectrum: {
    projectId: opt("SPECTRUM_PROJECT_ID"),
    projectSecret: opt("SPECTRUM_PROJECT_SECRET"),
  },

  slack: {
    appToken: opt("SLACK_APP_TOKEN"),
    botToken: opt("SLACK_BOT_TOKEN"),
    channelId: opt("SLACK_CHANNEL_ID"),
  },
} as const;

export type Config = typeof config;
export { req };
