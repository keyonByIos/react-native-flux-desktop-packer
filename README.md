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
| `pack` | payload whitelist, default `["dist","node_modules","assets","package.json","app.json"]` |

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
