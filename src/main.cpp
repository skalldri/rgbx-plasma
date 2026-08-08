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

class Plasma : public rgbx::Animation {
   public:
    void tick(uint32_t dt_ms) override {
        /* speed is a percentage of nominal (50 == 1x). */
        t_ms_ += dt_ms * paramU32(0) / 50u;
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
