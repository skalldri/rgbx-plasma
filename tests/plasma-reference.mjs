// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Stuart Alldritt
//
// Two host-side models of Plasma, used by tests/rgbx-v2-parity.mjs to say what
// a frame is SUPPOSED to contain. Neither reads the built module, so neither
// can be fooled by a module that changed.
//
//   floatFrame()  the canonical animation as src/main.cpp states it, in
//                 double-precision Math.sin. This is the definition of what
//                 Plasma looks like; the Q15 guest is an approximation OF it,
//                 so agreement here is the fidelity claim and it is checked
//                 with a tolerance.
//   q15Frame()    an independent re-derivation of the guest's fixed-point
//                 method (seed each wave from the polynomial sine, then walk
//                 it across the frame by angle addition), written in JavaScript
//                 from the arithmetic rather than compiled from the C. It has
//                 to agree with the module EXACTLY, so it pins every rounding
//                 decision the C makes.
//   advanceAccumulator()  the phase accumulator's own arithmetic, in BigInt,
//                 so the 64-bit steps are exact here by construction rather
//                 than by the same widening the C has to get right.
//
// Both frame models return width*height luma bytes in the guest's emission
// order: pixel index y*WIDTH + x, which is also the order set_luma_span8
// walks (first_pixel runs 0, 8, 16, ... across the whole frame).

export const WIDTH = 40;
export const HEIGHT = 12;
export const PIXEL_COUNT = WIDTH * HEIGHT;

// Phase-accumulator wrap period in ms: 20*pi s rounded to whole ms. The three
// wave rates 1.1, 0.7 and 1.7 rad/s are 11 : 7 : 17 on a 0.1 rad/s grid, so all
// three phases return to their starting values there.
export const PERIOD_MS = 62832;

// kTau as src/main.cpp spells it. Kept literal rather than 2*Math.PI so this
// model states the same constant the canonical animation does; the 7e-8 rad
// difference between them is orders of magnitude below the tolerance the
// fidelity check applies anyway.
const TAU = 6.2831853;

// ---------------------------------------------------------------------------
// The phase accumulator.
// ---------------------------------------------------------------------------

/**
 * One tick of the accumulator: time = (time + dt*speed/50 mod period) mod period.
 *
 * BigInt on purpose. The product dt*speed reaches (2^32-1)^2 for a client that
 * writes the full uint32 range into Speed, which is exactly the case the guest
 * has to widen to 64 bits before dividing, so a model that computed it in
 * doubles would lose the low bits it is here to check.
 */
export function advanceAccumulator(timeMs, dtMs, speed) {
  const step = ((BigInt(dtMs) * BigInt(speed)) / 50n) % BigInt(PERIOD_MS);
  return Number((BigInt(timeMs) + step) % BigInt(PERIOD_MS));
}

// ---------------------------------------------------------------------------
// The canonical float model.
// ---------------------------------------------------------------------------

function quantizeLuma(wave, invert) {
  // [-3, 3] -> [0, 255], truncating, matching both src/main.cpp's
  // (uint32_t)((w + 3) * (255/6)) and the guest's (value_q15 * 85) >> 16.
  const value = invert ? 3 - wave : wave + 3;
  const bounded = Math.min(Math.max(value, 0), 6);
  return Math.min(255, Math.floor(bounded * (255 / 6)));
}

/** The animation as src/main.cpp defines it, in double precision. */
export function floatFrame(timeMs, invert = false) {
  const t = timeMs / 1000;
  const frame = new Uint8Array(PIXEL_COUNT);
  for (let y = 0; y < HEIGHT; ++y) {
    const fy = y / HEIGHT;
    for (let x = 0; x < WIDTH; ++x) {
      const fx = x / WIDTH;
      const wave = Math.sin(fx * TAU * 1.5 + t * 1.1) +
                   Math.sin(fy * TAU + t * 0.7) +
                   Math.sin((fx + fy) * TAU + t * 1.7);
      frame[y * WIDTH + x] = quantizeLuma(wave, invert);
    }
  }
  return frame;
}

// ---------------------------------------------------------------------------
// The Q15 model.
// ---------------------------------------------------------------------------

const PI_Q20 = 3294199;
const HALF_PI_Q20 = 1647099;
const TAU_Q20 = 6588397;

// Angle-addition constants, in Q15. Each pair is (sin, cos) of one step, and
// each doubled cosine is 2*cos(step) for the two-term recurrence.
//   x step:      TAU*1.5/WIDTH  = 0.2356194 rad
//   radial step: TAU/WIDTH      = 0.1570796 rad
//   row step:    TAU/HEIGHT     = 0.5235988 rad (both the y and radial rows)
const X_STEP_BACK_SIN = -7650;
const X_STEP_BACK_COS = 31863;
const X_STEP_DOUBLE_COS = 63726;
const RADIAL_STEP_BACK_SIN = -5126;
const RADIAL_STEP_BACK_COS = 32365;
const RADIAL_STEP_DOUBLE_COS = 64730;
const ROW_STEP_SIN = 16384;
const ROW_STEP_COS = 28378;

/**
 * Round-to-nearest arithmetic right shift of a 64-bit value, away from zero.
 *
 * Done with divisions rather than JavaScript's >>, which is 32-bit: the inputs
 * here are products as wide as 1.8e15, and every one of them is exactly
 * representable as a double, so this is exact rather than approximate.
 */
function roundShift(value, shift) {
  const half = 2 ** (shift - 1);
  const scale = 2 ** shift;
  return value >= 0 ? Math.floor((value + half) / scale) : -Math.floor((-value + half) / scale);
}

