# cache-seer

A Claude Code mod that makes an idle session cheap to come back to.
It combines the ideas of [ribbon](https://github.com/robonuggets/ribbon) and [cache-tax](https://github.com/karanb192/cache-tax) (both MIT) with an idle compaction of its own that runs before the cache goes cold.
The code and mascot art are written here; none is copied from either project.

![The band counting down, compacting, then going cold](media/cache-seer.gif)

| Part | From | What it does |
| --- | --- | --- |
| Band above the prompt | ribbon | 7D and 5H usage left with reset times, then the mascot, cache state, next-message cost, idle compaction status and keep awake status. |
| Cold-send guard | cache-tax | On any model, before a message that would re-write a large cold cache, asks once in the question box with the cost: send, a cheaper model, summarize first, or cancel. |
| `/keepwarm` | cache-tax | Billed pings keep the cache alive for a window you choose. Manual only here. |
| Idle compaction | new | On by default. Compacts once when the session idles, while the cache is still warm, so the next message is small on any model. |
| Keep awake | new | Off by default. Holds the machine out of idle sleep while an idle compaction still waits on a warm cache, then lets it sleep. `/cache-seer awake on` turns it on. |

## Install

At the prompt of a terminal session:

```text
/plugin install cache-seer --marketplace izanorshahril/cache-seer
```

From a shell:

```bash
claude plugin install cache-seer --marketplace izanorshahril/cache-seer
```

In the desktop app, click + next to the prompt box, then Plugins, Add marketplace with `izanorshahril/cache-seer`, then Add plugin.

### From cache-keeper

cache-seer was called cache-keeper; the repository's old address forwards here.
Install cache-seer as above, then remove the old one so the band and guard do not run twice:

```text
/plugin uninstall cache-keeper
```

At its first start, cache-seer copies what cache-keeper saved: each session's cache times, the last usage reading, and keep awake and motion as `/cache-keeper` set them.
It uses cache-keeper's options until cache-seer has options of its own.
Until the old one is removed, the transcript says it is still on.

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

`/cache-seer` lists the next message's price on Fable, Opus, Sonnet and Haiku, each marked read or write.

## Cold-send guard

On any model, Haiku included, pressing Enter on a message that would re-write a large cold cache asks once, in Claude Code's question box.
It says how long the cache has been cold and what sending costs, then offers the roads:

| Last reply | Sending on | Options |
| --- | --- | --- |
| Fable, Opus or Sonnet | Fable, Opus or Sonnet | Send on this model, use a cheaper model, summarize first, cancel |
| Fable, Opus or Sonnet | Haiku | Send on Haiku, summarize on Haiku first, cancel |
| Haiku | Fable, Opus or Sonnet | Send on this model, summarize on Haiku first, cancel |
| Haiku | Haiku | Send on Haiku, cancel |

A cheaper model asks which model, with each cost beside it, then which effort from `low` to `xhigh`; `max` is typed under Other.
Summarizing first asks the same two questions, and the summary is written on the model picked; the message then goes out on the model it was typed for.

Each decision leaves one card in the transcript: "Not sent. Your message is back in the box.", "Switching to Haiku, then sending your message.", or "Summarizing with Haiku, then sending your message on Opus."
The engine draws that card in its own red warning colour, so the mod cannot colour it.
The text sent is what the box holds when the pick is made, so an edit made meanwhile is what goes.
A message with attachments gets only send or cancel, since attachments do not survive a re-send.
The `guard` option sets this: `ask` (the default) asks, `warn` only logs the estimate, and `off` sends without asking.

## Idle compaction

cache-seer compacts an idle session once, while its prompt cache is still warm.
The compaction reads the warm cache, so it costs little, and the next message pays for a small context instead of a cold re-write of a large one.
That holds whichever model you come back on: a compacted session can carry on on Opus even after its cache has gone cold.

With a 1h cache it compacts at 55 minutes idle, and with a 5m cache at 4 minutes.
Set `compactAfter` to `45m`, `30m`, `15m` or `5m` for an earlier one; a duration past the cache TTL is held to a minute before cold.

It runs only when all of these hold:

- No turn is running, no background agent is working, and the prompt box is empty.
- The cache is still warm, since compacting a cold cache would pay the re-write it exists to avoid.
- The context is at or above the floor, 50k tokens by default.
- Keepwarm is not armed, and a reply has finished in this process, so a resumed session is never compacted unasked.
- It has not compacted or tried to since the last real turn.

The last rule is what stops a recompact.
Any compaction, including `/compact` and Claude Code's own, sets the flag, a failed or vetoed attempt counts as the try, and only a new turn clears it.
A compaction the engine skips is tried again two minutes later, while the cache is still warm.

A compaction is one billed request and replaces detail with a summary, even if you never come back to the session.
`/cache-seer compact off` keeps the full context for one session; `"autoCompact": "off"` turns it off everywhere.
In an interactive session the mod compacts with a direct call; a desktop or SDK session refuses that call, so the mod runs `/compact` as if typed.

### Claude Code's own idle compaction

Claude Code has an idle compaction of its own, as a staged rollout that a server flag turns on per account.
Where it is on, `/config` lists an `Idle compaction` row, and `"idleCompaction": false` in `settings.json` turns it off.
In Claude Code 2.1.306 and 2.1.317 the flag picks one of two modes, and no setting or environment variable picks the mode:

- `compact` compacts the session at 90% of a 1h cache's life, 54 minutes idle.
- `compact_on_return` writes a summary at 54 minutes idle and swaps it in on your first message back, on whichever model that message goes.

It leaves these gaps, which cache-seer closes:

| | Claude Code's idle compaction | cache-seer |
| --- | --- | --- |
| Who turns it on | The server flag, per account | You, with `autoCompact`; on by default |
| When the context shrinks | At 54 minutes, or on your return in `compact_on_return` | Before the cache goes cold, at 55 minutes |
| Smallest context it acts on | 200k tokens, 100k at least with `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` | 50k by default, 20k at least with `minTokens` |
| Cache TTL | 1h only | 1h or 5m |
| When it skips | Its timer fired over a minute late, a newer request came in, the conversation changed, or rate limits are near | A turn, an agent or a draft is in the way; tried again after 2 minutes |
| Whether it ran | Recorded only in Claude Code's analytics | A line in the transcript, and the band |
| A machine asleep through it | No compaction | No compaction, unless keep awake holds the machine up |

With both on, cache-seer moves its `auto` timing two minutes ahead of Claude Code's, to 52 minutes, so it compacts first.
Claude Code's own run should then find a small context under its floor and do nothing; that is the mod's reading of Claude Code's code, not something Claude Code reports.
To be sure only one summary is written, turn Claude Code's off with `"idleCompaction": false` in `~/.claude/settings.json`.

### The band

"Idle compact" in the band means cache-seer's where it is on, Claude Code's otherwise.
It is not Claude Code's auto-compact, which compacts when the context window fills.
The band shows its state with an icon whose shape and colour both say it, so it reads without relying on colour:

| Icon | Band | Means |
| --- | --- | --- |
| Amber clock | `idle compact in 44m` | An idle compaction will run this idle period, in 44 minutes. |
| Green tick | `idle compact on` | It is on, but not for this idle period: the context is under its floor, the cache is cold, or no reply has finished in this process. |
| Grey struck-out ring | `idle compact off` | Neither cache-seer's idle compaction nor Claude Code's runs. |

The terminal draws the same states as `◷`, `●` and `○`.
Claude Code's rollout flag is read from `~/.claude.json` and its setting from `~/.claude/settings.json`; neither file is changed by the mod.
Its timer is the mod's reading of how Claude Code times it, not a figure Claude Code reports.

## Keep awake

`/cache-seer awake on` or `off` sets it for every session, over the `keepAwake` option; the band's status line ends with `keep awake on` beside a green tick, or `keep awake off` beside a grey struck-out ring, the same icons as idle compaction.

Keep awake exists because idle timers stop while the machine sleeps.
Claude Code's own keep-awake holds only while a session works and lets go shortly after, so an idle session can sleep through its compaction time and wake to a cold cache.
With keep awake on, the mod holds a request against idle sleep from the end of each turn until the compaction runs, the cache goes cold, or keepwarm ends, and only while an idle compaction or keepwarm is due.
On Windows the hold is a hidden `pwsh` (or Windows PowerShell) process that calls `SetThreadExecutionState`; on macOS it is `caffeinate -i`, and on Linux `systemd-inhibit`.
Ending the hold ends that process. A closed lid, the power button or a manual sleep still sleeps.

## Commands

| Command | Effect |
| --- | --- |
| `/cache-seer` | Shows cache state, usage left and settings. |
| `/cache-seer compact on\|off` | Sets idle compaction for this session. |
| `/cache-seer awake on\|off` | Sets keep awake, for every session. |
| `/cache-seer motion on\|off` | Sets the band's animation, for every session; off freezes every drawing on its first frame. |
| `/keepwarm [6h\|90m\|off]` | Arms pings for a window, 6h by default and 168h at most. Idle compaction waits until it ends. |

## Options

| Option | Default | Values |
| --- | --- | --- |
| `autoCompact` | `on` | `off`, `on` |
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
