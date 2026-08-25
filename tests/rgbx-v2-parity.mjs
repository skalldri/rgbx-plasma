#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Stuart Alldritt
//
// Known-answer parity tests for the RGBX v2 Plasma guest.
//
//   node tests/rgbx-v2-parity.mjs build/rgbx-v2/plasma.wasm
//
// The SDK's own gate (check-rgbx-v2.mjs) proves the module is ADMISSIBLE: the
// right sections, no floats, no memory, and a complete frame emitted within
// the firmware's per-tick call budgets. It does not look at a single luma
// value, so it would pass a module whose animation had quietly changed.
//
// These tests close that gap. Every expectation comes from
// tests/plasma-reference.mjs, which models the animation without reading the
// module, on two levels:
//
//   * the canonical float definition of Plasma (src/main.cpp's formula in
//     Math.sin), checked with a tolerance, because the guest's fixed point is
//     an approximation of it and the size of that approximation is the claim
//     worth guarding;
//   * an independent re-derivation of the fixed-point method itself, checked
//     exactly, because that pins every rounding decision the C makes.
//
// The cases are the times the arithmetic itself lands on, plus a sampled sweep
// of the period (case 6) to catch an edit that only shows up somewhere else.
// Parameter defaults are read out of rgbx-v2.json rather than copied here, so a
// manifest that drifts out of step with the guest's slot contract fails case 0
// instead of quietly changing what every later case is testing.
//
// The accumulator cases carry their arithmetic in the comment above them and a
// literal expected value in the assertion, so a reader can check the number
// without running anything, and a regression names the step it broke.
//
// Nothing here is a golden captured from a previous build. If an edit to
// src/main_v2.c makes a test fail, the fix is a re-derived expectation, never
// a refreshed recording.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  advanceAccumulator,
  floatFrame,
  HEIGHT,
  maxDifference,
  PERIOD_MS,
  PIXEL_COUNT,
  q15Frame,
  WIDTH,
} from "./plasma-reference.mjs";

// The two models agree to within one luma level everywhere tested. That is the
// fidelity claim: the fixed-point guest paints the same picture as the float
// animation, to the resolution the 8-bit output has. It is an assertion, not an
// observation to be relaxed when it fails.
const FIDELITY_TOLERANCE = 1;

// Parameter slots. The guest hardcodes these ids: it reads slot 0 as the speed
// percentage, 1 as the foreground colour, 2 as the invert flag and 3 as the
// background colour. rgbx-v2.json decides what the device puts in them, so the
// two have to agree on the order, and the defaults the tests run against have to
// be the defaults the package ships. Both are read out of the manifest rather
// than copied here, and anything unexpected in it fails closed.
const SPEED = 0;
const COLOR = 1;
const INVERT = 2;
const BACKGROUND = 3;
const MANIFEST_SLOTS = ["Speed", "Color", "Invert", "Background"];

function loadManifestDefaults() {
  const path = new URL("../rgbx-v2.json", import.meta.url);
  let spec;
  try {
    spec = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read rgbx-v2.json: ${error.message}`);
  }
  const params = spec.parameters;
  if (!Array.isArray(params) || params.length !== MANIFEST_SLOTS.length) {
    throw new Error(`rgbx-v2.json declares ${Array.isArray(params) ? params.length : "no"} ` +
                    `parameters, but the guest reads ${MANIFEST_SLOTS.length}`);
  }
  return params.map((param, slot) => {
    const expected = MANIFEST_SLOTS[slot];
    if (param === null || typeof param !== "object" || param.name !== expected) {
      throw new Error(`rgbx-v2.json parameter ${slot} is ` +
                      `${JSON.stringify(param && param.name)}, but the guest reads slot ` +
                      `${slot} as ${expected}`);
    }
    if (param.type === "bool") {
      if (typeof param.default !== "boolean") {
        throw new Error(`${expected} is a bool with a non-boolean default`);
      }
      return param.default ? 1 : 0;
    }
    if (param.type !== "uint32" && param.type !== "color") {
      throw new Error(`${expected} has type ${param.type}, which these tests cannot drive`);
    }
    if (!Number.isInteger(param.default) || param.default < 0 || param.default > 0xffffffff) {
      throw new Error(`${expected} has a default outside uint32`);
    }
    return param.default;
  });
}

const DEFAULT_PARAMS = loadManifestDefaults();

let failures = 0;

function check(description, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${description}`);
    return;
  }
  ++failures;
  console.log(`  FAIL ${description}${detail ? `: ${detail}` : ""}`);
}

