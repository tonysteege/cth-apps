# Clips Notion

These rules apply in addition to the repository root `AGENTS.md`.

- Keep the public URL backward compatible: `embed.html#src=<encoded video URL>&t=<seconds>&mode=edit|view`.
- Direct `.mp4` and `.webm` sources continue through `js/player.js` unchanged.
- YouTube sources are detected in `embed.html` and mounted through `js/youtube-player.js`.
- The YouTube iframe stays passive. Controls, keyboard focus, timeline input, and horizontal trackpad gestures belong to this origin so they work when nested in a Notion embed.
- Always import `scrubDeltaSeconds` and `scrubMotionStep` from `/clips/js/player.js`; do not duplicate the Clips curve.
- During YouTube scrubbing, call `seekTo(target, false)` while the gesture is active and commit once with `seekTo(target, true)` after it settles. The eased playhead may move ahead of YouTube while the service resolves to a keyframe.
- YouTube seeking is keyframe-limited. Never promise frame-exact visual scrubbing for YouTube sources.
- Keep direct-video playback and telestration behavior backward compatible.
- No app backend, analytics, or telemetry. YouTube sources may load only the official IFrame Player API and privacy-enhanced player.
