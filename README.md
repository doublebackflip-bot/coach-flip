# Coach Flip

Phone-first form check for coaches: film a rep (or upload a video/photo), and the phone tracks the athlete's joints
**on the device** and compares them with an expert knowledge base. You get the clip with lines drawn on it, coaching cues,
why each one matters, drills, pro tips, and sources. Sports: boxing, softball, sprinting, distance running, soccer, jumping,
kickboxing, MMA, and Brazilian jiu-jitsu (some skills are guided coach checklists).

**Open on your phone:** https://doublebackflip-bot.github.io/coach-flip/ and then use Share → Add to Home Screen (iOS)
or Install app (Android). After the first visit it works offline.

Privacy: videos, landmarks, and athlete data stay on the phone (IndexedDB). Nothing is uploaded, and this site has no server code.

This repo is the built static app only (no tests or test videos).

## New in v0.5.0
* **Trim before analysis:** after recording or picking a video, drag the two red handles on the filmstrip to keep only the part to
  critique (cuts the walk-in and the end). "Play selection" previews it; "Use whole clip" skips trimming. Only the chosen part is
  tracked and checked, and the results player only shows that part. Clips longer than the max length (Settings, 20 s default)
  start with the first 20 s selected.
* **Graphics no longer cover the athlete:** the fault name sits in a bar above the video. Measurements ("4.6 fists", "126°") are
  small see-through tags placed beside the athlete with a thin line to the joint, only for the fault you selected. Lines are thin.
  **Labels** button turns the tags off; **touch and hold** the video to see the plain picture.
* **More accurate on fast punches:** clips are analysed at their own frame rate up to 30 fps (was 20), and the smoothing keeps the
  full reach of a punch (peak kept 96% instead of 87%). The crop around the athlete is now 512 px.
* **New look:** dark gym background, red accent, Oswald headings (all bundled, works offline).
* **Camera angle check:** the app reads where the camera really was from the body. A softball swing filmed from behind the batter
  (e.g. down a cage) is no longer judged as a side view: extension, back heel, head and other side-view checks say "not clear
  enough to judge" instead of calling false faults, with a note on how to film. A side/front mix-up is corrected automatically.
  Also on for sprinting, distance running, soccer and jumping. Head movement in the swing is now measured relative to the hips in 3D.
* **Re-finds the athlete** after losing them for a moment (close-up clips at 25-30 fps could lose the athlete for good).

## Better tracking (v0.4.0)
* **Tap your athlete:** when there is more than one person in the picture (coach, sparring partner, people walking by), the app shows
  one frame with everyone outlined. Tap your athlete; the app then follows only that person (by position, body shape and clothing
  colour, so a coach walking past doesn't steal the skeleton). "Skip" picks the biggest, most central person.
* The app crops the video around the athlete and runs the pose model on that close-up, then cleans the track (left/right flips,
  impossible jumps, short gaps, jitter). The **Raw view** button on the results player shows the tracker's raw output for comparison.
* **Tracking quality** (0-100) is shown with each result. When it is low, the app lists what to change when filming: distance (3-5 m,
  athlete at least half the picture height), lighting, a plain background, phone steady (lean it on something), whole body in view.
* Checks the app can't see well enough (a hand hidden behind the body, a 3/4 camera angle for a front-view check) are listed as
  **"Not clear enough to judge"** instead of a fault. Each fault shows how confident the app is.
* **Jab or cross is decided by the hand that actually punched** and by which side of the body is forward, so a southpaw, or an
  orthodox boxer filmed with the selfie camera (mirrored video), no longer gets jab/cross and lead/rear hand swapped. The guard
  check measures the non-punching hand against the face (chin), not the shoulder.
* **Camera angle:** the app works out whether the clip is front, side or 3/4. At a 3/4 angle, checks that need a straight-on view
  (weight shift, elbow flare and similar) say "not clear enough to judge" instead of guessing. Film straight from the front or side for those.
* **Slow-motion** applies only to an uploaded clip that plays back slowed down. Clips recorded in the app are always treated as normal speed,
  and real 120/240 fps files are detected from the file itself.
* Settings → Pose model: **Auto** (default, uses Full), **Full**, **Accurate (slower)** (heavy model, downloads 30 MB once; about 1.2-1.3x slower on a laptop, up to 2x on older phones; in our tests not more accurate overall), or **Lite** (fastest).

## Recording tips and troubleshooting (v0.3.1)
* **Record video** records inside the app (live preview, 🔄 flip camera, stops by itself at 20 s). The first time, allow camera access.
  If you blocked it: iPhone, Settings → Safari → Camera → Allow (or "aA" → Website Settings); Android, lock icon → Permissions → Camera.
* **Use the phone's camera app instead** (link under the Record button) and **Upload a video** still work as fallbacks.
* iPhone videos: the default HEVC (.MOV) and 4K/60 clips work; they are scaled down for tracking. If a clip will not open, set
  Settings → Camera → Formats → **Most Compatible**, or record inside the app.
* If something fails, the error screen has a **Debug info** box (phone, browser, file type/size, video size/length, which step failed).
  A screenshot of it helps with fixing the problem.

## Third-party components and licenses
* **MediaPipe Tasks Vision** 1.1.0 (`vendor/mediapipe/`, JS + WASM), © Google LLC, **Apache License 2.0**,
  https://github.com/google-ai-edge/mediapipe
* **Oswald** font (`fonts/oswald-var.woff2`, Latin subset), © The Oswald Project Authors, **SIL Open Font License 1.1** (`fonts/OFL-Oswald.txt`),
  https://github.com/googlefonts/OswaldFont
* Background art `img/gym_bg.webp` / `gym_bg_small.jpg`: AI-generated for this app.
* **MediaPipe Pose Landmarker models** (`models/pose_landmarker_lite.task`, `pose_landmarker_full.task`, `pose_landmarker_heavy.task`), © Google LLC,
  **Apache License 2.0**, https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker
* **Coaching knowledge bases** (`data/*.json`): written for this app. Each checkpoint, fault, and drill cites its public
  sources (governing-body manuals, coaching federations, peer-reviewed papers), which are listed with URLs inside each JSON file
  and shown in the app next to each fault. No source text is reproduced beyond short paraphrases.

## Test footage used during development (not included here)
These clips were used only to test the app. They are not part of this repo.
* Pexels videos 6296641 (Pavel Danilyuk), 8745108 (Ron Lach), 5182771, 8533913, 9777600, 7241763, 8612119, 38173682,
  31229031, 35030837: **Pexels License** (free to use), https://www.pexels.com/license/
* "Boxing training.webm", User:Evworo, Wikimedia Commons: **CC BY-SA 3.0**
* "Boxing Heavy Bag Analysis.webm", User:UncleSamPatriot, Wikimedia Commons: **CC BY 4.0**