function checkEqual(description, actual, expected) {
  check(description, actual === expected, `expected ${expected}, got ${actual}`);
}

function checkFrameExact(description, actual, expected) {
  let firstDifference = -1;
  for (let index = 0; index < PIXEL_COUNT; ++index) {
    if (actual[index] !== expected[index]) {
      firstDifference = index;
      break;
    }
  }
  check(description, firstDifference < 0,
        firstDifference < 0 ? "" :
            `pixel ${firstDifference} (x=${firstDifference % WIDTH}, ` +
                `y=${Math.floor(firstDifference / WIDTH)}) is ${actual[firstDifference]}, ` +
                `expected ${expected[firstDifference]}`);
}

function checkFrameWithin(description, actual, expected, tolerance) {
  const worst = maxDifference(actual, expected);
  check(description, worst <= tolerance, `largest difference ${worst} exceeds ${tolerance}`);
}

/**
 * A running instance of the guest, with a host that records what it paints.
 *
 * The host is deliberately strict about the span protocol: spans must arrive
 * in ascending pixel order and cover the frame exactly once. A guest that
 * skipped or repeated a span could otherwise leave stale bytes in the frame
 * and still compare equal.
 */
function loadGuest(modulePath) {
  const frame = new Uint8Array(PIXEL_COUNT);
  const params = DEFAULT_PARAMS.slice();
  let nextPixel = 0;
  let palette = null;

  const host = {
    param_u32: (id) => params[id >>> 0] ?? 0,
    set_luma_span8: (first, foreground, background, ...lumas) => {
      if ((first >>> 0) !== nextPixel) {
        throw new Error(`span starts at pixel ${first >>> 0}, expected ${nextPixel}`);
      }
      const seen = { foreground: foreground >>> 0, background: background >>> 0 };
      if (palette === null) {
        palette = seen;
      } else if (palette.foreground !== seen.foreground ||
                 palette.background !== seen.background) {
        throw new Error("guest changed the palette part way through a frame");
      }
      for (const luma of lumas) {
        if ((luma >>> 0) > 0xff) throw new Error(`luma ${luma} exceeds one byte`);
        frame[nextPixel++] = luma;
      }
    },
  };

  const bytes = readFileSync(resolve(modulePath));
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), { rgbx_v2: host });
  instance.exports.rgbx_init();

  return {
    /** Set the parameter slots the next tick will read. */
    setParams(values) {
      for (const [slot, value] of Object.entries(values)) params[slot] = value;
    },
    /** Run one tick and return the frame it painted, plus the palette it forwarded. */
    tick(dtMs) {
      frame.fill(0);
      nextPixel = 0;
      palette = null;
      instance.exports.rgbx_tick(dtMs);
      if (nextPixel !== PIXEL_COUNT) {
        throw new Error(`guest painted ${nextPixel} pixels, expected ${PIXEL_COUNT}`);
      }
      return { frame: frame.slice(), palette };
    },
  };
}

