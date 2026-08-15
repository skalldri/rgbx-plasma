/*
 * plasma — classic three-wave plasma, tinted by a BLE-tunable color,
 * speed-scaled by a BLE-tunable parameter, with an Invert toggle that
 * flips the brightness gradient.
 *
 * History: this began life inside the rgb-sunglasses firmware repo as the
 * C++ wrapper's integration test, using integer wave approximations
 * because extensions had no math library. It moved here — a standalone
 * registry-shipped extension — when firmware v3.1.0 started exporting
 * single-precision libm, and the waves are real sinf() now.
 *
 * Written against the rgbx::Animation C++ wrapper; see the template's
 * examples/cpp-waves/main.cpp for a commented introduction to that API.
 */

#include <rgbx/rgbx_animation.h>

#include <math.h>

namespace {

constexpr float kTau = 6.2831853f;

/* Phase-accumulator wrap period, in ms.
 *
 * The three wave rates below (1.1, 0.7, 1.7 rad/s) are commensurate — 11 : 7 : 17
 * on a 0.1 rad/s grid — so all three phases return to their exact starting values
 * after t = 20*pi s = 62.8318530718 s. Wrapping the accumulator there is therefore
 * seamless; rounding the period to whole ms leaves a 2.5e-4 rad step once per
 * minute, which is 0.01 of one 8-bit level — invisible, and it does not accumulate.
 *
 * Wrapping is not cosmetic here, it is the performance contract. picolibc's sinf()
 * uses a cheap Cody-Waite argument reduction only while |x| <= 2^7*(pi/2) = 201.06
 * (newlib/libm/math/sf_rem_pio2.c); above that it enters __kernel_rem_pio2f, a
 * multi-precision Payne-Hanek reduction whose cost keeps GROWING with the
 * argument's exponent. This animation previously let t_ms_ free-run, so the three
 * waves crossed 201 at t ~= 111 s, 174 s and 279 s and the tick cost climbed a
 * staircase from 3.4 ms to 25 ms, overrunning the render interval — 11.1 ms in
 * those days; 33.3 ms since skalldri/rgb-sunglasses#376 — on essentially every
 * frame (skalldri/rgb-sunglasses#304).
 *
 * Bounded here, the largest argument is 1.7*62.83 + (fx+fy)*kTau = 118.7 — and
 * that holds for ANY Speed value, because the bound is on the accumulator rather
 * than on the rate. Same reasoning as the firmware's own tilt animation, which
 * wraps its integrated roll angle: fw/src/animations/tilt_animation.cpp.
 */
constexpr uint32_t kPeriodMs = 62832u; /* 20*pi s, to whole ms */

class Plasma : public rgbx::Animation {
   public:
    void tick(uint32_t dt_ms) override {
        /* speed is a percentage of nominal (50 == 1x).
         *
         * The multiply is widened to 64 bits because `*` and `/` share precedence and
         * associate left-to-right, so `dt_ms * paramU32(0) / 50u` multiplies FIRST, in
         * 32 bits. Speed is RGBX_PARAM_UINT32 and the host's write_param() memcpys the
         * value with no range check, so a client can write the full range: at the
         * dt_ms = 33 the firmware passes since skalldri/rgb-sunglasses#376,
         * Speed = 130150525 gives 4294967325, which wraps to 29, and 29/50 == 0 — the
         * animation freezes while the app shows maximum speed, with the response
         * non-monotonic above roughly 130M rather than clamped. (The old comment here
         * defended only the ADDITION, which was never the overflowing step.)
         *
         * Reducing the step before adding keeps the sum in 32 bits regardless of input.
         * __aeabi_uldivmod is on the SDK's allowed-symbols list, and this is once per
         * tick — negligible against 480 pixels x 3 sinf calls. */
        const uint32_t step = static_cast<uint32_t>(
            ((static_cast<uint64_t>(dt_ms) * paramU32(0)) / 50u) % kPeriodMs);
        t_ms_ = (t_ms_ + step) % kPeriodMs;
        const float t = static_cast<float>(t_ms_) * 0.001f;

        const uint32_t color = paramColor(1);
        const uint8_t cr = (color >> 16) & 0xFF;
        const uint8_t cg = (color >> 8) & 0xFF;
        const uint8_t cb = color & 0xFF;

        /* The far end of the gradient. Defaults to black, which is exactly what the
         * animation did before this parameter existed: the tint was scaled by the wave
         * value, so a trough rendered (0,0,0). Anyone who does not touch this sees no
         * change. */
        const uint32_t bg = paramColor(3);
        const uint8_t br = (bg >> 16) & 0xFF;
        const uint8_t bgc = (bg >> 8) & 0xFF;
        const uint8_t bb = bg & 0xFF;

        /* Invert flips the plasma's brightness gradient (light<->dark),
         * effectively inverting the palette while keeping the same tint. */
        const bool invert = paramBool(2);

        for (size_t y = 0; y < height(); y++) {
            const float fy = static_cast<float>(y) / static_cast<float>(height());
            for (size_t x = 0; x < width(); x++) {
                const float fx = static_cast<float>(x) / static_cast<float>(width());

                /* Three interfering waves in [-1, 1] each — the classic
                 * plasma recipe: one along x, one along y, one radial. */
                const float w = sinf(fx * kTau * 1.5f + t * 1.1f) +
                                sinf(fy * kTau + t * 0.7f) +
                                sinf((fx + fy) * kTau + t * 1.7f);

                /* [-3, 3] -> [0, 255]. */
                float v = (w + 3.0f) * (255.0f / 6.0f);
                if (invert) {
                    v = 255.0f - v;
                }
                const uint32_t vi = static_cast<uint32_t>(v);
                /* Interpolate background -> color instead of scaling the colour toward
                 * black. Signed intermediates because the background may be BRIGHTER than
                 * the tint (white background, dark tint), so the delta goes negative. */
                setPixel(x, y, lerp8(br, cr, vi), lerp8(bgc, cg, vi), lerp8(bb, cb, vi));
            }
        }
    }

