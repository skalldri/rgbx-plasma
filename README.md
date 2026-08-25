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

produces three artifacts:

| Path | What it is |
| --- | --- |
| `build/arm/plasma.llext` | Device extension, native code in a memory-protected sandbox. |
| `build/wasm/plasma.wasm` | Simulator build; drag it onto <https://rgb-sunglasses.autom8ed.com/sim/>. |
| `build/rgbx-v2/plasma.rgbx` | RGBX v2 package, the format newer firmware installs. |

Prerequisites: bash, cmake ≥ 3.21, Node.js ≥ 20, curl, tar. `build.sh` checks the
Node version before it configures anything — the SDK's wasm gate
(`check-wasm.mjs`) needs ≥ 20, and an older one fails the wasm link with a bare
`SyntaxError` from inside the SDK. If you upgrade Node after a build, re-run
`./build.sh -URGBX_NODE`: CMake cached the old interpreter's path at configure
time and keeps using it otherwise.

Build one target on its own with
`cmake --preset rgbx-v2 && cmake --build --preset rgbx-v2`, substituting
`arm` or `wasm` for the other two.

## The RGBX v2 package

RGBX v2 loads a memoryless WebAssembly guest and drives it through a small
import surface, rather than loading native code. A guest gets no linear
memory, no C library and no floating-point opcodes, so `src/main.cpp` cannot
be recompiled for it: `src/main_v2.c` is the same animation written in Q15
fixed point, with the per-pixel colour blend moved into the host's
`set_luma_span8` import.

The two sources are both first-class. `src/main.cpp` builds the `.llext` and
the simulator `.wasm`; `src/main_v2.c` builds the `.rgbx`. They are the same
animation, and the parity tests below are what keeps them that way.

`rgbx-v2.json` is the manifest describing the package: identity, version,
ABI, geometry, compiler pin, and the parameter list the companion app shows.
Its `parameters` block mirrors `RGBX_ANIMATION(...)` in `src/main.cpp`, so
Speed, Color, Invert and Background keep their slots and defaults across both
formats. The build hashes the exact translation unit it compiled into the
package's provenance field, and refuses to run if `sourceFile` names anything
else.

