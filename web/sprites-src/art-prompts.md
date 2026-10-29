# Tara Gala: art list and AI image prompts

**Owner vision (2026-10-28):** a Game Boy-era handheld RPG pixel UI ("Gen-1 monster-RPG feel"), with the whimsical, rubbery, friendly cartoon energy of modern adventure cartoons.

**Style only, original characters.** Don't put franchise names or character names in prompts. That avoids copyrighted look-alikes, and most generators refuse such requests anyway.

## How to generate so the set stays consistent
1. **Make the style reference sheet first** (prompt S0 below). Then attach it as a reference image, or "style reference", for every other prompt.
2. AI "pixel art" usually comes out at the wrong resolution, with blurry pixels. After generating:
   - downscale to the exact target size with **nearest-neighbour** scaling;
   - reduce to the palette below;
   - save as PNG with transparency.
   (Or drop the raw images in `~/tara-art/` and tell me: the team will clean and quantize them.)
3. Keep the file names exactly as listed. The app already references these names (placeholders ship first), so your art drops straight in.

## Palette (6 colours plus transparent). Paste into every prompt.
| Name | Hex | Use |
|---|---|---|
| Ink | `#1d2a24` | outlines, darkest shade |
| Forest | `#167856` | brand green, main shade |
| Leaf | `#5fb36b` | mid shade |
| Mint | `#cfe8c4` | light shade |
| Cream | `#fbf7ee` | highlights, paper |
| Sun | `#ffd65c` | accent (buses, stars, sparkles) |

