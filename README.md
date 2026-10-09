# react-native-flux-desktop-packer

[**English**](./README.md) | [简体中文](./README.zh-CN.md)

<p align="center">
  <a href="https://www.npmjs.com/package/react-native-flux-desktop-packer"><img src="https://img.shields.io/npm/v/react-native-flux-desktop-packer?style=flat-square&color=cb3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/react-native-flux-desktop-packer"><img src="https://img.shields.io/npm/dm/react-native-flux-desktop-packer?style=flat-square" alt="npm downloads"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/platform-win32-lightgrey?style=flat-square" alt="win32 only">
</p>

Turn a [react-native-flux-desktop](https://www.npmjs.com/package/react-native-flux-desktop) app into a **single self-contained Windows `.exe`** — no Electron, no installer, no Node.js required on the target machine. End users double-click one file and get a native window.

## How it works

```
app.json ──▶ [1] stage payload      dist/ + node_modules/ + assets/ + your node.exe
           ──▶ [2] zip              payload.zip (Optimal deflate)
           ──▶ [3] icon             app.png → .syso via go-winres (optional)
           ──▶ [4] go build         Go launcher with go:embed payload + -H windowsgui
           ──▶ [5] deliver          <output>/<Name>-<version>.exe
```

The launcher is a tiny Go binary with the whole runtime **embedded** (`go:embed`). On first launch it self-extracts to `%LOCALAPPDATA%\<AppName>\app-<content-hash>\` (with zip-slip protection, atomic rename), then runs your entry JS with the bundled `node.exe`. The hash key means a new build re-extracts automatically, while unchanged builds open instantly.

No Go on the build machine? The packer **falls back** to a portable folder + `run.cmd` — the app still runs, it's just not one file.

## Install

```sh
npm install --save-dev react-native-flux-desktop-packer
```

Requirements (build machine): Node.js ≥ 18 on Windows. Optional: [Go](https://go.dev) for the single-exe path, [`go-winres`](https://github.com/tc-hib/go-winres) for a custom exe icon — both degrade gracefully when missing.

## Usage

**1.** Make sure your app has an `app.json` at the project root:

```json
{
  "name": "MyApp",
  "version": "0.1.0",
  "icon": "assets/icon.png",
  "main": "dist/App.js",
  "output": "output"
}
```

| Field | Used for |
|---|---|
| `name` | window title, exe file name, cache & data directory name (**required**) |
| `version` | exe file name suffix + Windows version resource |
| `icon` | PNG embedded as the exe icon (optional; default icon otherwise) |
| `main` | compiled entry JS; falls back to `package.json`'s `main` |
| `output` | where the exe lands (default `build`) |
| `pack` | payload whitelist, default `["dist","node_modules","assets","package.json","app.json"]`; also `pack.mode` (`folder` default, or `sea`) and `pack.assets` (asset dir, default `assets`) |

**2.** Build your app, then pack:

```sh
npm run build      # your tsc step — produces dist/
npx flux-pack      # → output/MyApp-0.1.0.exe
```

CLI flags:

```
flux-pack                   pack the project in the current directory
flux-pack --project <dir>   point at another project root
flux-pack --keep            keep the intermediate .flux-pack/ work dir (debugging)
```

**Programmatic API:**

```js
const { pack } = require('react-native-flux-desktop-packer');
await pack({ projectRoot: __dirname, keep: false });
```

## What ships in the payload

The stage copies your `dist/`, `node_modules/`, `assets/`, `package.json` and `app.json`, plus the **`node.exe` running the packer** (N-API is ABI-stable across majors, so the bundled node loads your `.node` addon fine). Platform-specific prebuilds that can't run on win32-x64 (darwin/linux canvas binaries, `ffmpeg-static`) are filtered out to keep the exe small.

At runtime the launcher sets `FLUX_PACKAGED=1` and `FLUX_APP_DIR=<AppName>`, so the library routes KV/log data to `%APPDATA%\<AppName>\` — no writable-path issues even when the exe sits in `Program Files`.

## SEA single-file mode (`pack.mode: "sea"`)

The default path above ships the **folder/launcher** payload (a Go exe embedding a zip of `dist/` + `node_modules/` + `node.exe`). On first launch it self-extracts a readable **JS source tree** to `%LOCALAPPDATA%` — which works, but the extracted `dist/**/*.js` and `node_modules/` make it obviously a JavaScript project.

Setting `"pack": { "mode": "sea" }` in `app.json` switches to a **Node SEA** (Single Executable Application) build that fixes the optics. The existing `folder` path is untouched — flip the field back to revert.

```
app.json ─▶ [1] esbuild      all JS → one minified app.cjs (no dist/ tree, no node_modules)
         ─▶ [2] SEA assets   app.cjs + native .node (self + skia) + icudtl.dat + image assets embedded in the blob
         ─▶ [3] rcedit       icon + FileDescription/ProductName/… written onto a node.exe copy (BEFORE injection)
         ─▶ [4] postject     NODE_SEA_BLOB injected into that exe
         ─▶ [5] subsystem    PE OptionalHeader.Subsystem 3→2 (GUI) so double-click doesn't flash a console
         ─▶ [6] deliver      <output>/<Name>-<version>.exe  (one file)
```

At runtime, `node:sea` runs a bootstrap (the SEA `main`) that self-extracts the embedded natives/assets once to a hidden `%LOCALAPPDATA%\<AppName>\run-<stamp>\`, installs native-resolution hooks (skia via `NAPI_RS_NATIVE_LIBRARY_PATH`, your `.node` via `Module._resolveFilename`), `chdir`s to the extracted asset dir, sets `FLUX_PACKAGED=1` / `FLUX_APP_DIR`, then `createRequire`s the opaque `app.cjs`. The `.extracted` marker makes second launches skip re-extraction. There is **no `node.exe` child process** — Task Manager shows the branded `<App>.exe` name and icon.

What you gain: the disk no longer holds a JS source tree — the extracted dir contains a single minified `app.cjs` plus opaque compiled binaries (`.node`/`.dat`) and your image assets.

**Requirements:** build machine needs Node.js ≥ 20 with SEA support (uses `--experimental-sea-config`) plus `esbuild` and `postject` (declared as `optionalDependencies`; `rcedit` is optional too — icon/version injection degrades gracefully when absent). Missing `esbuild`/`postject` → the packer errors with the exact `npm i` to run.

**Honest limitations:**
- **Not absolute anti-reverse-engineering.** SEA blobs have public extraction tools and `app.cjs` is minified plaintext JS. This *raises the bar* and removes the "obviously a JS project" surface; it does **not** make the source unrecoverable. For more, layer `bytenode`/V8 bytecode over the bundle (out of scope here).
- **Runtime still writes opaque natives + one `app.cjs`** to a hidden `%LOCALAPPDATA%` dir. Node SEA can only embed JS in the blob — native `.node` addons and non-JS assets must land on a real path (this is the C1 self-extract tradeoff; a co-located `native/` folder is the only alternative).
- **Size** grows to roughly node.exe + blob + embedded natives (≈ 130–140 MB for the gallery demo).

## Pre-flight validation

The packer fails fast, before copying anything:

- missing `app.json` or `name` → error with the exact fix
- entry JS does not exist → "run your build first"
- entry JS is **older than any source file** (you forgot to recompile) → error naming both files and mtimes — this one has saved more than one release

## Repository layout

```
bin/flux-pack.js     CLI entry (npx flux-pack)
lib/                 config reader / icon builder / orchestration
launcher/            Go launcher source + placeholder payload.zip (go:embed stub)
test/entry-check.js  smoke test for the entry validator
```

## Related

- [react-native-flux-desktop](https://www.npmjs.com/package/react-native-flux-desktop) — the desktop rendering stack this packs apps for.
- [react-native-flux](https://github.com/keyonByIos/react-native-flux) — parent repository.

## License

[MIT](./LICENSE)