/**
 * sin(x) for x in Q20, returned in Q15.
 *
 * Range-reduce into [-pi/2, pi/2], then a degree-9 odd polynomial in x, which
 * is where the guest's accuracy comes from before the recurrence carries it
 * across the frame.
 */
function boundedSinQ15(valueQ20) {
  let x = Math.trunc(valueQ20 % TAU_Q20);
  if (x > PI_Q20) {
    x -= TAU_Q20;
  } else if (x < -PI_Q20) {
    x += TAU_Q20;
  }
  if (x > HALF_PI_Q20) {
    x = PI_Q20 - x;
  } else if (x < -HALF_PI_Q20) {
    x = -PI_Q20 - x;
  }

  const x2Q20 = roundShift(x * x, 20);
  let polynomialQ30 = 2959;
  polynomialQ30 = -213044 + roundShift(x2Q20 * polynomialQ30, 20);
  polynomialQ30 = 8947849 + roundShift(x2Q20 * polynomialQ30, 20);
  polynomialQ30 = -178956971 + roundShift(x2Q20 * polynomialQ30, 20);
  const factorQ30 = 1073741824 + roundShift(x2Q20 * polynomialQ30, 20);
  const sineQ20 = roundShift(x * factorQ30, 30);
  return roundShift(sineQ20, 5);
}

// The guest does these in int32_t, and the products come within a few percent
// of INT32_MAX, so the model wraps exactly where the C would rather than
// carrying extra precision the device does not have.
function shiftQ15(value) {
  return ((value + 16384 - (value < 0 ? 1 : 0)) | 0) >> 15;
}

/** sin(a + b) from sin/cos a and sin/cos b. */
function rotateSinQ15(sine, cosine, stepSine, stepCosine) {
  return shiftQ15((Math.imul(sine, stepCosine) + Math.imul(cosine, stepSine)) | 0);
}

/** sin(a + b) from sin a, sin(a - b) and 2*cos b: the two-term recurrence. */
function advanceSinQ15(sine, previousSine, doubledStepCosine) {
  return shiftQ15(Math.imul(sine, doubledStepCosine)) - previousSine;
}

function plasmaLuma(waveQ15, invert) {
  const threeQ15 = 3 * 32768;
  const valueQ15 = invert ? threeQ15 - waveQ15 : waveQ15 + threeQ15;
  const bounded = valueQ15 < 0 ? 0 : (valueQ15 > 6 * 32768 ? 6 * 32768 : valueQ15);
  return ((bounded * 85) >>> 16) & 0xff;
}

/** Phase of one wave at t, in Q20: rate*t where rate is tenths of a rad/s. */
function phaseQ20(timeMs, rateTenths) {
  return Number((BigInt(timeMs) * BigInt(rateTenths) * 1048576n) / 10000n);
}

/** The animation as the RGBX v2 guest computes it, in fixed point. */
export function q15Frame(timeMs, invert = false) {
  const t1Q20 = phaseQ20(timeMs, 11);
  const t2Q20 = phaseQ20(timeMs, 7);
  const t3Q20 = phaseQ20(timeMs, 17);

  const xStartSin = boundedSinQ15(t1Q20);
  const xStartCos = boundedSinQ15(t1Q20 + HALF_PI_Q20);
  const xStartPrevious =
      rotateSinQ15(xStartSin, xStartCos, X_STEP_BACK_SIN, X_STEP_BACK_COS);
  let ySin = boundedSinQ15(t2Q20);
  let yCos = boundedSinQ15(t2Q20 + HALF_PI_Q20);
  let radialRowSin = boundedSinQ15(t3Q20);
  let radialRowCos = boundedSinQ15(t3Q20 + HALF_PI_Q20);

  const frame = new Uint8Array(PIXEL_COUNT);
  for (let y = 0; y < HEIGHT; ++y) {
    let xSin = xStartSin;
    let xPrevious = xStartPrevious;
    let radialSin = radialRowSin;
    let radialPrevious =
        rotateSinQ15(radialRowSin, radialRowCos, RADIAL_STEP_BACK_SIN, RADIAL_STEP_BACK_COS);
    for (let x = 0; x < WIDTH; ++x) {
      frame[y * WIDTH + x] = plasmaLuma(xSin + ySin + radialSin, invert);
      const nextXSin = advanceSinQ15(xSin, xPrevious, X_STEP_DOUBLE_COS);
      xPrevious = xSin;
      xSin = nextXSin;
      const nextRadialSin =
          advanceSinQ15(radialSin, radialPrevious, RADIAL_STEP_DOUBLE_COS);
      radialPrevious = radialSin;
      radialSin = nextRadialSin;
    }
    const nextYSin = rotateSinQ15(ySin, yCos, ROW_STEP_SIN, ROW_STEP_COS);
    yCos = rotateSinQ15(yCos, -ySin, ROW_STEP_SIN, ROW_STEP_COS);
    ySin = nextYSin;
    const nextRadialRowSin =
        rotateSinQ15(radialRowSin, radialRowCos, ROW_STEP_SIN, ROW_STEP_COS);
    radialRowCos = rotateSinQ15(radialRowCos, -radialRowSin, ROW_STEP_SIN, ROW_STEP_COS);
    radialRowSin = nextRadialRowSin;
  }
  return frame;
}

/** Largest absolute difference between two frames, in luma levels. */
export function maxDifference(actual, expected) {
  let worst = 0;
  for (let index = 0; index < actual.length; ++index) {
    worst = Math.max(worst, Math.abs(actual[index] - expected[index]));
  }
  return worst;
}