   private:
    /* a + (b - a) * t / 255, in signed arithmetic. Integer maths on purpose: this runs
     * once per pixel per tick inside the extension's CPU budget.
     *
     * Left exactly as it was, deliberately. skalldri/rgb-sunglasses#3 proposed hoisting
     * `b - a` out of the pixel loops (it is a frame constant, so the call recomputes it
     * 40*12*3 = 1440 times per tick) and reworking the signed /255 into an unsigned one,
     * on the grounds that a signed divide forces sign correction where an unsigned one
     * strength-reduces to a multiply-high plus shift. Both were MEASURED and both are
     * wrong here: the compiler already hoists the invariant subtraction, and splitting
     * magnitude from direction to get the unsigned divide costs a per-pixel branch that
     * is dearer than the divide it saves. Measured on proto0, 3355 vs 2906 ticks at
     * default params: 3784 us/tick as written, 3937 us with that rewrite — 4% SLOWER —
     * and 158 vs 223 emitted instructions. Do not "optimize" this without measuring. */
    static uint8_t lerp8(uint8_t a, uint8_t b, uint32_t t) {
        const int32_t delta = static_cast<int32_t>(b) - static_cast<int32_t>(a);
        return static_cast<uint8_t>(static_cast<int32_t>(a) +
                                    delta * static_cast<int32_t>(t) / 255);
    }

    uint32_t t_ms_ = 0;
};

}  // namespace

/* "Background" is APPENDED rather than inserted next to "Color", so Speed/Color/Invert
 * keep the indices any existing `ext param <slot> <idx>` muscle memory and docs use.
 *
 * Persisted values reset either way: the firmware's parameter blob carries an
 * order-sensitive fingerprint over the manifest's param shape, and apply_blob() discards
 * a blob whose fingerprint no longer matches — which is what stops an old blob being
 * applied positionally to the wrong parameters. So upgrading to this build returns
 * Plasma's settings to the defaults below, once. */
RGBX_ANIMATION(Plasma, "Plasma", 40, 12, RGBX_PARAM("Speed", RGBX_PARAM_UINT32, 50),
               RGBX_PARAM("Color", RGBX_PARAM_COLOR, 0x00FF40FF),
               RGBX_PARAM("Invert", RGBX_PARAM_BOOL, 0),
               RGBX_PARAM("Background", RGBX_PARAM_COLOR, 0x00000000));