const [moduleArg] = process.argv.slice(2);
if (!moduleArg) {
  console.error("usage: rgbx-v2-parity.mjs <module.wasm>");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Case 0: the manifest's half of the contract.
//
// The expectations further down are written against a 1x Speed and Invert off,
// because that is what the package ships. Those are manifest values, not
// constants of this file, so state the dependency here: if a default moves, the
// failure should say which one rather than showing up as a frame full of wrong
// pixels several cases later.
// ---------------------------------------------------------------------------
console.log("case 0: manifest defaults");
{
  checkEqual("Speed defaults to 1x", DEFAULT_PARAMS[SPEED], 50);
  checkEqual("Invert defaults to off", DEFAULT_PARAMS[INVERT], 0);
  check("Color and Background defaults are 24-bit",
        DEFAULT_PARAMS[COLOR] <= 0xffffff && DEFAULT_PARAMS[BACKGROUND] <= 0xffffff);
}

// ---------------------------------------------------------------------------
// Case 1: t = 0.
//
// rgbx_init zeroes the accumulator, and a dt of 0 leaves it there:
//   step = (0 * 50 / 50) mod 62832 = 0, time = (0 + 0) mod 62832 = 0.
//
// At t = 0 the animation reduces to sin(fx*tau*1.5) + sin(fy*tau) +
// sin((fx+fy)*tau), which is exactly computable at the pixels below. Those
// anchors are the one place in this file where the expected picture is derived
// with pen and paper rather than by a model, so they are the check that the
// models themselves describe Plasma and not merely each other.
// ---------------------------------------------------------------------------
console.log("case 1: t = 0");
{
  const guest = loadGuest(moduleArg);
  const { frame, palette } = guest.tick(0);

  checkFrameExact("frame matches the fixed-point model at t = 0", frame, q15Frame(0));
  checkFrameWithin("frame matches the canonical float animation at t = 0", frame, floatFrame(0),
                   FIDELITY_TOLERANCE);

  // wave -> luma is floor((wave + 3) * 255/6) = floor((wave + 3) * 42.5).
  const anchors = [
    // x, y, wave at t = 0, hand-computed luma.
    // (0,0): sin 0 + sin 0 + sin 0 = 0 -> floor(3 * 42.5) = floor(127.5).
    [0, 0, 127],
    // (10,0): fx = 1/4, so sin(3pi/4) + sin(0) + sin(pi/2) = 1/sqrt(2) + 1
    //         -> floor(4.7071068 * 42.5) = floor(200.052).
    [10, 0, 200],
    // (20,0): fx = 1/2, so sin(3pi/2) + sin(0) + sin(pi) = -1
    //         -> floor(2 * 42.5) = 85.
    [20, 0, 85],
    // (30,0): fx = 3/4, so sin(9pi/4) + sin(0) + sin(3pi/2) = 1/sqrt(2) - 1
    //         -> floor(2.7071068 * 42.5) = floor(115.052).
    [30, 0, 115],
    // (0,6): fy = 1/2, so sin(0) + sin(pi) + sin(pi) = 0 -> floor(127.5).
    [0, 6, 127],
    // (20,3): fx = 1/2, fy = 1/4, so sin(3pi/2) + sin(pi/2) + sin(3pi/2) = -1
    //         -> floor(2 * 42.5) = 85.
    [20, 3, 85],
  ];
  for (const [x, y, expected] of anchors) {
    const actual = frame[y * WIDTH + x];
    check(`pixel (${x}, ${y}) is ${expected} by hand`,
          Math.abs(actual - expected) <= FIDELITY_TOLERANCE,
          `got ${actual}`);
  }

  checkEqual("palette forwards the default Color", palette.foreground, DEFAULT_PARAMS[COLOR]);
  checkEqual("palette forwards the default Background", palette.background,
             DEFAULT_PARAMS[BACKGROUND]);
}

// ---------------------------------------------------------------------------
// Case 2: mid-animation.
//
// One 20-second tick at the default Speed of 50, which is 1x:
//   step = (20000 * 50 / 50) mod 62832 = 20000 mod 62832 = 20000
//   time = (0 + 20000) mod 62832 = 20000
// Twenty seconds is far enough in that all three waves have moved by different
// amounts (22, 14 and 34 rad), so the frame exercises the polynomial seed at
// arbitrary phase rather than at the zeros t = 0 lands on.
// ---------------------------------------------------------------------------
console.log("case 2: mid-animation at t = 20000 ms");
{
  const guest = loadGuest(moduleArg);
  const { frame } = guest.tick(20000);
  const expectedTime = advanceAccumulator(0, 20000, 50);
  checkEqual("accumulator arithmetic", expectedTime, 20000);
  checkFrameExact("frame matches the fixed-point model at t = 20000 ms", frame,
                  q15Frame(expectedTime));
  checkFrameWithin("frame matches the canonical float animation at t = 20000 ms", frame,
                   floatFrame(expectedTime), FIDELITY_TOLERANCE);
}

// ---------------------------------------------------------------------------
// Case 3: the 62832 ms accumulator wrap.
//
// 62832 ms is 20*pi s to the nearest ms, where all three wave rates (11 : 7 :
// 17 tenths of a rad/s) complete a whole number of turns. The accumulator wraps
// there so the sine arguments stay small; the animation is only allowed to do
// that because the wrap is seamless.
//
//   20000 + 42832 = 62832, and 62832 mod 62832 = 0
//
// so the frame after the wrap has to be the frame at t = 0, byte for byte. That
// is a known answer that needs no model at all.
// ---------------------------------------------------------------------------
console.log("case 3: accumulator wrap at 62832 ms");
{
  const guest = loadGuest(moduleArg);
  const zeroFrame = guest.tick(0).frame;
  const at20000 = guest.tick(20000).frame;
  const wrapped = guest.tick(42832).frame;

  checkEqual("wrap arithmetic", advanceAccumulator(20000, 42832, 50), 0);
  checkFrameExact("the frame after the wrap is the frame at t = 0", wrapped, zeroFrame);
  check("the wrap is not a freeze", maxDifference(at20000, zeroFrame) > 0,
        "t = 20000 painted the t = 0 frame");

  // One ms past the wrap: step = 62833 mod 62832 = 1, so the accumulator lands
  // on 1 rather than on 62833. A build that wrapped the RATE instead of the
  // accumulator, or that did not wrap at all, would disagree here.
  const guestPast = loadGuest(moduleArg);
  checkEqual("one ms past the wrap", advanceAccumulator(0, 62833, 50), 1);
  checkFrameExact("the frame one ms past the wrap", guestPast.tick(62833).frame, q15Frame(1));

  // The bound is on the accumulator, not on the rate, so it holds for any
  // Speed. At Speed = 1000000 a single 1000 ms tick advances
  //   step = (1000 * 1000000 / 50) mod 62832 = 20000000 mod 62832
  //        = 20000000 - 318*62832 = 20000000 - 19980576 = 19424
  const guestFast = loadGuest(moduleArg);
  guestFast.setParams({ [SPEED]: 1000000 });
  checkEqual("a step larger than the period wraps too", advanceAccumulator(0, 1000, 1000000),
             19424);
  checkFrameExact("the frame after a step larger than the period",
                  guestFast.tick(1000).frame, q15Frame(19424));
}

// ---------------------------------------------------------------------------
// Case 4: the 64-bit multiplications.
//
// 4a. The accumulator step. Speed is a uint32 the host writes without a range
// check, so dt_ms * Speed has to be widened before the divide:
//
//   dt = Speed = 0xFFFFFFFF = 4294967295
//   dt * Speed = 18446744065119617025
//   / 50       = 368934881302392340   (floor)
//   mod 62832  = 41284
//
// In 32 bits the product is (2^32-1)^2 mod 2^32 = 1, so the step would be
// 1/50 = 0 and the animation would FREEZE at maximum Speed. That was a real
// defect in the float extension; the assertion below is what stops it coming
// back in the fixed-point one.
// ---------------------------------------------------------------------------
console.log("case 4a: 64-bit accumulator step at the top of the uint32 range");
{
  const guest = loadGuest(moduleArg);
  guest.setParams({ [SPEED]: 0xffffffff });
  const expectedTime = advanceAccumulator(0, 0xffffffff, 0xffffffff);
  checkEqual("64-bit step arithmetic", expectedTime, 41284);
  check("a 32-bit product would freeze the animation", expectedTime !== 0);
  const { frame } = guest.tick(0xffffffff);
  checkFrameExact("frame matches the fixed-point model after the 64-bit step", frame,
                  q15Frame(expectedTime));
  checkFrameWithin("frame matches the canonical float animation after the 64-bit step", frame,
                   floatFrame(expectedTime), FIDELITY_TOLERANCE);
}

// ---------------------------------------------------------------------------
// 4b. The per-frame phase multiplication. Each wave's phase is
// time_ms * rate * 2^20 / 10000 in Q20, and at the top of the accumulator's
// range the numerator leaves 32 bits far behind:
//
//   62831 * 17 * 1048576 = 1120012337152   (about 260x UINT32_MAX)
//
// so a build that computed the phase in 32 bits would wrap and paint a
// completely different frame. 62831 ms is also one ms before the wrap, so the
// frame has to be within rounding of the t = 0 frame, which is a second,
// independent reading of the same result.
// ---------------------------------------------------------------------------
console.log("case 4b: 64-bit phase multiplication at the top of the period");
{
  const guest = loadGuest(moduleArg);
  const zeroFrame = guest.tick(0).frame;
  const expectedTime = advanceAccumulator(0, PERIOD_MS - 1, 50);
  checkEqual("accumulator reaches the top of the period", expectedTime, 62831);
  const { frame } = guest.tick(PERIOD_MS - 1);
  checkFrameExact("frame matches the fixed-point model at t = 62831 ms", frame,
                  q15Frame(expectedTime));
  checkFrameWithin("frame matches the canonical float animation at t = 62831 ms", frame,
                   floatFrame(expectedTime), FIDELITY_TOLERANCE);
  // One ms of the fastest wave is 0.0017 rad, which moves a luma level by at
  // most 0.08, so the two frames can differ only where quantization falls
  // either side of a boundary.
  checkFrameWithin("one ms before the wrap is one ms of motion", frame, zeroFrame, 2);
}

// ---------------------------------------------------------------------------
// Case 5: parameters.
//
// Invert flips the brightness gradient, which in the guest is
// (3 - wave) rather than (wave + 3). Both truncate, so the inverted and normal
// lumas of a pixel sum to 254 or 255 depending on which side of a level the
// fractional part falls: floor(a) + floor(255 - a) is 254 when a has a
// fractional part and 255 when it does not.
//
// Colour and Background are the host's business, not the guest's: the guest
// forwards them to set_luma_span8 untouched and never decomposes them, which is
// what lets the whole animation stay integer.
// ---------------------------------------------------------------------------
console.log("case 5: parameters");
{
  const guest = loadGuest(moduleArg);
  const plain = guest.tick(20000).frame;

  const inverted = loadGuest(moduleArg);
  inverted.setParams({ [INVERT]: 1, [COLOR]: 0x123456, [BACKGROUND]: 0xabcdef });
  const { frame: flipped, palette } = inverted.tick(20000);

  checkFrameExact("inverted frame matches the fixed-point model", flipped, q15Frame(20000, true));
  checkFrameWithin("inverted frame matches the canonical float animation", flipped,
                   floatFrame(20000, true), FIDELITY_TOLERANCE);

  let badSum = -1;
  for (let index = 0; index < PIXEL_COUNT; ++index) {
    const sum = plain[index] + flipped[index];
    if (sum !== 254 && sum !== 255) {
      badSum = index;
      break;
    }
  }
  check("inverting complements every pixel", badSum < 0,
        badSum < 0 ? "" : `pixel ${badSum} sums to ${plain[badSum] + flipped[badSum]}`);

  checkEqual("Color reaches the host unchanged", palette.foreground, 0x123456);
  checkEqual("Background reaches the host unchanged", palette.background, 0xabcdef);
}

// ---------------------------------------------------------------------------
// Case 6: a sampled sweep of the whole period.
//
// The cases above check the exact fixed-point model at the handful of times the
// accumulator arithmetic lands on, which leaves room for an edit that changes
// the animation only at times none of them visit. Measured, not hypothetical:
// perturbing a single sine-polynomial coefficient by one changes the frame at
// as few as 4 of the 62832 times in the period, and the cases above miss all of
// them.
//
// So sweep. The spread is twenty evenly spaced times, round(k * 62832 / 20) for
// k in 0..19, which is arbitrary by design and covers the period. The three
// odd-looking additions are not arbitrary: 1589, 18639 and 21220 are, between
// them, hit by every one of the ten single-unit perturbations of the five
// polynomial coefficients, so this set kills all ten. Re-derive them the same
// way if the polynomial ever changes: mutate each coefficient by plus and minus
// one, list the times whose frames differ, and cover those lists.
//
// This narrows the gap rather than closing it. The backstop for "the module
// changed at all" is the digest CI asserts, not a sample of times.
// ---------------------------------------------------------------------------
console.log("case 6: sampled sweep of the period");
{
  const sampledTimes = [
    0, 1589, 3142, 6283, 9425, 12566, 15708, 18639, 18850, 21220, 21991, 25133,
    28274, 31416, 34558, 37699, 40841, 43982, 47124, 50266, 53407, 56549, 59690,
  ];
  let mismatchedTime = -1;
  let mismatchDetail = "";
  let worstFidelity = 0;
  for (const time of sampledTimes) {
    // One tick of dt = time at the default 1x Speed puts the accumulator at
    // exactly `time`, since time < 62832 and the step is unwrapped there.
    const guest = loadGuest(moduleArg);
    const { frame } = guest.tick(time);
    const expected = q15Frame(time);
    worstFidelity = Math.max(worstFidelity, maxDifference(frame, floatFrame(time)));
    for (let index = 0; index < PIXEL_COUNT; ++index) {
      if (frame[index] !== expected[index]) {
        mismatchedTime = time;
        mismatchDetail = `t = ${time}, pixel ${index} (x=${index % WIDTH}, ` +
                         `y=${Math.floor(index / WIDTH)}) is ${frame[index]}, ` +
                         `expected ${expected[index]}`;
        break;
      }
    }
    if (mismatchedTime >= 0) break;
  }
  check(`all ${sampledTimes.length} sampled times match the fixed-point model exactly`,
        mismatchedTime < 0, mismatchDetail);
  check(`all ${sampledTimes.length} sampled times match the canonical float animation`,
        worstFidelity <= FIDELITY_TOLERANCE,
        `largest difference ${worstFidelity} exceeds ${FIDELITY_TOLERANCE}`);
}

console.log(`\n${failures === 0 ? "RGBX v2 parity tests passed" : `${failures} parity check(s) FAILED`}` +
            ` (${WIDTH}x${HEIGHT} frame, ${PIXEL_COUNT} pixels)`);
process.exit(failures === 0 ? 0 : 1);
