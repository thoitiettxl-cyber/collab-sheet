# hard-site — realtime collaborative spreadsheet

A spreadsheet web app with a real formula engine and live multi-user sync.
No build step: plain Node ESM on the server, plain JS/CSS in the browser.

## Features

- **Formula engine** (`src/engine/`): tokenizer, parser, evaluator and a
  `Workbook` with a dependency graph, incremental recalculation and cycle
  detection. Numbers, strings, booleans, `+ - * / ^`, parentheses, A1 refs,
  A1:B3 ranges, `SUM / AVG / AVERAGE / MIN / MAX / COUNT / IF`, comparison
  operators (`= < > <= >= <>`). Errors: `#REF! #DIV/0! #NAME? #VALUE! #CYCLE!`.
- **Realtime collaboration**: the server is authoritative. Edits arrive over
  WebSocket, are versioned, and broadcast as cell-level diffs (changed cells
  plus recomputed dependents) to every client on the same document.
- **Presence**: see who else is on the doc — name, color and their current
  cell selection, shown as an outline + name tag in the grid.
- **Per-user undo/redo** handled server-side, broadcast like normal edits so
  everyone stays in sync.
- **Persistence**: each doc is saved as JSON under `data/` (debounced) and
  reloaded on server start.
- **Grid UI**: A–Z × 50 grid, formula bar (`fx`), click/double-click/arrow/
  Enter navigation, type-to-edit, Delete clears, sticky row/column headers,
  error values shown in red, connection indicator with auto-reconnect.

## Architecture

```
public/            static client (index.html, app.js, styles.css) — no build
src/engine/        formula engine: tokenizer.js, parser.js, evaluator.js,
                   workbook.js (dependency graph + incremental recalc)
src/server/
  server.js        node:http static file server + ws WebSocket endpoint
                   (/ws); per-document client registry, presence, heartbeats
  store.js         DocManager: one Workbook per doc id, per-op server
                   versioning, per-user undo/redo as inverse ops, diff of
                   changed cells, debounced JSON persistence
tests/
  engine.test.js   40 engine unit tests
  store.test.js    DocManager unit tests (versioning, undo/redo, persistence)
  realtime.test.js integration tests (real server + two ws clients)
```

Docs are addressed by `?doc=<id>` in the URL (sanitized to
`[A-Za-z0-9_-]`, anything else falls back to `default`).

## Protocol (WebSocket `/ws?doc=<id>&name=<name>`)

Server → client:

| message | fields | meaning |
|---|---|---|
| `init` | `you{id,name,color}`, `doc`, `version`, `cells{ref:{raw,value,error}}`, `users[]` | full snapshot on connect / resync |
| `update` | `op` (`set`/`undo`/`redo`), `ref`, `by` (user id), `version`, `changes{ref:{raw,value,error}}` | applied op; `changes` includes recomputed dependents; cleared cells have `raw:null` |
| `presence` | `users[{id,name,color,sel}]` | online users and their selections |
| `you` | `you{id,name,color}` | your identity after rename |
| `noop` | `op` | undo/redo with nothing to do |
| `error` | `message` | invalid cell ref, etc. |

Client → server:

| message | fields | meaning |
|---|---|---|
| `set` | `ref`, `raw` (string|null) | set a cell (`=...` for formulas, null/empty clears) |
| `undo` / `redo` | — | undo/redo your own last op |
| `select` | `ref` | broadcast your selection |
| `rename` | `name` | change display name (max 20 chars) |
| `sync` | — | request a fresh `init` (client sends this if it detects a version gap) |

## Run

```bash
npm install
npm start            # PORT env, default 3000 → http://localhost:3000
```

Open `http://localhost:3000/?doc=budget` — share the URL (with `?doc=`) and
`?name=` is optional; your name is remembered in localStorage.

## Test

```bash
npm test   # node --test: engine unit tests, store unit tests,
           # and realtime integration tests that boot a real server
           # on a random port and drive two ws clients through
           # edit sync, formula recompute, #CYCLE!, undo/redo
           # broadcast, and persistence across a server restart
```

Requires Node >= 20. The only dependency is `ws`.
