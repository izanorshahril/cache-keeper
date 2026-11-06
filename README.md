# cache-keeper

A Claude Code mod that makes an idle session cheap to come back to.
It combines the ideas of [ribbon](https://github.com/robonuggets/ribbon) and [cache-tax](https://github.com/karanb192/cache-tax) (both MIT) with an idle compaction status and an optional idle compact fallback of its own.
The code and mascot art are written here; none is copied from either project.

![The band counting down, compacting, then going cold](media/cache-keeper.gif)

| Part | From | What it does |
| --- | --- | --- |
| Band above the prompt | ribbon | 7D and 5H usage left with reset times, then the mascot, cache state, next-message cost, idle compaction status and keep awake status. |
| Cold-send guard | cache-tax | On any model, before a message that would re-write a large cold cache, asks in the band with the estimated cost: continue, a lower model, compact first, or cancel, colored by cost. |
| `/keepwarm` | cache-tax | Billed pings keep the cache alive for a window you choose. Manual only here. |
| Idle compact fallback | new | Compacts once when the session idles, just before the cache goes cold, where Claude Code's own idle compaction does not run. Off by default. |
| Keep awake | new | Off by default. Holds the machine out of idle sleep while an idle compaction still waits on a warm cache, then lets it sleep. `/cache-keeper awake on` turns it on. |

## Install

At the prompt of a terminal session:

```text
/plugin install cache-keeper --marketplace izanorshahril/cache-keeper
```

From a shell:

```bash
claude plugin install cache-keeper --marketplace izanorshahril/cache-keeper
```

In the desktop app, click + next to the prompt box, then Plugins, Add marketplace with `izanorshahril/cache-keeper`, then Add plugin.

## The band

The desktop app, VS Code and mobile draw it from SVG in [hooks/art.ts](hooks/art.ts); the terminal draws the same figures as coloured text.

| Usage left | Colour |
| --- | --- |
| Above 50% | Blue |
| 26-50% | Amber |
| 15-25% | Orange |
| Below 15% | Red, pulsing, with LOW |

| Cache | Chip | Mascot |
| --- | --- | --- |
| Warm | Green | Bobs and blinks with rising embers; hover to make it hop and wave (desktop and mobile) |
| Cold | Pale blue | Frozen in an ice block with falling snow; hover to make it shiver (desktop and mobile) |
| Compacted | Lilac | Naps with drifting Zs |

![Warm](media/band-warm.png)
![Cold](media/band-cold.png)
![Compacted](media/band-compacted.png)
![Low usage](media/band-low-usage.png)

These images use example figures: a 240k context on Opus 5.5, with Claude Code's idle compaction on.
[assets/capture.ts](assets/capture.ts) rebuilds them from the real drawings, using Bun and headless Edge; ffmpeg encodes the GIF.

All motion is CSS, so the system's reduced-motion setting stops it.
Text uses Outfit, embedded as a subset under the SIL Open Font License ([assets/OFL.txt](assets/OFL.txt)); [assets/build-font.py](assets/build-font.py) rebuilds `hooks/font.ts`.

## Models and cost

Each model keeps its own prompt cache, so the band tracks each one separately within a session.
It prices the next message on the model selected now: a cache read where that model's cache is warm, a write of the whole context where it is cold.
Switch with `/model` and the band shows the new model's state and price before you send, so switching from a warm Haiku to an Opus that last replied hours ago shows Opus cold.
A model name the price table does not list, such as `default`, is priced as the last model selected.
After a restart or resume, the time since the last reply is put on the model that made it, not the model the session reopens on.

`/cache-keeper` lists the next message's price on Fable, Opus, Sonnet and Haiku, each marked read or write.

## Cold-send guard

On any model, Haiku included, a message that would re-write a large cold cache is held back and put back in the prompt box.
The band then asks how to send it, with the estimated cost on each road.
What it offers depends on the model of the last reply and the model about to send:

| Last reply | Sending on | Choices |
| --- | --- | --- |
| Fable, Opus or Sonnet | Fable, Opus or Sonnet | Continue on this model, continue on a lower model, compact first, cancel |
| Fable, Opus or Sonnet | Haiku | Continue, compact on Haiku first, cancel |
| Haiku | Fable, Opus or Sonnet | Continue, compact on Haiku first, cancel |
| Haiku | Haiku | Continue, cancel |

Continuing on a lower model picks any model below the selected one, then an effort from `low` to `max`.
Compacting first from a large model to a large one picks any model and effort for the compaction.
After the compaction the model and effort are set back, and the message goes out on the model it was typed for.

The choices are colored by what they cost: continuing as is re-writes the whole cache at full price and is red, a lower model or a compaction costs less and is yellow, and cancel is plain.
The message is sent as it reads in the box at the time of the pick, so an edit made meanwhile is what goes; cancel leaves it there.

The band dialog is for messages typed at the composer.
A message from Remote Control or an SDK host asks the same questions in Claude Code's question box, which reaches every surface but draws no colors and takes four options, so `max` effort is typed under Other.
Sending the same text again while the band asks also opens the question box, in case the band is out of view.
A message with attachments is offered only continue or cancel, since attachments do not survive a re-send.

## Idle compaction

Claude Code has its own idle compaction.
It compacts a long idle session before the prompt cache expires, or writes the summary while you are away and swaps it in when you come back.
It is a staged rollout: no setting turns it on, and Claude Code turns it on for an account by itself.
Where it is on, `/config` lists an `Idle compaction` row, and `"idleCompaction": false` in `settings.json` turns it off.
In Claude Code 2.1.317 it acts at 90% of a 1h cache's life (54 minutes idle), on a context of 200k tokens or more, and only while auto-compact is on.

"Idle compact" in the band means either one: Claude Code's own where the account has it, cache-keeper's fallback otherwise.
It is not Claude Code's auto-compact, which compacts when the context window fills.
The band shows its state with an icon whose shape and colour both say it, so it reads without relying on colour:

| Icon | Band | Means |
| --- | --- | --- |
| Amber clock | `idle compact in 44m` | An idle compaction, Claude Code's or the fallback's, will run this idle period, in 44 minutes. |
| Green tick | `idle compact on` | It is on, but not for this idle period: the context is under its floor, the cache is cold, or no reply has finished in this process. |
| Grey struck-out ring | `idle compact off` | Neither Claude Code's idle compaction nor the fallback runs. |

The terminal draws the same states as `◷`, `●` and `○`.
Neither file is changed by the mod.

The rollout flag is read from `~/.claude.json` and the setting from `~/.claude/settings.json`.
The timer is the mod's reading of how Claude Code 2.1.317 times it, not a figure Claude Code reports.

## Idle compact fallback

For an account or session without Claude Code's idle compaction, or for a different idle time, turn the fallback on:

```sh
printf '%s\n' '{"autoCompact":"on"}' | claude plugin configure cache-keeper@cache-keeper --values-stdin
```

With a 1h cache it compacts at 55 minutes idle, and with a 5m cache at 4 minutes.
Set `compactAfter` to `45m`, `30m`, `15m` or `5m` for an earlier one; a duration past the cache TTL is held to a minute before cold.
While the fallback is on, the band shows its timer rather than Claude Code's.
The compaction reads the still-warm cache, so your next message pays for a small context instead of a cold re-write of a large one.

It runs only when all of these hold:

- No turn is running, no background agent is working, and the prompt box is empty.
- The cache is still warm, since compacting a cold cache would pay the re-write it exists to avoid.
- The context is at or above the floor, 50k tokens by default.
- Keepwarm is not armed, and a reply has finished in this process, so a resumed session is never compacted unasked.
- It has not compacted or tried to since the last real turn.

The last rule is what stops a recompact.
Any compaction, including `/compact` and Claude Code's own, sets the flag, a failed or vetoed attempt counts as the try, and only a new turn clears it.

A compaction is one billed request and replaces detail with a summary, even if you never come back to the session.
`/cache-keeper compact off` turns the fallback off for one session.
In an interactive session the mod compacts with a direct call; a desktop or SDK session refuses that call, so the mod runs `/compact` as if typed.

## Keep awake

`/cache-keeper awake on` or `off` sets it for every session, over the `keepAwake` option; the band's status line ends with `keep awake on` beside a green tick, or `keep awake off` beside a grey struck-out ring, the same icons as idle compaction.

Keep awake exists because idle timers stop while the machine sleeps.
Claude Code's own keep-awake holds only while a session works and lets go shortly after, so an idle session can sleep through its compaction time and wake to a cold cache.
With keep awake on, the mod holds a request against idle sleep from the end of each turn until the compaction runs, the cache goes cold, or keepwarm ends, and only while an idle compaction or keepwarm is due.
On Windows the hold is a hidden `pwsh` (or Windows PowerShell) process that calls `SetThreadExecutionState`; on macOS it is `caffeinate -i`, and on Linux `systemd-inhibit`.
Ending the hold ends that process. A closed lid, the power button or a manual sleep still sleeps.

## Commands

| Command | Effect |
| --- | --- |
| `/cache-keeper` | Shows cache state, usage left and settings. |
| `/cache-keeper compact on\|off` | Sets the idle compact fallback for this session. |
| `/cache-keeper awake on\|off` | Sets keep awake, for every session. |
| `/cache-keeper motion on\|off` | Sets the band's animation, for every session; off freezes every drawing on its first frame. |
| `/keepwarm [6h\|90m\|off]` | Arms pings for a window, 6h by default and 168h at most. Idle compaction waits until it ends. |

## Options

| Option | Default | Values |
| --- | --- | --- |
| `autoCompact` | `off` | `off`, `on` |
| `keepAwake` | `off` | `off`, `on` |
| `compactAfter` | `auto` | `auto`, `55m`, `45m`, `30m`, `15m`, `5m` |
| `guard` | `ask` | `ask`, `warn`, `off` |
| `cacheTtl` | `1h` | `1h`, `5m` |
| `minTokens` | `50000` | `20000`, `50000`, `100000`, `200000` |

Set them in the config menu or under `pluginConfigs` in settings.

## Limits

- The cache state is a local clock from the last request, not a server check, and the mod cannot read the TTL.
  Included subscription usage defaults to 1h.
  Set `cacheTtl` to `5m` on an API-key session, or the mod will compact and warn too late.
- Dollar figures are API list-price estimates for the context alone, not subscription charges.
  Rates live in [hooks/logic.ts](hooks/logic.ts), checked 2026-11-05 against the `claude-api` skill of Claude Code 2.1.317.
- Keepwarm does not start by itself, unlike cache-tax, because idle compaction covers the same idle time.
- A draft left in the prompt box holds compaction back until the cache goes cold.
- Idle timers do not run while Windows is in Modern Standby, since it suspends idle desktop apps, and Remote Control does not keep the machine awake; turn on keep awake for that.
  An idle period that sleeps through the compaction time gets no compaction: on waking past the cache life the cache is cold, and compacting then would pay the full re-write.
- Only the main conversation is compacted; a subagent's transcript never is.
- Effort is set with `/effort`; where that fails the message goes on at the effort in force, and the log says so.
- Claude Code's idle compaction is read from its rollout flag and settings as Claude Code 2.1.317 reads them; a later version may change either.
- The hook API is early access and can change between Claude Code releases.

## Run and test

From the mod's folder:

```bash
claude --plugin-dir .
```

```bash
claude plugin validate .
```

```bash
claude plugin test .
```
