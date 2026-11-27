# Stremio Clipper

Twitch-style clip editor for **Stremio Enhanced** (Windows). A scissors button in the player's control bar pauses the video and opens an always-visible preview window above an editor panel with a full-runtime bar, a zoomed trim bar with draggable handles (both show video-frame filmstrips), title, quality and FPS dropdowns with live size estimates, and a subtitle toggle. Clips are re-encoded to MP4 and saved to `stremio clips\`.

## Main files
- `plugin/stremio-clipper.plugin.js`: the Stremio Enhanced plugin (button, overlay UI in a Shadow DOM, size estimates, preview, save flow). Installed copy lives in `%APPDATA%\stremio-enhanced\plugins\`.
- `helper/server.js`: local HTTP helper on `127.0.0.1:47811` (`/health`, `/probe`, `/thumb`, `/frame`, `/preview`, `/clip`, `/clip/:id`, `/open-folder`, `/copy-file`, `/debug`). Only accepts the Stremio web origin. Set `CLIPPER_EXTRA_ORIGINS` to allow a test origin.
- `helper/srcproxy.js`: caching range proxy (`GET /src/<key>` on the helper). Every ffmpeg/ffprobe run reads the stream through it, never the debrid CDN directly. 2 MiB chunks cached on disk (`%TEMP%stremio-clipper-cache`, 2 GB LRU, wiped on start), max 2 upstream connections, backoff on 429/5xx, re-resolve on stale link. `/health` `upstream` shows requests/cacheHits/statuses/last429At.
- `helper/ffmpeg.js`: finds ffmpeg/ffprobe (the Jellyfin build bundled with Stremio; the WinGet one doesn't run), picks the encoder (NVENC, then QSV, AMF, then x264), probes streams, grabs JPEG frames (`grab()`: keyframe-only for the filmstrip, fast keyframe or exact for the preview), encodes clips and burns in subtitles.
- `helper/start-hidden.vbs`: starts the helper with no console window.
- `install.ps1` / `uninstall.ps1`: copy the plugin, add or remove the Startup shortcut, start or stop the helper.
- `stremio clips/`: output folder.

## Install / run
```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```
Then in Stremio Enhanced: Settings > Enhanced > Plugins, enable **Stremio Clipper**, reload (Ctrl+R). The helper starts at login. After editing the plugin, copy it to the plugins folder again and press Ctrl+R in Stremio. To run the helper manually: `node helper\server.js`.

## How it works
- **Preview window** (`.clp-pv`, top of the overlay) does NOT use Stremio's player (seeking it on a torrent stalled for seconds). It has two surfaces: a canvas for still frames and its own `<video>` for playback. Controls: play/pause (Space), scrub bar across the clip, speaker + volume bar (mute toggle, saved in localStorage `clipper_vol`/`clipper_muted`), preview-only speed (0.5x-2x, never reaches ffmpeg), expand (Fullscreen API, falls back to CSS `.max`; Esc collapses before closing). Stremio's video is only read once, for the first frame.
- **Frames while trimming**: dragging a handle (or typing Start/End) shows the nearest filmstrip thumb instantly, then `POST /frame` (fast = nearest keyframe while dragging, exact on release, 720p JPEG). The frame is held with a START FRAME / END FRAME tag. Requests are coalesced (one in flight, newest wins).
- **Playback**: after the trim settles (800 ms) the plugin calls `POST /preview {url,start,end,height,videoKbps}`; the helper encodes a 720p (480p if over 4 min) proxy of just that range to a temp dir, the plugin downloads it as a blob (`GET /preview/:id/file`), then releases it (`POST /preview/:id/cancel`). Play uses it; if it isn't ready Play waits ("Preparing preview NN%") and auto-plays. Play always starts at the clip start after a trim change; after pausing mid-clip or using the scrub bar it resumes from there. The proxy matches the export's start, so it also shows clip start accuracy. A finished proxy is reused (no rebuild; frames and scrubbing inside it are instant seeks) whenever the trimmed range still lies inside the range it was built for. Dragging the full-runtime grey window leaves the yellow clip in place until the window edge reaches it, then pushes it along (length kept).
- **Set end point** button (between End and Clip length) sets the end to the preview's current time (`curT()`). **Filenames**: the default title gets a timestamp suffix; a custom title is saved as typed (`stamp:false` to /clip; duplicates get " (2)").
- **Save flow**: after a save the "Saved" row (Open folder / Copy file / Close) stays but every control is editable again; changing anything (title, trim, times, quality, FPS, audio, subtitles) restores the Cancel / Save Clip bar so another clip can be saved (`checkDirty()` compares `editSig()` to `S.savedSig`).
- **Filmstrips**: `POST /thumb {url,t,h}`; the helper pool runs max 4 ffmpeg jobs with frames before thumbs, caches results (thumbs 600, frames 80), and kills ffmpeg when the request is aborted. The plugin fetches zoom-bar tiles first and rebuilds them (debounced) when the zoom window moves. `GET /health` returns `perf` (recent thumb/frame/preview timings in ms) for diagnosing slow streams.
- Stream URL comes from `window.services.core.transport.getState('player')` (`stream.url`, or the local streaming server URL built from `infoHash`/`fileIdx`), with the `<video>` source as fallback.
- Size estimate: source bitrate scaled by resolution^1.5 and fps^0.6, capped per height, plus 160 kbps audio. The same bitrate is sent to ffmpeg, so estimates match files within a few percent.
- Quality and FPS lists only offer values at or below the source.

## Status
Tested: helper (probe, clip, subtitle burn-in, cancel path, /thumb, /frame, /preview), plugin UI on a mock player page (preview window, filmstrips, handle scrub and hold, proxy playback with audio, scrub bar, 2x speed, mute/volume, expand, Space, export length unaffected by speed), and in real Stremio Enhanced (button, pause, torrent stream probe, title, estimates, dropdowns).

Not yet verified in real Stremio after the proxy-preview rewrite: filmstrip speed, frame and preview-file latency on a real torrent (check `/health` perf), saving a clip, Open folder, Copy file, and clip start accuracy.

## Known issues / unfinished
- Subtitles: under the Stremio shell (libmpv, e.g. Stremio Plus) the plugin reads mpv's `track-list` over `chrome.webview` (`playerSubTrack()`), defaults the dropdown to the track the player is showing and turns the toggle on. The file's own embedded track (matched by ffprobe `streamIndex` == mpv `ff-index`) is the one that lines up. Addon (OpenSubtitles) tracks are timed for some other cut of the episode: Stremio itself plays them identically early (measured 0.4-3.7 s early on one episode, and the gap changes between ad breaks). So the Offset control (`-`/`+` 0.1 s, Shift 1 s, or type; per-track, + = later) shifts the burned-in cues (`subtitle.offset` -> `shiftAss`), and when an embedded track in the same language exists the plugin calls `POST /subsync` (matches identical lines in a +-90 s window around the clip, median difference) to pre-fill it ("auto" tag; the Auto button re-measures for the current clip). Every offset change rebuilds the preview. Without the shell (Stremio Enhanced) the player's track can't be detected: default is an embedded English track, else the first full English addon track, toggle off.
- Audio: an Audio dropdown appears when the file has more than one track. Default = the track the player has enabled (`video.audioTracks`, if exposed), else Stremio's preferred audio language (`ctx.profile.settings.audioLanguage`, default eng), else the file's default-flagged track. The preview file and the export both use the chosen track (a bug where the first track was always used mixed a Russian voice-over into clips). Changing it rebuilds the preview. Open folder passes `/select,"path"` to explorer with `windowsVerbatimArguments` (the folder name has a space).
- The helper depends on Node on PATH and on Stremio's bundled ffmpeg being present.
- An Enhanced 1.2.1 update popup appears on reload. It was left alone; updating could affect plugin loading.
- Fixes found while testing in the real app: a global-CSS clash hid the dropdown menus, solved by rendering the panel in a Shadow DOM. Keep new UI inside the shadow root.
- `helper/debug-dump.json` is written only when `localStorage.clipper_debug = '1'`; it can contain stream URLs with tokens, so don't share it.
