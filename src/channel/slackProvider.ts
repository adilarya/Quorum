// OWNER: Adil — channel + backend
// Custom Slack provider for Spectrum via definePlatform.
// Inbound:  @slack/socket-mode — events arrive via .on(), we push to a queue,
//           the async generator drains the queue and yields Spectrum messages.
// Outbound: @slack/web-api — chat.postMessage to the channel.
//
// Required Slack app scopes (bot):
//   channels:read, channels:history, chat:write, app_mentions:read,
//   groups:read, groups:history
// App-level token scope: connections:write (Socket Mode).

import { definePlatform } from "spectrum-ts";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { z } from "zod";

// ---------- inbound message shape after Slack -> internal normalisation ----------

interface InboundSlackMessage {
  id: string;          // slack ts, used as message id
  authorId: string;    // slack user id
  channelId: string;   // slack channel id
  body: string;        // text
  ts: number;          // ms epoch
}

// ---------- the platform client: holds Socket Mode + Web API, queues inbound ----------

class SlackPlatformClient {
  private queue: InboundSlackMessage[] = [];
  private waiters: Array<(m: InboundSlackMessage) => void> = [];
  private stopped = false;

  constructor(
    public readonly sm: SocketModeClient,
    public readonly web: WebClient,
    public readonly botUserId: string,
  ) {
    // DEBUG: catch every Socket Mode envelope so we can see if anything is
    // arriving at all (independent of the message-event filter below).
    // Remove once we're confident events route correctly.
    this.sm.on("slack_event", (args: any) => {
      const env = args?.body ?? args;
      const type = env?.type ?? "?";
      const innerType = env?.event?.type ?? env?.payload?.event?.type ?? "?";
      const subtype = env?.event?.subtype ?? "-";
      console.log(`[slack:debug] envelope type=${type} event=${innerType} subtype=${subtype}`);
    });
    this.sm.on("connecting", () => console.log("[slack:debug] connecting"));
    this.sm.on("authenticated", () => console.log("[slack:debug] authenticated"));
    this.sm.on("connected", () => console.log("[slack:debug] connected"));
    this.sm.on("disconnected", () => console.log("[slack:debug] disconnected"));
    this.sm.on("error", (e: any) => console.error("[slack:debug] error", e));

    // Attach BEFORE start() so we don't miss the first event.
    this.sm.on("message", async (args: any) => {
      try {
        // Always ack quickly so Slack doesn't redeliver.
        if (typeof args?.ack === "function") await args.ack();
      } catch {
        /* swallow ack errors — duplicate delivery is preferable to crash */
      }
      const event = args?.event;
      if (!event) return;
      if (event.subtype) return;                              // edits/joins/etc.
      if (event.bot_id) return;                               // any bot, incl. our own
      if (!event.text || !event.user || !event.channel) return;
      if (event.user === this.botUserId) return;              // safety net

      const inbound: InboundSlackMessage = {
        id: event.ts,
        authorId: event.user,
        channelId: event.channel,
        body: event.text,
        ts: Math.floor(parseFloat(event.ts) * 1000),
      };
      const waiter = this.waiters.shift();
      if (waiter) waiter(inbound);
      else this.queue.push(inbound);
    });
  }

  async *onMessage(): AsyncGenerator<InboundSlackMessage> {
    while (!this.stopped) {
      const next = this.queue.shift();
      if (next) {
        yield next;
      } else {
        yield await new Promise<InboundSlackMessage>((resolve) => {
          this.waiters.push(resolve);
        });
      }
    }
  }

  async sendText(channel: string, text: string): Promise<{ id: string; ts: number }> {
    const r = await this.web.chat.postMessage({ channel, text });
    const ts = String(r.ts ?? Date.now() / 1000);
    return { id: ts, ts: Math.floor(parseFloat(ts) * 1000) };
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    await this.sm.disconnect();
  }
}

// ---------- the Spectrum platform definition ----------

export const slackProvider = definePlatform("slack", {
  config: z.object({
    appToken: z.string().min(1),
    botToken: z.string().min(1),
  }),

  lifecycle: {
    createClient: async ({ config }) => {
      const sm = new SocketModeClient({ appToken: config.appToken });
      const web = new WebClient(config.botToken);
      const auth = await web.auth.test();
      const botUserId = String(auth.user_id ?? "");
      if (!botUserId) {
        throw new Error("slackProvider: auth.test returned no user_id");
      }
      const client = new SlackPlatformClient(sm, web, botUserId);
      await sm.start();
      return client;
    },
    destroyClient: async ({ client }) => {
      await client.disconnect();
    },
  },

  user: {
    resolve: async ({ input }: { input: any }) => ({
      id: String(input?.userID ?? input?.id ?? ""),
    }),
  },
  space: {
    resolve: async ({ input }: { input: any }) => ({
      id: String(input?.channelID ?? input?.id ?? ""),
    }),
  },

  async *messages({ client }) {
    for await (const m of client.onMessage()) {
      yield {
        id: m.id,
        content: { type: "text" as const, text: m.body },
        sender: { id: m.authorId },
        space: { id: m.channelId },
        timestamp: new Date(m.ts),
      };
    }
  },

  send: async ({ space, content, client }) => {
    if (content.type === "text") {
      const r = await client.sendText(space.id, content.text);
      // Spectrum requires a ProviderMessageRecord with at least an id at runtime.
      // We construct a minimal record reflecting the message we just posted.
      return {
        id: r.id,
        content,
        space,
        sender: { id: client.botUserId },
        timestamp: new Date(r.ts),
      } as any;
    }
    // typing / reaction / reply / edit / attachment — no-op for now.
    return undefined;
  },
});
