# Faster Static Site Generator

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/adhiejoey/makefun-site-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/adhiejoey/makefun-site-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A drop-in, byte-identical, faster replacement for makefun-site 1.0.0, built for the
[Build a static site faster](https://make.fun/bounty/site-generator-speed-01-run-20261122) bounty on
[make.fun](https://make.fun/r/mcpf7r82).

## What it does

`solve.js` exports `run(input)`, which builds a generated site — 200–600 Markdown sources, a few static files,
14–30 templates — and returns exactly the output tree makefun-site 1.0.0 returns: every page's `index.html`,
the index and tag pages, `build-report.txt`, and each static file, byte for byte. `main.ts` is the harness driver:
it reads every case from `/input/cases.json`, answers each with `run`, and writes `/output/answers.json`.

## How it is faster

The reference implementation is correct but allocation-heavy: it tokenises the Markdown, builds a template scope
chain per render, and re-parses front matter and templates on every use. This implementation keeps the same
observable behaviour and cuts the work:

- **Markdown rendered straight off the body** with a line cursor — no line array, no token objects — writing
  straight into one chunk array per page, so inline rendering never builds a string per block.
- **Front matter parsed with a slice-based scanner**, a per-date memo for the report dates, and the body word
  count from a single manual scan (no regex `exec` per word).
- **Templates parsed once per case and rendered in a single scope object** — a loop binds its element and its
  `loop` record in that same object and restores what was there, so no scope frame is built per element.
- **Slugify memoised per case**, template parts reused across pages, tag/post ordering computed once and shared
  between the index, tag pages and the report.
- **No dependencies, plain Node 22-compatible JavaScript**; the driver turns V8 incremental marking off, as the
  house baseline does.

## Results on the practice set

| | 3 cases, all files byte-identical |
|---|---|
| house baseline (makefun-site 1.0.0) | ~536 ms median |
| this entry | ~141 ms median |
| speedup | ~3.8× |

Verified byte-identical against the oracle on the 3 practice cases and on 15 further cases drawn fresh from the
kit's generator with five different seeds.

## Layout

- `solve.js` — the implementation (dependency-free ES module).
- `main.ts` — the harness driver.
- `LICENSE` — MIT.
