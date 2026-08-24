# rgbx-plasma

**Plasma** — the classic three-wave interference plasma for the
[RGB Sunglasses](https://github.com/skalldri/rgb-sunglasses), tinted by a
BLE-tunable color, with speed and invert parameters. A standalone rgbx
extension built from
[rgbx-extension-template](https://github.com/skalldri/rgbx-extension-template)
(C++ `rgbx::Animation` wrapper) and registered in the main repo's
`extensions/registry.json`.

Formerly an in-repo firmware extension; it moved here when firmware v3.1.0
started exporting single-precision libm to extensions, and its integer wave
approximations became real `sinf()`.

## Build

```bash
./build.sh
```

produces `build/arm/plasma.llext` (device) and `build/wasm/plasma.wasm`
(simulator — drag onto <https://rgb-sunglasses.autom8ed.com/sim/>).

Prerequisites: bash, cmake ≥ 3.21, Node.js ≥ 20, curl, tar. `build.sh` checks the
Node version before it configures anything — the SDK's wasm gate
(`check-wasm.mjs`) needs ≥ 20, and an older one fails the wasm link with a bare
`SyntaxError` from inside the SDK. If you upgrade Node after a build, re-run
`./build.sh -URGBX_NODE`: CMake cached the old interpreter's path at configure
time and keeps using it otherwise.

## How this reaches devices

Every `fw-v*` firmware release rebuilds this repo from its registry-pinned
commit and ships `plasma.llext` as a release asset; the companion app
installs it automatically. See the template's README for the full
publish/update flow.
