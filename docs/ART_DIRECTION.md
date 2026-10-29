# Cosmos: Art Direction (Gate 1, one star system)

Status: Gate 1 spec. Scope is a single star system rendered in every state.
The galaxy, arms, edge markers and the time scrubber come after the owner approves this look.

## 1. The idea in one paragraph

**"Cold machinery, one warm alarm."** The universe is built from cold light: ice
blue, white, periwinkle, violet, teal and grey. Things look like precision
instruments that happen to be made of plasma, not like a fantasy painting. Warm
color is close to absent. That is why the one electric neon orange object, the
**NEEDS ME** quasar, works like a fire alarm in a server room: you can't miss it
from anywhere. Every glow has a job. If something moves, the data made it move.
Nothing loops for decoration.

Three rules that override taste:

1. **Orange is reserved.** `#FF5F1F` and any saturated color in the hue band
   8°–35° (saturation > 0.45) is used only by the quasar. QA checks the palette
   module for this, and so does a `?mono=1` grayscale pass in Gate 1.
2. **Periodic brightness is reserved.** Only the quasar *pulses*. No other object
   may modulate its brightness periodically by more than 4%. Star surfaces boil
   with aperiodic fbm noise, and the beacon is steady.
3. **Linear axial shapes are reserved.** Only the quasar has twin jets: two
   opposed beams along one axis. Nothing else draws a straight line through the
   star. Ship trails are short curved ribbons, never longer than 2.5 units.

## 2. Palette (linear-HDR intent; hex given in sRGB)

| Token | Hex | Used by | Meaning |
|---|---|---|---|
| `NEEDS_ME` | **`#FF5F1F`** | quasar halo, jets, jet knots | needs me now (exclusive) |
| `NEEDS_ME_CORE` | `#FFF1E6` | quasar core hot-white | (exclusive to quasar) |
| `VOID` | `#02030A` | clear color / deepest space | none |
| `DUST_VIOLET` | `#1B1238` | galactic dust band | backdrop (galaxy context) |
| `DUST_TEAL` | `#0B2A33` | galactic dust band, secondary | backdrop |
| `STAR_FILL_0` | `#CFE0FF` | star at contextFill 0 | empty context |
| `STAR_FILL_50` | `#FFF8F0` | star at contextFill 0.5 | half full |
| `STAR_FILL_80` | `#FFB8C0` | star at contextFill 0.8 | getting full (rose, not orange) |
| `STAR_FILL_100` | `#E3263F` | star at contextFill 1.0 | context full (crimson) |
| `DISK_INNER` | `#E8F1FF` | accretion disk inner edge | working |
| `DISK_OUTER` | `#6A7CFF` | accretion disk outer edge | working |
| `DISK_DOPPLER` | `#BFE6FF` | approaching-side boost | working |
| `MY_MOVE` | `#3EE6C8` | beacon ring | my move (waiting for my message) |
| `THINK_DEEP` | `#2C1A7A` | nebula body | thinking |
| `THINK_VIOLET` | `#6B4BFF` | nebula lit regions | thinking |
| `THINK_FILAMENT` | `#9AE6FF` | nebula filaments | thinking |
| `SHIP_TOOL` | `#A8ECFF` | tool-call ships and trails | a tool call |
| `SHIP_AGENT` | `#8CFFC1` | subagent ships and trails | a subagent |
| `ERROR` | `#FF3D9A` | flare arcs, storm mottling | tool error |
| `PHOTON_RING` | `#FFF5E8` | black hole photon ring | compaction |
| `WHITE_HOLE` | `#FFFFFF` | eruption core | new session |
| `WHITE_HOLE_EDGE` | `#B8F3FF` | eruption shock rings | new session |
| `REMNANT_CORE` | `#8C8FB3` | crashed remnant point | crashed |
| `REMNANT_SHARD` | `#3A3F5C` | crashed shell shards | crashed |
| `CINDER` | `#3A3E4A` | idle-dead star body | idle for a day |
| `CINDER_RIM` | `#5B6378` | idle-dead limb rim | idle for a day |
| `ROCK` | `#6E7486` | asteroid albedo | tokens |
| `ROCK_SPEC` | `#C9D2E6` | asteroid glint | tokens |
| Planet set | `#8FA3C8` `#A9C7B8` `#B9A7E0` `#D6E4F0` `#7F93A8` `#9BB8D3` | planets by hash of file id | files |

