// OWNER: Adil — channel + backend
// Custom Slack provider for Spectrum via `definePlatform`.
// Stage A–D: NOT USED. Stage E: swap into providers list in src/index.ts.
//
// The exact definePlatform(...) interface is the one thing not pinned — fetch
// https://docs.photon.codes custom-platforms guide and match it.
// Until then this file is a STUB that throws if you try to use it.

import { config } from "../config.js";

// TODO(doc): import { definePlatform } from "spectrum-ts";
// TODO(doc): import { SocketModeClient } from "@slack/socket-mode";
// TODO(doc): import { WebClient } from "@slack/web-api";
// TODO(doc): import { z } from "zod";

/**
 * Shape of what we'll return from definePlatform once wired. Keeping it as
 * an opaque token-type for now so consumers can typecheck against it.
 */
export type SlackPlatform = { __brand: "spectrum-slack-platform" };

/**
 * Stage E: returns a Spectrum platform config to pass into
 *   Spectrum({ providers: [slackProvider()] })
 *
 * Inbound:  SocketModeClient subscribes; on `message` event, emit a Spectrum
 *           text Message with sender.id = slack user id, space.id = channel id.
 * Outbound: when Spectrum sends, call `web.chat.postMessage({ channel, text })`.
 * Capabilities: typing indicator via `assistant.threads.setStatus` or just a
 *               reaction emoji on the source message — pick whichever the
 *               custom-platforms guide blesses.
 *
 * Slack app scopes required: app_mentions:read, channels:history, chat:write,
 * groups:history. Tokens: xapp- (Socket Mode) + xoxb- (bot).
 */
export function slackProvider(): SlackPlatform {
  if (!config.slack.appToken || !config.slack.botToken) {
    throw new Error("SLACK_APP_TOKEN and SLACK_BOT_TOKEN must be set for slackProvider()");
  }

  // TODO(doc): replace this with a real definePlatform({...}) call.
  // const sm  = new SocketModeClient({ appToken: config.slack.appToken });
  // const web = new WebClient(config.slack.botToken);
  //
  // return definePlatform({
  //   name: "slack",
  //   config: z.object({ /* ... */ }),
  //   start: async (emit) => {
  //     sm.on("message", (evt) => {
  //       if (!evt.text || evt.bot_id) return;
  //       emit({
  //         space: { id: evt.channel },
  //         sender: { id: evt.user },
  //         content: { type: "text", text: evt.text },
  //       });
  //     });
  //     await sm.start();
  //   },
  //   send: async (space, payload) => {
  //     await web.chat.postMessage({ channel: space.id, text: payload.text });
  //   },
  //   capabilities: { typing: true },
  // });

  throw new Error("slackProvider is a STUB — see // TODO(doc) and the live Spectrum custom-platforms guide.");
}
