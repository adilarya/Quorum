// OWNER: Adil — channel + backend
// Boot file. Picks a Spectrum provider, runs the message loop, hands every
// inbound message to processMessage(channelId, userId, text), and posts the
// reply back. Treats src/brain/ as a black box.

import { config } from "./config.js";
import { composeReply, logDecision } from "./backend/butterbase.js";
import { makeProcessMessage } from "./brain/processMessage.js";
import { initPipeline } from "./brain/rocketride.js";

async function main(): Promise<void> {
  // Inject backend deps into the brain so it stays backend-agnostic.
  const processMessage = makeProcessMessage({ composeReply, logDecision });

  // Stage C+: warm RocketRide. Mock-mode no-ops.
  await initPipeline();

  // Pick a provider. Stage A = terminal (projectless, no creds).
  // Stage E = slack. Kill-switch = imessage.
  const providers = await loadProviders(config.provider);

  const { Spectrum } = await import("spectrum-ts");
  const app = await Spectrum({
    ...(config.spectrum.projectId && config.spectrum.projectSecret
      ? {
          projectId: config.spectrum.projectId,
          projectSecret: config.spectrum.projectSecret,
        }
      : {}),
    providers,
  } as Parameters<typeof Spectrum>[0]);

  // Use a typing-indicator wrapper to cover XTrace re-ingest latency.
  // for-await loop is the verified pattern.
  // [VERIFY LIVE] exact field for the space id.
  for await (const [space, message] of app.messages) {
    if (message.content.type !== "text") continue;
    if (!message.sender) continue;                       // system / bot frames
    const text = message.content.text;
    const userId = message.sender.id;
    const channelId = space.id;

    try {
      const result = await space.responding(async () => {
        return processMessage(channelId, userId, text);
      });
      if (result?.reply) {
        await space.send(result.reply);
      }
    } catch (err) {
      console.error("[quorum] processMessage failed:", err);
    }
  }
}

async function loadProviders(provider: typeof config.provider): Promise<unknown[]> {
  switch (provider) {
    case "terminal": {
      // STAGE A path — no creds needed.
      // TODO(doc): confirm "spectrum-ts/providers/terminal" subpath if the import errors.
      const mod = await import("spectrum-ts/providers/terminal");
      return [mod.terminal.config()];
    }
    case "slack": {
      const { slackProvider } = await import("./channel/slackProvider.js");
      return [slackProvider()];
    }
    case "imessage": {
      // KILL-SWITCH — needs Spectrum project creds (managed line).
      const mod = await import("spectrum-ts/providers/imessage");
      return [mod.imessage.config()];
    }
    default: {
      const _exhaustive: never = provider;
      throw new Error(`unknown PROVIDER: ${String(_exhaustive)}`);
    }
  }
}

main().catch((err) => {
  console.error("[quorum] fatal:", err);
  process.exit(1);
});
