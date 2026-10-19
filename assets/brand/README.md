# Testlane brand assets

The Testlane "TL monogram" mark and wordmark. The wordmark is Outfit (weight 800) converted to outlines, so no font is needed at runtime.

| File | Use |
| --- | --- |
| `testlane-logo-light.svg` / `testlane-logo-dark.svg` | Horizontal logo for light / dark backgrounds (`light` and `dark` name the background, not the ink) |
| `testlane-mark-*.svg` | Mark only, for compact places (min 24 px) |
| `testlane-wordmark-*.svg` | Wordmark only |
| `*-mono-black.svg` / `*-mono-white.svg` | Single-color versions |
| `icons/favicon.svg` | Adaptive favicon (ink switches with `prefers-color-scheme`) |
| `icons/favicon.ico` | Opaque fallback favicon (16/32/48) |
| `icons/icon-180.png` | Apple touch icon |
| `icons/icon-192.png`, `icons/icon-512.png` | App icons (`purpose: "any"`, not maskable) |
| `social/testlane-social-1200x630.png` | Social preview card (alt text "Testlane logo") |
| `brand-tokens.json` / `.css` | Colors: midnight `#20283D`, blue `#5575E7`, paper `#F4F6FC`, white `#FFFFFF` |

Rules: keep the aspect ratio, leave at least 24 units of clear space on the 192-unit grid, minimum 144 px wide for the horizontal logo, never recolor or stretch the files with CSS. Use `alt="Testlane"` on a standalone logo and `alt=""` when a label next to it already names the link.

Licensing: the Outfit font is under the SIL Open Font License 1.1 (`licenses/Outfit-OFL.txt`); see `licenses/PROVENANCE.md`. No trademark clearance is claimed.