**Shared style line** (append to every prompt):
> pixel art, crisp hard pixels, no anti-aliasing, no gradients, no blur, limited 6-colour palette (#1d2a24, #167856, #5fb36b, #cfe8c4, #fbf7ee, #ffd65c), 1px dark outline, transparent background, centred, 1990s handheld monster-RPG overworld sprite style, whimsical rounded cartoon proportions, original character, no text, no watermark

---

## S0. Style reference sheet (generate FIRST)
`ref-style-sheet.png`, 512×512 (reference only; not shipped)
> A pixel art style reference sheet for a cheerful Filipino travel game set in the mountain city of Baguio: four small chibi travellers (one adult, one student with a backpack, one senior with a sun hat and walking stick, one traveller using a wheelchair), a provincial coach bus, a jeepney, pine trees, a small market stall, a church, a park bench, a mountain path tile. Big heads, tiny bodies, friendly faces, rubbery noodle-like limbs. [shared style line]

## 1. Passengers (chibis)
**32×32 px** each (shown at 3× on phones). Front-facing idle, plus a 2-frame "bob" (frame 2 is 1px lower), plus one "spawn/wave" frame.

| File(s) | Prompt subject |
|---|---|
| `chibi-adult-idle-1.png`, `-idle-2.png`, `-wave.png` | an adult traveller with a small sling bag, cheerful |
| `chibi-student-idle-1.png`, `-idle-2.png`, `-wave.png` | a student with a big backpack and a lanyard ID |
| `chibi-senior-idle-1.png`, `-idle-2.png`, `-wave.png` | a senior with a sun hat and walking stick, kind smile |
| `chibi-pwd-idle-1.png`, `-idle-2.png`, `-wave.png` | a traveller in a wheelchair, sporty and confident, waving (dignified, not a stereotype) |

Prompt template:
> A single 32×32 chibi character sprite: {subject}, front view, standing idle (or "waving one hand, happy"), big head, small body, simple face. [shared style line]

Optional (only if easy): `chibi-{type}-walk-1..4.png`, a 4-frame walk cycle facing down, for the overworld.

## 2. Overworld tiles (the itinerary map)
**16×16 px** each (shown at 3 to 4×). They should tile seamlessly where noted.

| File | Subject |
|---|---|
| `tile-grass.png` | plain grass, seamless |
| `tile-path-straight.png` | dirt path running vertically, seamless top to bottom |
| `tile-path-corner.png` | dirt path turning from bottom to right |
| `tile-pine.png` | a single Benguet pine tree (tall, narrow) |
| `tile-mountain.png` | a small rounded mountain with a cloud |
| `tile-road.png` | an asphalt road segment with a centre line, seamless vertically |
| `tile-water.png` | a calm lake (seamless), for the Burnham Park lake |

Prompt template:
> A single 16×16 top-down overworld map tile: {subject}. Seamless tiling where applicable. [shared style line]

## 3. Places (map nodes)
**24×24 px** icons, top-down or three-quarter view.

| File | Subject |
|---|---|
| `place-terminal.png` | a small bus terminal building with a sign post (no text) |
| `place-lodging.png` | a cosy inn or hotel with a lit window |
| `place-park.png` | a park bench under a pine |
| `place-food.png` | a steaming food stall or bowl |
| `place-market.png` | a market stall with a striped awning and strawberries |
| `place-museum.png` | a small museum with columns |
| `place-viewpoint.png` | a lookout post with binoculars on a hill |
| `place-shopping.png` | a shop front with bags |
| `place-church.png` | a hillside church with a bell tower |
| `place-cafe.png` | a coffee cup with steam (mountain-coffee vibe) |
| `place-other.png` | a signpost with a star |

Prompt template:
> A single 24×24 pixel art map icon: {subject}, three-quarter top-down view, readable at small size. [shared style line]

## 4. Transport (bus legs and last-mile modes)
| File | Size | Subject |
|---|---|---|
| `vehicle-bus.png` | 48×24 | a Philippine provincial coach bus, side view, in a generic livery (Sun and Forest; **no real operator logos or names**) |
| `mode-jeep.png` | 24×16 | a colourful Philippine jeepney, side view, chrome and stripes, no text |
| `mode-taxi.png` | 24×16 | a small taxi, side view |
| `mode-walk.png` | 16×16 | footprints or a walking shoe |
| `mode-tricycle.png` | 24×16 | a Philippine motorcycle-sidecar tricycle |
| `mode-van.png` | 24×16 | a white passenger van |
| `mode-grab.png` | 24×16 | a generic ride-hailing car with a phone and pin icon (**no brand colours or logos**) |

Prompt template:
> A single pixel art sprite, {size} pixels: {subject}. [shared style line]

## 5. UI chrome (the handheld-RPG feel)
| File | Size | Subject |
|---|---|---|
| `ui-dialog-frame.png` | 24×24 (9-slice, 8px corners) | a classic RPG text-box border: rounded double-line frame, cream fill. It must 9-slice cleanly. |
| `ui-cursor.png` | 8×8 | a small right-pointing triangle menu cursor |
| `ui-star.png` | 8×8 | a sparkle or star (for "spawn" effects) |
| `ui-heart.png` | 8×8 | a small heart |
| `ui-badge-verified.png` | 16×16 | a round badge with a check mark ("checked" data) |

Prompt template (frame):
> A 24×24 pixel art 9-slice UI panel border for a retro handheld RPG dialog box: rounded double outline, 8px corners, flat cream fill, no shading. [shared style line, but WITHOUT "transparent background"]

## 6. Branding
| File | Size | Subject |
|---|---|---|
| `logo-wordmark.png` | 192×48 | the words "Tara Gala" in a chunky pixel title font with a small bus and pine motif. **This is the only asset with text.** |
| `icon-app.png` | 512×512 | the app icon: a chibi traveller on a pine-covered mountain path with a little bus, framed in a rounded square, Forest background (export a 192 version too). Keep the important art inside the central 80% (the maskable safe zone). |

---

## 7. Philippine decor (TG-45)
Owner request 2026-10-29, made with the same pipeline as the TG-33 art. **Decorative only:** the home header strip and the map's empty grass, never data UI. `deco-sun-stars` is the 8-ray sun with three stars, an emblem and **not the flag** (RA 8491): no flag or flag colours anywhere. The strawberry and the ube jar were dropped: they need red or purple, which the palette doesn't have.

| File | Size | Subject |
|---|---|---|
| `deco-sun-stars.png` | 24×24 | the 8-ray sun with three stars on a Forest disc: an emblem, never the flag |
| `deco-carabao.png` | 32×24 | a carabao (water buffalo), side view, with curved horns |
| `deco-bahay-kubo.png` | 24×24 | a bahay kubo: a nipa hut on stilts with a steep Leaf roof |
| `chibi-barong.png` | 32×32 | a chibi in a Cream barong tagalog (decor, not a passenger type) |
| `chibi-filipiniana.png` | 32×32 | a chibi in a Filipiniana dress with butterfly sleeves (decor, not a passenger type) |
| `deco-taho-vendor.png` | 32×32 | a taho vendor with two buckets on a shoulder pole, Sun hat |
| `deco-parol.png` | 16×16 | a star-shaped Christmas parol lantern |
| `deco-sampaguita.png` | 16×16 | sampaguita (jasmine) flowers |
| `deco-rice-terraces.png` | 24×24 | stepped mountain rice terraces |
| `deco-panagbenga-float.png` | 32×24 | a Panagbenga flower-festival float |

---

## Checklist for the owner
- [ ] S0 reference sheet first; reuse it as the style reference for everything else
- [ ] 4 chibis × 3 frames (12 files), plus optional walk cycles
- [ ] 7 tiles, 11 place icons, 7 vehicles and modes, 5 UI chrome pieces, 2 branding files
- [ ] Downscale with nearest-neighbour to the exact sizes and quantize to the palette (or hand the raw files to the team)
- [ ] Put them in `~/tara-art/` and tell the manager. The team replaces the SVG placeholders with no code change.
