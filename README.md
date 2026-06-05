# Quorum

Slack agent that catches contradicting team decisions and reconciles them live in the channel. Built on Photon Spectrum (messaging), RocketRide (extract/classify pipeline), XTrace (self-revising memory), Butterbase (auth + decisions log + AI Model Gateway).

## Ownership

| Owner | Files | Done when |
|---|---|---|
| **Adil** — channel + backend | `src/index.ts`, `src/channel/`, `src/backend/` | A real Slack message in `#general` round-trips through a mocked brain. |
| **Doniv** — the brain | `src/brain/`, `pipelines/` | `processMessage` works against the terminal provider end-to-end on real XTrace. |
| **Shared, frozen after Stage A** | `src/config.ts`, `.env.example` | — |

**The seam is `processMessage(channelId, userId, text): Promise<{ reply: string | null }>`.** Adil imports it; never edits `src/brain/`. Doniv owns the brain; never edits `src/index.ts`, `src/channel/`, or `src/backend/`. If a change wants to cross the line, fix the type — not the other half.

## Stages

Each stage must run before the next:

- **A — Terminal + fully-mocked brain.** Type a line, see the loop work.
- **B — Real XTrace** (ingest / recall / groups / supersede) behind the mocks.
- **C — Real RocketRide pipeline** for extract/classify.
- **D — Butterbase** auth + decisions log + AI Model Gateway.
- **E — Slack** via the custom `definePlatform` provider (Socket Mode).

`USE_MOCKS=true` in `.env` keeps the brain on mocks even when other stages are wired.

## Run (Stage A)

```bash
cp .env.example .env          # nothing real required at Stage A
npm install
npm run dev
```

Stage-A smoke test (paste into the terminal one line at a time):

```
beta ships June 20
beta ships July 5
```

You should see:

1. First line → `Recorded: beta ship date = "June 20" ...`
2. Second line → `Conflict on beta ship date: <@...> set "June 20", <@...> just said "July 5". Which holds?`

If the second message doesn't surface a conflict, the mock pipeline or in-memory store isn't routing — start in `src/brain/processMessage.ts`.

## Kill-switch — 1:15pm

If the Slack provider isn't round-tripping by **1:15pm**, set `PROVIDER=imessage` in `.env` (needs Spectrum project creds) and restart. **The brain is unchanged.** Same `processMessage`, same memory, same gateway. That's the entire point of the contract.

## SDK references (live, read these before un-stubbing)

- Spectrum — https://docs.photon.codes  ·  skill: https://skills.sh/photon-hq  ·  custom-platforms guide is what you need for `slackProvider`.
- XTrace — https://docs.xtrace.ai/guides/typescript-sdk  ·  surface in this repo is verified.
- RocketRide — https://docs.rocketride.org  ·  https://www.npmjs.com/package/rocketride  ·  engine on `:5565`, build the `.pipe` in the IDE canvas.
- Butterbase — https://docs.butterbase.ai  ·  https://www.npmjs.com/package/@butterbase/sdk  ·  redeem promo `HAVEFUN0605` in billing; submission is a Butterbase agent command.

## Stubs

Every place that calls an unverified SDK shape is marked `// TODO(doc):` with the doc URL. When you wire it, delete the stub and the comment together — don't leave hybrid code.

## Submit

Submit early (~2:45pm) via the Butterbase agent command. Demos die in the last 5 minutes.