Building the `rgbx-v2` preset runs the SDK's post-link pass, its structural
admission gate, its tick oracle, this repo's parity tests, and the container
builder. Any of them failing fails the build, so a module a device would
refuse cannot be produced here. The
[template's README](https://github.com/skalldri/rgbx-extension-template)
documents that flow, the memoryless profile and every manifest field in full;
this repo only pins and uses it.

The container bytes are a function of the source revision, the manifest and
the SDK pin, and of nothing else. Two clean builds of an unchanged tree
produce an identical file, and CI proves it on every change by building the
package a second time in a differently named directory, comparing bytes, and
checking both artifacts against the digests recorded below.

```bash
rm -rf build && ./build.sh
shasum -a 256 build/rgbx-v2/plasma.rgbx   # sha256sum on Linux
```

## Canonical source for the RGBX v2 Plasma

`src/main_v2.c` is the canonical RGBX v2 Plasma. The firmware repository is
moving to consume this repository at a registry-pinned revision and digest
instead of carrying its own copy of the animation; that move is tracked on
the firmware side and is not finished yet.

What already holds is the part that makes it a pin rather than a second port:
the module bytes the firmware commits as its RGBX v2 conformance fixture are
the byte-for-byte output of the pinned SDK toolchain over this source. Same
source plus same pin equals the same module, on any machine and on either
supported host OS.

Treat an edit to `src/main_v2.c` as a change to what every device will ship,
and one that surfaces downstream as a changed module digest. Two rules
follow:

- Do not adjust the arithmetic to make a test pass. The expectations in
  `tests/` are derived from the animation, not recorded from a build, so a
  failure means the animation moved.
- Bump `version` in `rgbx-v2.json` when the module changes. It is the only
  thing that tells an installed device the package is not the one it has.

Recorded at the port to RGBX v2, against the `fw-v3.5.0` SDK pin, and
asserted by CI on every change:

| Artifact | SHA-256 | Moves when |
| --- | --- | --- |
| `build/rgbx-v2/plasma.wasm` | `78506a11c786abc2085bb77c9982418b2a5e27c3242a9b85d04e5320ba8e1b24` | The compiled content of `src/main_v2.c` changes, or the SDK pin does. The module is compiled, post-linked and gated before the packager ever reads `rgbx-v2.json`, so neither the manifest nor a comment-only source edit reaches these bytes. |
| `build/rgbx-v2/plasma.rgbx` | `90e882079bb0b913611220acdeba2b6bf9572e5397500ba58e223a737f5812af` | Any of those, or `rgbx-v2.json`, or the source file's bytes. The container carries the manifest, and the manifest records the SHA-256 of the translation unit, so a `version` bump or even a comment-only source edit moves this digest while leaving the module identical. |

The module digest is the one the firmware's committed conformance fixture
carries. Recompute both with the `shasum` line above. When a change is
supposed to move one of them, the CI assertion moves with it in the same
commit; that is the point at which someone has to say so out loud.

## Parity guarantees

The SDK's gate proves the module is admissible and paints a complete frame.
It never looks at a luma value, so it would pass a module whose animation had
quietly changed. `tests/rgbx-v2-parity.mjs` closes that gap, and runs as part
of the `rgbx-v2` build rather than only in CI:

```bash
node tests/rgbx-v2-parity.mjs build/rgbx-v2/plasma.wasm
```

It drives the built module and compares each frame against two models in
`tests/plasma-reference.mjs`, neither of which reads the module:

- **The canonical float animation**, which is `src/main.cpp`'s formula in
  double-precision `Math.sin`. The fixed-point guest has to match it to
  within one luma level. This is both the fidelity claim for the Q15 port and
  the check that the two sources in this repo still paint the same picture.
- **An independent re-derivation of the fixed-point method** in JavaScript,
  written from the arithmetic rather than compiled from the C. The module has
  to match it exactly, which pins every rounding decision.

The cases are the ones where the arithmetic is load-bearing: a `t = 0` frame
checked against pixels computable by hand, a mid-animation frame, the
62832 ms accumulator wrap (where the frame after the wrap must be the frame
before the animation started, byte for byte), a step larger than the whole
period, and both 64-bit multiplications the guest performs. Each case carries
its arithmetic in a comment and a literal expected value in the assertion, so
a regression names the step that broke.

Those are the times the arithmetic lands on, which leaves room for an edit
that changes the picture only somewhere else. Measured: perturbing one
sine-polynomial coefficient by a single unit moves as few as 4 of the 62832
frames in the period, and none of the cases above visits them. So a final
case sweeps 23 sampled times, evenly spread across the period plus three
chosen to cover exactly those perturbations, and the comment above it says
how to re-derive that choice.

Parameter defaults come from `rgbx-v2.json` rather than being copied into the
tests, so a manifest that drifts out of step with the slot order the guest
hardcodes fails with that as the message instead of as wrong pixels.

Sampling narrows the gap rather than closing it. The check that the module
did not change at all is the digest CI asserts.

## How this reaches devices

Every `fw-v*` firmware release rebuilds this repo from its registry-pinned
commit and ships `plasma.llext` as a release asset; the companion app
installs it automatically. See the template's README for the full
publish/update flow. The `.rgbx` package follows the same pinned-revision
route on firmware that supports RGBX v2.

## Firmware pin

`cmake/fw-release.cmake` pins the firmware release, and the sha256 of its
`rgbx-sdk-*.tar.gz` asset, that this extension builds against. The digest is
checked before the archive is extracted, so a wrong or corrupted download
fails configure instead of building against whatever arrived.

Four fields in `rgbx-v2.json` move with the pin: `compilerVersion` and
`rgbxAbi` must equal the SDK's, `geometry` must equal the release's frame
size, and `minimumFirmwareAbi` may not exceed the SDK's ABI version. The
packager checks all four and fails when they drift, so a pin bump that moves
any of them is an edit to that file too.
