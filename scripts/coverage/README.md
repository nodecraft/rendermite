# Coverage harness

Measures how much of the real modded ecosystem rendermite can draw. Findings and history live
in `docs/research/mod-coverage-campaign.md`; this file is how to run it.

Nothing here ships — `scripts/` is outside `tsconfig.build.json` and the published `files`.
Requires `unzip` on PATH.

## Pipeline

```sh
node scripts/coverage/catalog.ts 1200      # fetch the top 1200 mods by downloads
node scripts/coverage/dependencies.ts      # index what each jar provides and needs
node scripts/coverage/survey.ts            # render everything, bucket the failures
node scripts/coverage/probe.ts <id> …      # unredacted error for specific items
node scripts/coverage/probe.ts --png <id>  # …and a PNG to actually look at
```

State lives in `.work/` (gitignored): jars in `.work/fixtures/modrinth/cov-<slug>.jar`,
`catalog.json` and `dependencies.json` in `.work/coverage/`. Jars are never re-fetched, so
re-running a survey after a renderer change costs no network. Budget ~8 MB per jar.

## Memory

**Do not fan this out to eight processes without watching RSS.** A survey renders whatever a
mod ships, and some models are pathological — one item once took a single process to 20 GB (see
the campaign doc). The renderer now refuses those, but keep the blast radius small:

- Three or four concurrent processes is plenty; each holds ~400–500 MB steady, with spikes to
  ~1 GB on mods with large GeckoLib models.
- `--max-old-space-size` does **not** bound this. Textures are `Float64Array` backing stores,
  which V8 counts as external memory, not old space — a process capped at 1536 MB still reached
  20 GB. Watch RSS from outside (`Get-Process node`) if you fan out.
- `survey.ts` closes each mod's jars via `preparation.close()`. Anything else that prepares many
  trees in one process must do the same; jars are opened `autoClose: false` and hold a
  descriptor plus an entry index each.

`survey.ts` writes no shared state, so slice the catalog across processes for wall-clock:

```sh
node -e "console.log(Object.keys(require('./.work/coverage/catalog.json')).join('\n'))" > /tmp/slugs
split -n l/8 -d /tmp/slugs /tmp/part-
for p in 0 1 2 3 4 5 6 7; do
  node scripts/coverage/survey.ts $(cat /tmp/part-0$p | tr '\n' ' ') > /tmp/out-$p.txt &
done; wait
```

## Two things that make the numbers mean something

**Dependencies are loaded, and only the target is scored.** Surveying an addon alone invents
failures: half of one 1,200-mod sweep's failures were Create addons measured without Create
(`create-encased` alone reports 715 failures out of 721 items; with Create loaded, zero).
`survey.ts` resolves each mod's transitive `depends` from the local index and loads those jars,
but scores only the namespaces the target's own jar declares — a dependency resolves references
without having its items counted against the mod under test.

Version matching is exact: a 1.20.1 addon paired with its dependency's 1.21.1 build resolves
nothing, so `closure()` prefers a provider catalogued at the same game version.

**Failures are bucketed with ids redacted**, so one defect affecting 400 items reads as one line
rather than 400. The bucket text is the renderer's own error message, which is why those
messages must name what failed — see the `Failed to decode texture <locator>` note in the
campaign doc.

## Reading a result

A raw pass rate understates reality whenever the corpus has addons whose dependency is missing
from the catalog, or mods whose jars are simply broken (one publishes Git LFS pointer stubs
instead of PNGs). Before treating a bucket as a rendermite defect:

1. Re-run the mod through `survey.ts` on its own and check the deps actually resolved.
2. `probe.ts` one id for the unredacted message.
3. Check whether the referenced asset exists in *any* jar — most "missing texture" failures are
   cross-mod references or genuine mod bugs.
