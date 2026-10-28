# Sprites (TG-33)

Placeholders: hand-made pixel-art SVG, swap for AI art (TG-33 follow-up).

Names and sizes follow `web/sprites-src/art-prompts.md`. To swap in art: export PNGs at exactly the listed size (nearest-neighbour, 6-colour palette, transparent), copy them here with the same base name, add each name to `PNG_ART` in `web/src/lib/sprites.ts`, delete the matching `.svg`, and run the web tests.

Also delete that sprite's grid, `web/sprites-src/<name>.txt`: the tests expect a grid only for sprites that are still SVG.

App icon: export `icon-app.png` over `web/public/icon-512.png`, `icon-192.png` and `apple-touch-icon.png` (180×180).

Tool and terms: placeholders made by hand by the team, no third-party art. Record the AI tool and its terms here when the art lands.

## How the placeholders are made
Each SVG is generated from a text grid in `web/sprites-src/` (one letter per pixel: `I` Ink, `F` Forest, `L` Leaf, `M` Mint, `C` Cream, `S` Sun, `.` transparent). To change a pixel, edit the grid and run `node web/sprites-src/build.ts` from the repo root. Never hand-edit an SVG: the tests compare each one to its grid.

Sprites carry no `<title>`. The component that shows one sets its alt text (`alt=""` when a text label is next to it).

## Files
| File | Size (px) | Placeholder |
|---|---|---|
| `chibi-adult-idle-1` | 32×32 | Forest shirt, Leaf trousers, Sun sling bag with a diagonal strap; idle frame 1 |
| `chibi-adult-idle-2` | 32×32 | Forest shirt, Leaf trousers, Sun sling bag with a diagonal strap; idle frame 2 (whole sprite 1px lower) |
| `chibi-adult-wave` | 32×32 | Forest shirt, Leaf trousers, Sun sling bag with a diagonal strap; waving, open smile |
| `chibi-student-idle-1` | 32×32 | Leaf shirt, big Forest backpack wider than the body, Sun ID card on an Ink lanyard; idle frame 1 |
| `chibi-student-idle-2` | 32×32 | Leaf shirt, big Forest backpack wider than the body, Sun ID card on an Ink lanyard; idle frame 2 (whole sprite 1px lower) |
| `chibi-student-wave` | 32×32 | Leaf shirt, big Forest backpack wider than the body, Sun ID card on an Ink lanyard; waving, open smile |
| `chibi-senior-idle-1` | 32×32 | wide Sun sun-hat brim, Mint hair, Ink walking stick on the right, upright; idle frame 1 |
| `chibi-senior-idle-2` | 32×32 | wide Sun sun-hat brim, Mint hair, Ink walking stick on the right, upright; idle frame 2 (whole sprite 1px lower) |
| `chibi-senior-wave` | 32×32 | wide Sun sun-hat brim, Mint hair, Ink walking stick on the right, upright; waving, open smile |
| `chibi-pwd-idle-1` | 32×32 | seated in a wheelchair: Ink wheel rings with Cream hubs, Forest top, upright; idle frame 1 |
| `chibi-pwd-idle-2` | 32×32 | seated in a wheelchair: Ink wheel rings with Cream hubs, Forest top, upright; idle frame 2 (body above the seat 1px lower) |
| `chibi-pwd-wave` | 32×32 | seated in a wheelchair: Ink wheel rings with Cream hubs, Forest top, upright; waving, open smile |
| `tile-grass` | 16×16 | Mint grass with Leaf tufts, none on an edge (seamless) |
| `tile-path-straight` | 16×16 | Cream path at columns 5-10, running vertically, Leaf pebbles; rows 0 and 15 match |
| `tile-path-corner` | 16×16 | the path enters from the bottom (columns 5-10) and leaves right (rows 5-10) |
| `tile-pine` | 16×16 | a tall, narrow Benguet pine: Forest tiers, Leaf highlight, Ink trunk and outline |
| `tile-mountain` | 16×16 | a rounded Leaf hill with Forest shade, a small Cream cloud with an Ink outline |
| `tile-road` | 16×16 | an Ink road at columns 2-13, Cream centre dashes, grass edges; repeats vertically |
| `tile-water` | 16×16 | Forest water with Mint wave dashes, seamless on all four edges |
| `place-terminal` | 24×24 | a low Cream building with a Forest roof, a tall Ink post with a blank Sun sign |
| `place-lodging` | 24×24 | a pitched Forest roof, Cream walls, one Sun lit window and a door |
| `place-park` | 24×24 | a Leaf bench under a small pine |
| `place-food` | 24×24 | a Cream bowl with an Ink rim and 3 rising Cream steam lines |
| `place-market` | 24×24 | a stall with a striped Sun and Cream awning and Leaf produce on the counter |
| `place-museum` | 24×24 | a Forest pediment over 3 Cream columns on a step |
| `place-viewpoint` | 24×24 | a Leaf hill with an Ink post holding Cream binoculars |
| `place-shopping` | 24×24 | a Sun shopping bag with an Ink handle |
| `place-church` | 24×24 | a Cream hillside church with a bell tower and an arched Ink door |
| `place-cafe` | 24×24 | a Cream cup with a Forest band and 2 steam lines |
| `place-other` | 24×24 | a signpost with a Sun star |
| `vehicle-bus` | 48×24 | a long Sun coach facing right: Forest stripe, Cream windows, Ink wheels and outline |
| `mode-jeep` | 24×16 | a jeepney facing right: long hood, Cream body, Forest and Sun stripes, open back |
| `mode-taxi` | 24×16 | a small Cream car facing right with a Sun roof light |
| `mode-tricycle` | 24×16 | a motorcycle (Ink) with a Forest sidecar cab, facing right |
| `mode-van` | 24×16 | a long, boxy Cream van facing right with Ink windows |
| `mode-grab` | 24×16 | a generic Cream car facing right with a Sun map pin above the roof (no green body) |
| `mode-walk` | 16×16 | two Ink shoe prints, offset |
| `ui-dialog-frame` | 24×24 | 9-slice frame, 8px corners: Ink double line with notched corners, Cream fill |
| `ui-cursor` | 8×8 | a right-pointing Ink triangle menu cursor |
| `ui-star` | 8×8 | a 4-point Sun sparkle with an Ink outline |
| `ui-heart` | 8×8 | a Sun heart with an Ink outline |
| `ui-badge-verified` | 16×16 | a Forest pixel circle with a Cream check |
| `logo-wordmark` | 192×48 | "Tara Gala" in Forest pixel letters with an Ink outline, a small Sun bus and a pine |
