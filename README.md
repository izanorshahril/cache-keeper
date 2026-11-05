# cache-keeper

A Claude Code mod that makes an idle session cheap to come back to.
It combines the ideas of [ribbon](https://github.com/robonuggets/ribbon) and [cache-tax](https://github.com/karanb192/cache-tax) (both MIT) with an auto compact of its own.
The code and mascot art are written here; none is copied from either project.

![The band counting down, compacting, then going cold](media/cache-keeper.gif)

| Part | From | What it does |
| --- | --- | --- |
| Band above the prompt | ribbon | 7D and 5H usage left with reset times, then the mascot, cache state, next-message cost and when compaction runs. |
| Cold-send guard | cache-tax | Before a message that would re-write a large cold cache, asks with the estimated cost. "Don't send" puts your text back in the box. |
| `/keepwarm` | cache-tax | Billed pings keep the cache alive for a window you choose. Manual only here. |
| Auto compact | new | Compacts once when the session idles, just before the cache goes cold. |

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

These images use example figures.
[assets/capture.ts](assets/capture.ts) rebuilds them from the real drawings, using Bun and headless Edge; ffmpeg encodes the GIF.

All motion is CSS, so the system's reduced-motion setting stops it.
Text uses Outfit, embedded as a subset under the SIL Open Font License ([assets/OFL.txt](assets/OFL.txt)); [assets/build-font.py](assets/build-font.py) rebuilds `hooks/font.ts`.

## Auto compact

With a 1h cache the mod compacts at 55 minutes idle, and with a 5m cache at 4 minutes.
The compaction reads the still-warm cache, so your next message pays for a small context instead of a cold re-write of a large one.

It runs only when all of these hold:

- No turn is running, no background agent is working, and the prompt box is empty.
- The cache is still warm, since compacting a cold cache would pay the re-write it exists to avoid.
- The context is at or above the floor, 50k tokens by default.
- Keepwarm is not armed, and auto compact is on.
- It has not compacted or tried to since the last real turn.

The last rule is what stops a recompact.
Any compaction, including `/compact` and the engine's own, sets the flag, a failed or vetoed attempt counts as the try, and only a new turn clears it.
The flag is saved per session, so a restart or resume does not compact the same context again.

A compaction is one billed request and replaces detail with a summary, even if you never come back to the session.
Turn it off with the `autoCompact` option or, for one session, `/cache-keeper compact off`.

## Commands

| Command | Effect |
| --- | --- |
| `/cache-keeper` | Shows cache state, usage left and settings. |
| `/cache-keeper compact on\|off` | Sets auto compact for this session. |
| `/keepwarm [6h\|90m\|off]` | Arms pings for a window, 6h by default and 168h at most. Auto compact waits until it ends. |

## Options

| Option | Default | Values |
| --- | --- | --- |
| `autoCompact` | `on` | `on`, `off` |
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
- Keepwarm does not start by itself, unlike cache-tax, because auto compact covers the same idle time.
- A draft left in the prompt box holds compaction back until the cache goes cold.
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
