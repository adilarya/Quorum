// One-off Slack credential verifier. Reads .env, hits Slack APIs, prints
// pass/fail per check. Does NOT echo token values. Re-run any time:
//   node scripts/verify-slack.mjs
import "dotenv/config";
import { WebClient } from "@slack/web-api";
import { SocketModeClient } from "@slack/socket-mode";

const need = (k) => {
  const v = process.env[k];
  if (!v || v.startsWith("xapp-...") || v.startsWith("xoxb-...")) {
    console.error(`FAIL  ${k} not set in .env`);
    process.exit(1);
  }
  return v;
};

const appToken = need("SLACK_APP_TOKEN");
const botToken = need("SLACK_BOT_TOKEN");
const channelId = process.env.SLACK_CHANNEL_ID; // optional

const expect = (label, cond, detail) =>
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);

let bad = 0;
const fail = (label, msg) => { bad++; console.log(`FAIL  ${label}  — ${msg}`); };

// Token format
expect("xapp- token shape", /^xapp-1-[A-Z0-9]+-\d+-[a-f0-9]+$/.test(appToken));
expect("xoxb- token shape", /^xoxb-[\d-]+-[A-Za-z0-9]+$/.test(botToken));
if (channelId) expect("channel id shape", /^[CG][A-Z0-9]{8,}$/.test(channelId));

const web = new WebClient(botToken);

// 1. auth.test — bot token valid?
try {
  const r = await web.auth.test();
  console.log(`PASS  auth.test  — team="${r.team}" bot_user_id=${r.user_id}`);
  globalThis.__botUserId = r.user_id;
} catch (e) {
  fail("auth.test", e.data?.error ?? e.message);
}

// 2. apps.connections.open — xapp- token accepted by Socket Mode endpoint?
try {
  const r = await fetch("https://slack.com/api/apps.connections.open", {
    method: "POST",
    headers: { Authorization: `Bearer ${appToken}` },
  }).then((x) => x.json());
  if (r.ok) console.log("PASS  apps.connections.open  — Socket Mode token accepted");
  else fail("apps.connections.open", r.error);
} catch (e) {
  fail("apps.connections.open", e.message);
}

// 3. conversations.info + members — channel reachable, bot is in it?
if (channelId) {
  try {
    const info = await web.conversations.info({ channel: channelId });
    console.log(`PASS  conversations.info  — #${info.channel.name} (private=${info.channel.is_private})`);
  } catch (e) {
    fail("conversations.info", e.data?.error ?? e.message);
  }
  try {
    const m = await web.conversations.members({ channel: channelId, limit: 200 });
    const inChannel = m.members?.includes(globalThis.__botUserId);
    if (inChannel) console.log("PASS  bot is a member of the channel");
    else fail("bot membership", `bot user not in channel — run '/invite @<botname>' in #${channelId}`);
  } catch (e) {
    fail("conversations.members", e.data?.error ?? e.message);
  }
}

// 4. Socket Mode handshake — actually open the websocket, then disconnect.
console.log("…  attempting Socket Mode connect (10s timeout)");
const sm = new SocketModeClient({ appToken, logLevel: "error" });
const connected = await new Promise((resolve) => {
  const t = setTimeout(() => resolve(false), 10000);
  sm.on("connected", () => { clearTimeout(t); resolve(true); });
  sm.start().catch(() => resolve(false));
});
if (connected) {
  console.log("PASS  Socket Mode connected");
  await sm.disconnect();
} else {
  fail("Socket Mode connect", "did not connect within 10s — check Socket Mode is ON and connections:write scope is on the app-level token");
}

process.exit(bad > 0 ? 1 : 0);