**Context-fill ramp.** `starColor(fill)` interpolates the four `STAR_FILL_*`
stops in **OKLab** (not RGB). It passes from white through pale rose to
crimson, so it never crosses the orange band. Above 1.0 (overflow before a
compaction) it clamps to `STAR_FILL_100` and the corona tightens.

**Brightness ladder** (peak linear luminance before tone mapping). Builders
must stay inside these. The quasar is always the brightest thing on screen.

| Object | Peak HDR luminance |
|---|---|
| Quasar core (pulse crest) | 30 (trough 14) |
| Quasar jets | 6–10 |
| White hole eruption (transient, ≤ 0.6 s) | 12 |
| Working star surface / corona | 6 / 3 |
| Error flare (transient) | 7 |
| Photon ring | 5 |
| Beacon ring | 2.5 |
| Ships (engine glow) | 3 |
| Thinking nebula | 0.6 |
| Planets (lit) | ≤ 0.9 |
| Remnant | 0.35 |
| Idle star at idleFor = 1 | 0.12 |

## 3. Objects: look, shader approach and motion

Units are star radii (see CONTRACT §1). The star radius is 1.0, the disk spans
1.4–3.2, planets orbit at 4–8.5, the belt sits at 9.5 to about 14, and
subagent orbits are at 16–20.

### 3.1 Star (working / my-move / thinking / idle base body)
- **Surface:** an icosphere (detail 5) with a custom `ShaderMaterial`. Domain-warped
  3D fbm (5 octaves at high quality, 3 at low) sampled on the object-space
  normal, with the domain slowly rotated (0.04 rad/s), produces **granulation
  cells** (a ridged fbm term) and larger **supergranules**. Color is
  `starColor(contextFill)` multiplied by a temperature term from the noise
  (cells are hotter than lanes by 15%).
- **Limb darkening:** `I(μ) = 1 − 0.6·(1 − μ) − 0.15·(1 − μ)²`, where μ = N·V.
- **Corona:** a camera-facing billboard quad (4× star radius). It uses a radial
  falloff `exp(−k·(r−1))` modulated by an angular fbm streamer term that drifts
  slowly outward. Additive. Corona size encodes `activity` (k goes from 3.2 down
  to 1.6).
- **Activity:** `activity` drives surface turbulence speed (0.2 to 1.0) and
  luminance (from ×0.7 to ×1.0 of the working peak).
- **Idle decay:** `idleFor` (0 to 1) drives luminance as
  `lerp(1, 0.02, smoothstep(0,1,idleFor)^0.7)`. Saturation falls toward grey,
  granulation slows to near-frozen, and the corona shrinks to nothing. At 1.0
  the star becomes `CINDER` with a thin `CINDER_RIM` limb: a dead coal that is
  still there. **The system never moves**: no position or scale change from idle.

### 3.2 Accretion disk (working)
- A flat annulus (`RingGeometry`, 128 × 8 segments, 1.4–3.2), additive and
  double-sided, tilted 12° off the system's XZ plane, so the disk reads as a disk
  from the default camera.
- **Differential rotation:** Keplerian angular velocity `ω(r) ∝ r^−1.5`. The shader
  rotates polar UVs by `ω(r)·t`, so inner gas laps outer gas. Streaky texture
  comes from fbm in (log r, θ) space stretched 8:1 along θ.
- **Doppler beaming:** `boost = (1 + β·cosφ)^3`, where φ is the angle between
  local orbital velocity and the view direction projected into the disk plane,
  with β = 0.35. The approaching side brightens and shifts toward `DISK_DOPPLER`.
  The receding side dims toward deep `DISK_OUTER`.
