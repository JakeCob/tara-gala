# Sprites (TG-33)

Art: AI-generated with fal nano-banana, owner-approved, 2026-10-29. 36 sprites and the app icon ship as PNG; the other 7 are hand-made SVG placeholders.

Still SVG: `ui-dialog-frame`, `ui-cursor`, `tile-grass`, `tile-path-straight`, `tile-path-corner`, `tile-road`, `tile-water`. The AI versions were too noisy (`ui-dialog-frame`, `ui-cursor`), or the map relies on these tiles being seamless and the map tests check them.

Names and sizes follow `web/sprites-src/art-prompts.md`. To swap in art: export PNGs at exactly the listed size (nearest-neighbour, 6-colour palette, transparent), copy them here with the same base name, add each name to `PNG_ART` in `web/src/lib/sprites.ts`, delete the matching `.svg`, and run the web tests.

Also delete that sprite's grid, `web/sprites-src/<name>.txt`: the tests expect a grid only for sprites that are still SVG.

App icon: export `icon-app.png` over `web/public/icon-512.png`, `icon-192.png` and `apple-touch-icon.png` (180×180).

## How the art was made
Generated with fal (nano-banana), using the adult chibi as the style reference so the set stays consistent: 45 calls, about $1.80, on the owner's fal key. The prompts follow `web/sprites-src/art-prompts.md`. Only original characters are used, with no franchise names and no real operator logos.

Processing script: `process.py` in the owner's `~/tara-art/` (Pillow, so it stays outside the repo). For each raw image it:
- removes the white background by flood fill from the edges, then crops;
- snaps every pixel to the 6-colour palette (light warm tones go to Cream);
- downscales to the exact size by majority vote per target pixel;
- makes `idle-2` as `idle-1` moved 1px down;
- draws the app icon on a 64px grid, then upscales it nearest-neighbour to 512, 192 and 180.

The tests check every PNG: its size, palette colours only, alpha 0 or 255, no metadata chunks, and at most 4 KB.

## How the placeholders are made
Each SVG is generated from a text grid in `web/sprites-src/` (one letter per pixel: `I` Ink, `F` Forest, `L` Leaf, `M` Mint, `C` Cream, `S` Sun, `.` transparent). To change a pixel, edit the grid and run `node web/sprites-src/build.ts` from the repo root. Never hand-edit an SVG: the tests compare each one to its grid.

Sprites carry no `<title>`. The component that shows one sets its alt text (`alt=""` when a text label is next to it).

## Files
| File | Size (px) | Format | What it shows |
|---|---|---|---|
| `chibi-adult-idle-1` | 32×32 | PNG | AI art: an adult traveller with a small sling bag; idle frame 1 |
| `chibi-adult-idle-2` | 32×32 | PNG | AI art: an adult traveller with a small sling bag; idle frame 2 (idle-1 moved 1px down) |
| `chibi-adult-wave` | 32×32 | PNG | AI art: an adult traveller with a small sling bag; waving |
| `chibi-student-idle-1` | 32×32 | PNG | AI art: a student with a big backpack and a lanyard ID; idle frame 1 |
| `chibi-student-idle-2` | 32×32 | PNG | AI art: a student with a big backpack and a lanyard ID; idle frame 2 (idle-1 moved 1px down) |
| `chibi-student-wave` | 32×32 | PNG | AI art: a student with a big backpack and a lanyard ID; waving |
| `chibi-senior-idle-1` | 32×32 | PNG | AI art: a senior with a sun hat and walking stick; idle frame 1 |
| `chibi-senior-idle-2` | 32×32 | PNG | AI art: a senior with a sun hat and walking stick; idle frame 2 (idle-1 moved 1px down) |
| `chibi-senior-wave` | 32×32 | PNG | AI art: a senior with a sun hat and walking stick; waving |
| `chibi-pwd-idle-1` | 32×32 | PNG | AI art: a traveller in a wheelchair, waving and confident; idle frame 1 |
| `chibi-pwd-idle-2` | 32×32 | PNG | AI art: a traveller in a wheelchair, waving and confident; idle frame 2 (idle-1 moved 1px down) |
| `chibi-pwd-wave` | 32×32 | PNG | AI art: a traveller in a wheelchair, waving and confident; waving |
| `tile-grass` | 16×16 | SVG | placeholder: Mint grass with Leaf tufts, none on an edge (seamless) |
| `tile-path-straight` | 16×16 | SVG | placeholder: Cream path at columns 5-10, running vertically, Leaf pebbles; rows 0 and 15 match |
| `tile-path-corner` | 16×16 | SVG | placeholder: the path enters from the bottom (columns 5-10) and leaves right (rows 5-10) |
| `tile-pine` | 16×16 | PNG | AI art: a tall, narrow Benguet pine |
| `tile-mountain` | 16×16 | PNG | AI art: a small rounded mountain with a cloud |
| `tile-road` | 16×16 | SVG | placeholder: an Ink road at columns 2-13, Cream centre dashes, grass edges; repeats vertically |
| `tile-water` | 16×16 | SVG | placeholder: Forest water with Mint wave dashes, seamless on all four edges |
| `place-terminal` | 24×24 | PNG | AI art: a small bus terminal with a blank sign post |
| `place-lodging` | 24×24 | PNG | AI art: a cosy inn with a lit window |
| `place-park` | 24×24 | PNG | AI art: a park bench under a pine |
| `place-food` | 24×24 | PNG | AI art: a steaming food bowl |
| `place-market` | 24×24 | PNG | AI art: a market stall with a striped awning |
| `place-museum` | 24×24 | PNG | AI art: a small museum with columns |
| `place-viewpoint` | 24×24 | PNG | AI art: a lookout post with binoculars on a hill |
| `place-shopping` | 24×24 | PNG | AI art: a shop front with bags |
| `place-church` | 24×24 | PNG | AI art: a hillside church with a bell tower |
| `place-cafe` | 24×24 | PNG | AI art: a coffee cup with steam |
| `place-other` | 24×24 | PNG | AI art: a signpost with a star |
| `vehicle-bus` | 48×24 | PNG | AI art: a provincial coach bus, side view, generic Sun and Forest livery |
| `mode-jeep` | 24×16 | PNG | AI art: a jeepney, side view, no text |
| `mode-taxi` | 24×16 | PNG | AI art: a small taxi, side view |
| `mode-tricycle` | 24×16 | PNG | AI art: a motorcycle-sidecar tricycle |
| `mode-van` | 24×16 | PNG | AI art: a white passenger van |
| `mode-grab` | 24×16 | PNG | AI art: a generic ride-hailing car with a map pin (no brand colours) |
| `mode-walk` | 16×16 | PNG | AI art: footprints |
| `ui-dialog-frame` | 24×24 | SVG | placeholder: 9-slice frame, 8px corners: Ink double line with notched corners, Cream fill |
| `ui-cursor` | 8×8 | SVG | placeholder: a right-pointing Ink triangle menu cursor |
| `ui-star` | 8×8 | PNG | AI art: a sparkle |
| `ui-heart` | 8×8 | PNG | AI art: a small heart |
| `ui-badge-verified` | 16×16 | PNG | AI art: a round badge with a check mark |
| `logo-wordmark` | 192×48 | PNG | AI art: "Tara Gala" in a chunky pixel font with a small bus and pine |
