# Sprites (TG-33)

Art: AI-generated with fal nano-banana, owner-approved, 2026-10-29. 45 sprites and the app icon ship as PNG; the other 8 are hand-made SVG placeholders.

Still SVG: `ui-dialog-frame`, `ui-cursor`, `tile-grass`, `tile-path-straight`, `tile-path-corner`, `tile-road`, `tile-water`, `mode-van`. The AI versions were too noisy (`ui-dialog-frame`, `ui-cursor`) or had garbled pseudo-lettering in its windows (`mode-van`, UX review S2), or the map relies on these tiles being seamless and the map tests check them.

Names and sizes follow `web/sprites-src/art-prompts.md`. To swap in art: export PNGs at exactly the listed size (nearest-neighbour, 6-colour palette, transparent), copy them here with the same base name, add each name to `PNG_ART` in `web/src/lib/sprites.ts`, delete the matching `.svg`, and run the web tests.

New art drawn after TG-47 (TG-48's looks first) may use the 11-colour palette in `web/src/lib/pixelSvg.ts` (the 6 greens plus Flag Blue, Red and Yellow and two skin tones): list its names in `NEW_ART_11` in `web/src/lib/sprites.test.ts`. The skin tones are for art only, never UI. The sprites listed here keep the 6-colour palette.

Also delete that sprite's grid, `web/sprites-src/<name>.txt`: the tests expect a grid only for sprites that are still SVG.

App icon: export `icon-app.png` over `web/public/icon-512.png`, `icon-192.png` and `apple-touch-icon.png` (180×180).

## How the art was made
Generated with fal (nano-banana), using the adult chibi as the style reference so the set stays consistent: 46 calls (one redo for the app icon), about $1.85, on the owner's fal key. The prompts follow `web/sprites-src/art-prompts.md`. Only original characters are used, with no franchise names and no real operator logos.

Processing script: `process.py` in the owner's `~/tara-art/` (Pillow, so it stays outside the repo). For each raw image it:
- removes the white background by flood fill from the edges, then crops;
- snaps every pixel to the 6-colour palette (light warm tones go to Cream);
- downscales to the exact size by majority vote per target pixel;
- makes `idle-2` as `idle-1` moved 1px down;
- draws the app icon on a 64px grid, then upscales it nearest-neighbour to 512, 192 and 180.

After the UX review, a few pixels were fixed by hand: Leaf speckles in the senior's hair became Mint (with `idle-2` re-derived), and the Sun "beak" on the adult, student and senior wave mouths became Ink. The app icon was redone: a big chibi in front of the bus on a flat Leaf background, no inner frame, readable at 48px.

The tests check every PNG: its size, palette colours only, alpha 0 or 255, no metadata chunks, and at most 4 KB.

## Philippine decor (TG-45)
TG-45 Philippine decor: owner request 2026-10-29, same pipeline; decorative only. The 10 sprites appear only in the home header strip and on the map's empty grass, with `alt=""` inside `aria-hidden` containers. `chibi-barong` and `chibi-filipiniana` are decor, not passenger types.

`deco-sun-stars` is the 8-ray sun with three stars: an emblem, not the flag (RA 8491). It's used once, as the sun in the home strip's sky. Don't turn it into flag colours or add a flag.

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
| `mode-van` | 24×16 | SVG | placeholder: a long, boxy Cream van facing right with Ink windows |
| `mode-grab` | 24×16 | PNG | AI art: a generic ride-hailing car with a map pin (no brand colours) |
| `mode-walk` | 16×16 | PNG | AI art: footprints |
| `ui-dialog-frame` | 24×24 | SVG | placeholder: 9-slice frame, 8px corners: Ink double line with notched corners, Cream fill |
| `ui-cursor` | 8×8 | SVG | placeholder: a right-pointing Ink triangle menu cursor |
| `ui-star` | 8×8 | PNG | AI art: a sparkle |
| `ui-heart` | 8×8 | PNG | AI art: a small heart |
| `ui-badge-verified` | 16×16 | PNG | AI art: a round badge with a check mark |
| `logo-wordmark` | 192×48 | PNG | AI art: "Tara Gala" in a chunky pixel font with a small bus and pine |
| `deco-sun-stars` | 24×24 | PNG | AI art: the 8-ray sun with three stars on a Forest disc: an emblem, never the flag |
| `deco-carabao` | 32×24 | PNG | AI art: a carabao (water buffalo), side view, with curved horns |
| `deco-bahay-kubo` | 24×24 | PNG | AI art: a bahay kubo: a nipa hut on stilts with a steep Leaf roof |
| `chibi-barong` | 32×32 | PNG | AI art: a chibi in a Cream barong tagalog (decor, not a passenger type) |
| `chibi-filipiniana` | 32×32 | PNG | AI art: a chibi in a Filipiniana dress with butterfly sleeves (decor, not a passenger type) |
| `deco-taho-vendor` | 32×32 | PNG | AI art: a taho vendor with two buckets on a shoulder pole, Sun hat |
| `deco-parol` | 16×16 | PNG | AI art: a star-shaped Christmas parol lantern |
| `deco-sampaguita` | 16×16 | PNG | AI art: sampaguita (jasmine) flowers |
| `deco-rice-terraces` | 24×24 | PNG | AI art: stepped mountain rice terraces |
| `deco-panagbenga-float` | 32×24 | PNG | AI art: a Panagbenga flower-festival float |
| `hero-scene` | 320×123 | PNG | AI art: the landing hero scene (TG-46), drawn at 2x |