- Inner-edge temperature: `DISK_INNER` at 1.4, falling to `DISK_OUTER` at 3.2,
  with an alpha feather at both edges.
- `activity` sets spin speed (×0.3 to ×1.0) and opacity. When the session leaves
  working, the disk **spins down over 3 s** (angular speed decays exponentially)
  and fades to a faint ghost (alpha 0.08). It does not vanish, because the
  session still has history.

### 3.3 Quasar: NEEDS ME (exclusive)
How it stays unmistakable, even with no color:
- **Shape:** two collimated jets along the star's local +Y/−Y, each 14 units long,
  about 4× the system's other radial extents. No other object has a long straight
  axis.
- **Motion 1, pulse:** core luminance `L = 14 + 16·pulse(t)`, where
  `pulse = pow(0.5 + 0.5·sin(2π t / 2.4), 4)`. That gives a 2.4 s cycle: a quick
  swell and a long exhale. It is the only periodic brightness in the universe.
- **Motion 2, jet knots:** bright knots travel outward along each jet at 6 u/s, a
  new knot every pulse crest. The pulse visibly "fires" down the jets.
- **Color:** `NEEDS_ME` halo (2.2× star radius) and jets, with a `NEEDS_ME_CORE`
  white-hot center. The context color survives as a thin photosphere tint under
  the halo.
- **Jets shader:** two open cones (`CylinderGeometry`, radius 0.08 at the base
  widening to 0.9, 48 × 64 segments), additive, depth-write off. Intensity is
  `fresnelFade(N·V)^1.5 × axialFalloff × flowNoise`. `flowNoise` is 3D fbm
  sampled at `(x, y − 3t, z)` so turbulence streams outward. An inner core cone
  (radius ×0.35) doubles brightness on the axis. Together they fake a volumetric
  beam from any angle. A faint helical twist (rotate noise domain by `y·0.4`)
  keeps it alive.
- **Accretion disk in needs-me:** it stays, but its spin pauses to 15%. The system
  is waiting.
- **Ignition:** 0.35 s halo flash in, then jets extend from 0 to 14 over 0.6 s
  (ease-out-expo). **Release:** the jets retract over 1.2 s and the halo fades
  over 1.0 s.
- Galaxy phase note: the quasar is drawn in the top depth layer, unaffected by
  atmospheric contrast loss, and later gets an edge-of-screen marker.

### 3.4 Beacon: MY MOVE
- A thin, flat ring (torus, tube 0.025) at 1.9× star radius, in the plane
  perpendicular to the camera-facing axis (always seen as a circle), `MY_MOVE`
  teal, at a **constant** luminance of 2.5.
- Motion: one short brighter arc segment (30°) travels around the ring once
  every 12 s, like a radar sweep. Brightness of the ring overall never changes.
- It is calm, round and closed (a circle, not a line, and no pulse), so it reads
  as clearly lower priority than the quasar, with or without color.
- In: 1.5 s fade. Out: 0.8 s fade.

### 3.5 Thinking nebula (conditional)
Shown **only if the data layer proves it can tell thinking apart from working**
(for example from `thinking` content blocks streamed in the transcript). If it
can't, `mode: 'thinking'` is never emitted, and Gate 1 shows this scene with a
"conditional" note.
- 24 camera-facing sprites in one instanced draw, scattered in a flattened
  shell with radius 2.5–6. Each fragment samples **world-space 3D fbm** (4
  octaves), so sprites don't read as flat cards, with a soft depth fade against
  the star. Colors go `THINK_DEEP` → `THINK_VIOLET`, and ridged noise produces
  thin `THINK_FILAMENT` filaments.
- Swirl: the noise domain rotates around Y at `0.25/r` rad/s (differential, like
  a slow galaxy), plus a slow curl offset. It reads as "the mind turning".
- Budget: about 24 sprites at ≤ 30% screen coverage in the Gate 1 frame, a
  4-octave max, rendered at full resolution. If the GPU is over budget at
  quality `low`, drop to 12 sprites and 3 octaves.
