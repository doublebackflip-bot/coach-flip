# Coach Flip

Phone-first form check for coaches: film a rep (or upload a video/photo), and the phone tracks the athlete's joints
**on the device** and compares them with an expert knowledge base. You get the clip with lines drawn on it, coaching cues,
why each one matters, drills, pro tips, and sources. Sports: boxing, softball, sprinting, distance running, soccer, jumping,
kickboxing, MMA, and Brazilian jiu-jitsu (some skills are guided coach checklists).

**Open on your phone:** https://doublebackflip-bot.github.io/coach-flip/ and then use Share → Add to Home Screen (iOS)
or Install app (Android). After the first visit it works offline.

Privacy: videos, landmarks, and athlete data stay on the phone (IndexedDB). Nothing is uploaded, and this site has no server code.

This repo is the built static app only (no tests or test videos).

## Third-party components and licenses
* **MediaPipe Tasks Vision** 1.1.0 (`vendor/mediapipe/`, JS + WASM), © Google LLC, **Apache License 2.0**,
  https://github.com/google-ai-edge/mediapipe
* **MediaPipe Pose Landmarker models** (`models/pose_landmarker_lite.task`, `pose_landmarker_full.task`), © Google LLC,
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
