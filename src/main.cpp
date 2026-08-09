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
 * staircase from 3.4 ms to 25 ms, overrunning the 11.1 ms render interval on
 * essentially every frame (skalldri/rgb-sunglasses#304).
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
         * No overflow: t_ms_ < kPeriodMs and the increment is at most
         * UINT32_MAX/50 == 85899345, so the sum stays well under 2^32. */
        t_ms_ = (t_ms_ + dt_ms * paramU32(0) / 50u) % kPeriodMs;
        const float t = static_cast<float>(t_ms_) * 0.001f;

        const uint32_t color = paramColor(1);
        const uint8_t cr = (color >> 16) & 0xFF;
        const uint8_t cg = (color >> 8) & 0xFF;
        const uint8_t cb = color & 0xFF;

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
                setPixel(x, y, static_cast<uint8_t>(cr * vi / 255u),
                         static_cast<uint8_t>(cg * vi / 255u),
                         static_cast<uint8_t>(cb * vi / 255u));
            }
        }
    }

   private:
    uint32_t t_ms_ = 0;
};

}  // namespace

RGBX_ANIMATION(Plasma, "Plasma", 40, 12, RGBX_PARAM("Speed", RGBX_PARAM_UINT32, 50),
               RGBX_PARAM("Color", RGBX_PARAM_COLOR, 0x00FF40FF),
               RGBX_PARAM("Invert", RGBX_PARAM_BOOL, 0));