- In: 2 s. Out: 3 s.

### 3.6 Asteroid belt: tokens
- One `InstancedMesh` of icosahedron rocks (detail 1). Vertex displacement uses
  3 hashed bumps per instance, so no two rocks match. Lambert-style shading from
  the star, plus a `ROCK_SPEC` glint. Rocks tumble slowly (per-instance axis).
- **Count** = `clamp(round(420·log2(1 + tokens/10_000)), 0, maxRocks)`, where
  maxRocks is 6000 (high), 3000 (medium) or 1500 (low).
- **Width:** inner radius 9.5, width `1.2 + 1.4·log10(1 + tokens/50_000)`
  (capped at 4.5). Vertical thickness grows with width (0.15 to 0.6).
- Orbit: Keplerian drift in the vertex shader, driven by `t`. Positions are
  never re-uploaded per frame.
- **Swallow:** after a compaction, a fraction of rocks in a 70° sector around the
  black hole are flagged. They spiral in along a log-spiral path and are removed.
  The belt then rebuilds at the lower post-compaction density, with a 2 s
  re-equilibrate (rocks ease to new radii) that leaves a visibly thinner, tidier
  orbit.

### 3.7 Planets: files
- One planet per file the session touched. When zoomed out (galaxy phase), one
  per folder. One `InstancedMesh` of spheres with a shader: banded or rocky fbm
  style chosen by `hash(fileId)`, base color from the planet set, terminator
  lighting from the star, and a thin Fresnel atmosphere.
- **Radius** = `0.12 + 0.09·log2(1 + edits)`, capped at 0.6. Growth eases over 0.8 s.
- Orbit radius and phase come from `hash(fileId)`, so they are stable across
  reloads, in 4–8.5, with a small inclination (≤ 6°). Kepler speed is slow
  (one orbit takes 60–200 s).
- **Touch ping:** when a ship arrives, a rim ring on the planet brightens
  for 0.4 s (`SHIP_TOOL`). An edit also bumps the radius.
- At most 24 planets per system. Beyond that, the least-recently-touched files
  merge into their folder planet.

### 3.8 Ships: tool calls, convoys, subagents
- **Tool-call ship:** a tiny dart (an 8-triangle elongated bipyramid, length
  0.18), instanced, `SHIP_TOOL`, with an engine glow sprite and a **ribbon trail**
  (12 segments, 1.5 units, fading). All trails go in one dynamic
  `BufferGeometry`, as one draw.
- Flight: launch from the star surface toward the target planet along a
  quadratic Bézier that arcs 15% out of plane. Duration is `1.2 + 0.08·distance`
  s with ease-in-out. On arrival the ship is absorbed (it shrinks into the planet
  ping). Tool calls with no file target fly a short 1.2 s loop out and back to
  the star.
- **Convoy:** if ≥ 4 tool calls target the same planet within 1.0 s, or more
  than 16 ships are in flight, new launches merge into a **convoy**: one lead
  ship plus up to 4 formation followers (a V shape). The trail is wider
  (×1 + 0.25 per merged call, capped at ×3). Calm under load.
- **Subagent ship:** larger (length 0.35), `SHIP_AGENT` mint, twin engine glows,
  2.5-unit trail. Departs over 2 s to its own tilted orbit at radius 16–20
  (from a hash of its id), circles while active (period 20 s), and returns over
  2.5 s when `endT` is set, then docks into the star with a small mint ripple.
- Budget: 64 ships plus 64 trails per system (one draw each).

### 3.9 Black hole: compaction
Shown only where the transcript records a compaction.
- Forms at a point on the belt's mid-radius (angle from `hash(compaction.t)`).
- **Render:** one billboard quad (12 units wide) with a shader that, for each
  pixel, computes a deflected ray direction using a thin-lens approximation
  (`α = 4M/b`, plus a second image term for the Einstein ring) and samples
  `env.starfieldCube`, the pre-rendered background cubemap. That gives **real
  lensing of the background**, an **Einstein ring** where b ≈ θE, a pure black
  **event horizon** disk, and a thin `PHOTON_RING` (Gaussian ring at 1.5× horizon
  radius, luminance 5). Foreground objects aren't lensed. That's an accepted
  simplification for budget.
