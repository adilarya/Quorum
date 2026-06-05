# Quorum

Slack agent that catches contradicting team decisions and reconciles them live in the channel. Built on Photon Spectrum (messaging), RocketRide (extract/classify pipeline), XTrace (self-revising memory), Butterbase (auth + decisions log + AI Model Gateway).

## Ownership

| Owner | Files | Done when |
|---|---|---|
| **Adil** — channel + backend | `src/index.ts`, `src/channel/`, `src/backend/` | A real Slack message round-trips, posts a reply via the Butterbase gateway, and lands a row in the `decisions` table. |
| **Doniv** — the brain | `src/brain/`, `pipelines/` | `processMessage` works end-to-end on real XTrace + a real RocketRide pipeline. |
| **Shared, frozen** | `src/config.ts`, `.env.example` | — |

**The seam is `processMessage(channelId, userId, text): Promise<{ reply: string | null }>`.** Adil imports it; never edits `src/brain/`. Doniv owns the brain; never edits `src/index.ts`, `src/channel/`, or `src/backend/`. If a change wants to cross the line, fix the type — not the other half.

## Current state (2026-06-05)

- **Channel (Slack via Spectrum `definePlatform`): LIVE.** Round-trips work in `#all-quorumdemo`.
- **Backend (Butterbase gateway + decisions log): LIVE.** Replies are real LLM output; every decision lands a row.
- **Brain (RocketRide + XTrace): MOCKED.** Keyword heuristic + in-memory store. Doniv to wire real.

## Run

```bash
cp .env.example .env       # fill in the keys you need
npm install
npm run dev
```

The set of env vars you need depends on which stage you're running:

| You want | Set in `.env` |
|---|---|
| Terminal sanity check, fully mocked | `PROVIDER=terminal` (nothing else required) |
| Real Slack, mocked brain, real Butterbase | `PROVIDER=slack`, all `SLACK_*`, all `BUTTERBASE_*`, leave `USE_MOCKS=true` |
| Real everything | above + `USE_MOCKS=false` + `XTRACE_*` + RocketRide engine on `:5565` + a real `pipelines/extract_decision.pipe` |
| Kill-switch (iMessage) | `PROVIDER=imessage`, `SPECTRUM_PROJECT_ID/SECRET` |

`USE_MOCKS` gates **the brain only** (RocketRide + XTrace). The Butterbase backend goes real automatically when its env vars are present.

## Smoke test

Send these two lines in `#all-quorumdemo`:

```
beta ships June 20
beta ships July 5
```

You should see:
1. A confirmation reply (LLM-phrased) after the first.
2. A conflict-bust reply after the second, naming both users and asking which holds.

Then check the `decisions` table in the Butterbase dashboard — there should be one new row per decision.

## Required Slack setup (already done)

- App on api.slack.com with Socket Mode ON and Event Subscriptions for `message.channels`, `message.groups`, `app_mention` (set via app manifest — the per-section UI gets wedged).
- Bot scopes: `channels:read`, `channels:history`, `chat:write`, `app_mentions:read`, `groups:read`, `groups:history`.
- App-level token scope: `connections:write`.
- Bot invited to the target channel.

`scripts/verify-slack.mjs` re-checks all of this whenever a token rotates.

## Required Butterbase setup (already done)

- App created (`BUTTERBASE_APP_ID`).
- Service key with `ai:gateway` + table-write scopes (`BUTTERBASE_API_KEY`).
- `decisions` table with: `id` (uuid pk), `channel_id`, `user_id`, `topic`, `value` (text), `created_at` (timestamptz), `superseded` (bool), `previous_user_id` (text nullable).
- Promo code `HAVEFUN0605` redeemed.

## Kill-switch — 1:15pm

If Slack stops working, set `PROVIDER=imessage` in `.env` and restart. **Brain unchanged.** Same `processMessage`, same Butterbase gateway, same decisions log. That's the entire point of the contract.

## Submit

Submission runs via the Butterbase MCP tool **`prep_and_submit_hackathon_entry`** (two-step: `action: "prep"`, then `action: "submit"` with `app_id` for the 50-point feature score). Test the flow at least an hour before the deadline; the MCP requires a Claude Code restart to register.

## SDK references

- Spectrum — https://docs.photon.codes  ·  https://photon.codes/docs/spectrum-ts/custom-platforms
- XTrace — https://docs.xtrace.ai/guides/typescript-sdk
- RocketRide — https://docs.rocketride.org  ·  engine on `:5565`, build `.pipe` in the VS Code canvas.
- Butterbase — https://docs.butterbase.ai  ·  https://dashboard.butterbase.ai