- Swallowed rocks get a streak-stretch in the belt shader as they cross the
  photon ring.
- **Timing (9 s total):** form 1.5 s (mass M grows from 0, lensing blooms in),
  swallow 4 s (belt sector spirals in), collapse 1.5 s (M → 0 with one bright
  photon-ring flash), settle 2 s (belt re-equilibrates).

### 3.10 White hole: new session
- An inverted black hole: everything flows **out**. A white point appears (0.3 s),
  then **erupts**. Three `WHITE_HOLE_EDGE` shock rings expand outward (spherical
  shells as additive Fresnel spheres, radius 0 → 10), and 300 GPU particles
  stream outward from the core (one `Points` draw). Peak luminance is 12 for
  ≤ 0.6 s.
- **Timing (4 s):** 0.0–0.3 s seed, 0.3–1.5 s eruption, 1.5–3.0 s the star
  condenses at the center from the outflow (its radius eases 0 → 1), 3.0–4.0 s
  the white hole fades and the star settles into its real mode.
- This is the only object whose motion is entirely outward and radially
  symmetric, the visual inverse of the black hole.

### 3.11 Flares: errors
- **Single flare:** a magnetic-loop prominence. A tube along a half-ellipse arc
  anchored on two surface points 25° apart, rising 0.6 radii. Additive `ERROR`
  magenta core with white-hot base points, and noise along the tube. Life is
  1.2 s: rise 0.25 s, hang, then snap and fade.
- **Flare storm** (≥ 3 errors within 20 s): 3–6 overlapping loops spread across
  the surface, magenta mottling on the star's surface shader (uniform
  `stormLevel`), and a jittered corona. It holds until 10 s after the last
  error, then decays over 2 s.
- Instanced tubes, 8 maximum per system, one draw.

### 3.12 Crashed remnant
- **Collapse (2.5 s):** the star implodes (radius 1 → 0.22, ease-in-cubic), with a
  brief flash (luminance 4, 0.2 s), and one expanding shell (radius 0 → 4) that
  **freezes** into 40 dim `REMNANT_SHARD` fragments hanging in place.
- **Rest:** a dim `REMNANT_CORE` point (0.35) inside a broken shell. No disk, no
  corona, no motion. The shards make it read differently from an idle-dead
  cinder (a whole coal) without color. Belt and planets remain but desaturate
  60%.

## 4. Transitions (all times in seconds)

| From → to | Duration | Behavior |
|---|---|---|
| any → needs-me | 0.35 + 0.6 | halo flash, then jets extend |
| needs-me → any | 1.2 | jets retract; halo fades over 1.0 s |
| any → working | 1.0 | disk spins up; luminance rises |
| working → my-move | 3.0 / 1.5 | disk spin-down / beacon fade-in |
| my-move → working | 0.8 | beacon fades; disk spins up |
| any → thinking | 2.0 | nebula fades in; disk at 40% spin |
| thinking → any | 3.0 | nebula fades out |
| idleFor changes | 1.5 damping | continuous, never jumps |
| compaction event | 9.0 | form 1.5 / swallow 4 / collapse 1.5 / settle 2 |
| error | 1.2 | single flare |
| storm | until last error + 10, then 2.0 decay | |
| → crashed | 2.5 | collapse, then remnant |
| birth (`bornAt`) | 4.0 | white hole sequence |
| ship | 1.2 + 0.08·d | Bézier flight |
| subagent | 2.0 out / 2.5 back | orbit while active |
| planet growth | 0.8 | ease to the new radius |
| generic crossfade | 0.8 | ease-in-out-cubic |

All continuous values ease with frame-rate-independent damping:
`x += (target − x)·(1 − exp(−dt/τ))`.

## 5. Post-processing and tone

- Renderer: `outputColorSpace = SRGBColorSpace`, `toneMapping =
  ACESFilmicToneMapping`, `toneMappingExposure = 0.95`. Tone mapping is applied
  by `OutputPass`, not on materials (materials leave `toneMapped` at default,
  and the composer renders in linear HDR).
- Composer render targets: `HalfFloatType`.
- `UnrealBloomPass`: strength **0.9**, radius **0.55**, threshold **1.0** (linear).
  Only HDR > 1 blooms: stars, the quasar, flares, rings and ship glows. Planets
  and rocks stay crisp.
- Quality `low`: bloom resolution halved, star 3 octaves, belt 1500.
- `?mono=1` debug: a luminance-only `ShaderPass` before `OutputPass`, to prove
  that states read without color.
- No vignette, chromatic aberration or film grain. Clean glass.
- Depth of field is a galaxy-phase item (dive-in focus), not Gate 1.

## 6. Background

- **Starfield:** 12,000 points in one draw, on three shells (radius 900, 1400 and
  2000) for subtle parallax. Magnitudes follow a power law (most are faint, about
  40 are bright). Colors range blue-white to white to pale-cream (saturation <
  0.2, never orange). Size has distance attenuation and a 1.5 px floor. **No
  twinkle**, because static keeps the GPU quiet.
- **Galactic dust:** an inverted sphere (radius 2500) with a shader painting a
  soft band (latitude Gaussian) of 4-octave fbm in `DUST_VIOLET` / `DUST_TEAL`,
  with dark lanes (ridged noise) at peak luminance 0.05.
- Both are **baked once at startup** into a 1024² cubemap (`CubeCamera`). That
  cubemap is `scene.background` *and* `env.starfieldCube` for lensing. The live
  starfield `Points` remain only for parallax when flying. Cost after bake: one
  background draw plus one points draw.

## 7. Gate 1 camera and gallery framing

- Star system at the world origin. Camera `fov 32`, position `(0, 7.5, 26)`,
  target `(0, 0.4, 0)`, which is an elevated three-quarter view. The disk reads as
  an ellipse, the belt as a band, and subagent orbits reach the frame edges.
- Needs-me scene: camera pulls back to `(0, 9, 40)` so both full jets fit.
- Compaction scene: camera at `(6, 6, 24)`, aimed so the black hole forms on the
  near side of the belt with dense stars behind it, which makes the lensing
  visible.
- When the owner isn't touching it, the camera auto-orbits at 0.02 rad/s. Any
  input stops that for 8 s.
- The gallery's only text: a small scene name bottom-left (system UI font, 12px,
  60% white), plus a `DEMO` tag when the frames are synthetic rather than
  replayed. No other HUD.

## 8. Performance budget (per system; Gate 1 is one system)

| Item | Budget |
|---|---|
| Draw calls per system | ≤ 22 (star 3, jets 2, beacon 1, nebula 1, belt 1, planets 2, ships 2, flares 1, black hole 1, white hole 2, remnant 2, spare 4) |
| Draw calls per frame (galaxy, 15 systems + background) | ≤ 350 |
| Belt instances | 6000 high / 3000 medium / 1500 low |
| Planets | 24 per system |
| Ships | 64 plus 64 trails per system |
| Nebula sprites | 24 (12 on low) |
| White-hole particles | 300 (only during birth) |
| Remnant shards | 40 |
| Flare loops | 8 |
| Triangles | ≤ 1.5 M per frame |
| GPU frame time | ≤ 8 ms at 1440p on Apple Silicon, 60 fps |
| Frame-rate tiers | 60 fps on input or full-rate motion (working, birth, compaction, ships); 30 fps when only ambient motion (needs-me, my-move, thinking); 10 fps when everything is still; 0 when the tab is hidden |
| Per-frame allocations | none (reuse vectors, colors and matrices) |
| Per-frame buffer uploads | ship and trail buffers only; belt and planets use uniforms plus instance updates only on change |

Objects that are invisible (opacity 0, out of state) set `visible = false`, so
they cost no draw.
