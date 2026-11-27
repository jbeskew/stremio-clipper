# Stremio Clipper

Twitch-style clipping for **Stremio Enhanced** on Windows. Adds a scissors button to the player's control bar. Click it to pause, pick a start and end, preview the clip, and save it as an MP4.

- Zoomed trim bar with draggable handles and video-frame filmstrips
- Live preview window with audio, speed control and fullscreen
- Quality and FPS dropdowns with live file-size estimates
- Optional burned-in subtitles and audio-track picker
- Uses your GPU encoder when available (NVENC, QuickSync, AMF), otherwise x264

Everything runs **locally on your PC**. There are no accounts, API keys or cloud services, and nothing is uploaded. It works with whatever stream Stremio is already playing (torrent, debrid, etc.) using the same URL Stremio gives the player, so it never needs your debrid or addon credentials.

## Requirements
- Windows 10/11
- [Stremio Enhanced](https://github.com/REVENGE977/stremio-enhanced) (the plugin-capable Stremio client)
- Regular [Stremio](https://www.stremio.com/) or Stremio Service installed. Its bundled ffmpeg is used. Any working ffmpeg + ffprobe on your PATH also works.
- [Node.js](https://nodejs.org) (LTS is fine)
- Git (or just download the repo as a ZIP)

## Install (you)
1. Get the code:
   ```powershell
   git clone https://github.com/<OWNER>/stremio-clipper.git
   cd stremio-clipper
   ```
   (No Git? Click **Code > Download ZIP** on GitHub, unzip it somewhere permanent, and open PowerShell in that folder. Don't delete the folder afterwards: the helper runs from it.)
2. Run the installer:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```
   This copies the plugin to `%APPDATA%\stremio-enhanced\plugins`, adds a Startup shortcut so the helper runs hidden at login, and starts the helper now.
3. Open Stremio Enhanced > **Settings > Enhanced > Plugins**, enable **Stremio Clipper**, then reload with **Ctrl+R**.
4. Play something. The scissors button is in the player's control bar.

Clips are saved to the `stremio clips` folder inside the repo folder.

## Install (with Claude Code)
Open Claude Code in an empty folder and paste this:

> Clone https://github.com/\<OWNER\>/stremio-clipper into this folder, read its README.md and CLAUDE.md, then install it for me: check I have Node.js and Stremio (or ffmpeg) installed, run `install.ps1`, confirm the helper is up with `Invoke-RestMethod http://127.0.0.1:47811/health`, and tell me the final manual step in Stremio Enhanced. Don't change any files outside this folder except what `install.ps1` does.

Claude will do the setup and tell you to enable the plugin in Stremio Enhanced (that step is in the app UI).

## Using it
1. While watching, click the scissors button. The video pauses.
2. The clip defaults to the 30 seconds before that point. Drag the yellow handles on the zoomed bar, drag the yellow block to slide the clip, click the full-runtime bar to move the zoomed view, or type exact start/end times. **Set end point** snaps the end to the preview's current time.
3. **Play** in the preview window shows just the selected section with audio (Space toggles play/pause).
4. Pick quality and FPS (defaults to the source; only equal or lower options are offered). Each option shows its estimated size.
5. Edit the title, toggle subtitles, choose an audio track if the file has several, then **Save Clip**.
6. After saving: Open folder, Copy file, or Close. You can keep editing and save another clip.

## Updating
```powershell
git pull
powershell -ExecutionPolicy Bypass -File .\install.ps1
```
Then press **Ctrl+R** in Stremio Enhanced. If you edit the plugin yourself, re-run `install.ps1` (or copy `plugin\stremio-clipper.plugin.js` to the plugins folder) and reload.

## Uninstall
```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```
Removes the plugin and Startup shortcut and stops the helper. Saved clips are kept.

## Troubleshooting
- **No scissors button:** make sure the plugin is enabled in Settings > Enhanced > Plugins and you reloaded (Ctrl+R).
- **"Helper not running" / nothing happens on click:** run `Invoke-RestMethod http://127.0.0.1:47811/health`. If it fails, run `node helper\server.js` in the repo folder to see the error.
- **Helper can't find ffmpeg:** install Stremio or Stremio Service, or set the `FFMPEG_DIR` environment variable to a folder containing working `ffmpeg.exe` and `ffprobe.exe`.
- **Slow filmstrips on a torrent:** the first frames can take a few seconds while the stream buffers. `GET http://127.0.0.1:47811/health` shows recent timings under `perf`.
- **Subtitles:** the plugin can't tell which track the player is showing, so pick one in the clip panel when the subtitle switch is on.
- **Debug dump:** setting `localStorage.clipper_debug = '1'` in devtools writes `helper\debug-dump.json`. It can contain stream URLs with tokens, so never share it (it is git-ignored).

## Privacy and security
- The helper listens on `127.0.0.1:47811` only and accepts requests only from the Stremio web origin.
- No credentials, API keys or tokens are stored in this repo or sent anywhere. Stream URLs are passed to your local ffmpeg and nowhere else.
- If you contribute or open an issue, don't paste stream URLs, they can contain your debrid/addon tokens.

## Project layout
- `plugin/stremio-clipper.plugin.js`: the Stremio Enhanced plugin (button, overlay UI, preview, save flow)
- `helper/server.js`, `helper/ffmpeg.js`: local HTTP helper that probes streams, grabs frames and runs ffmpeg
- `helper/start-hidden.vbs`: starts the helper without a console window
- `install.ps1` / `uninstall.ps1`: setup and removal
- `CLAUDE.md`: detailed architecture notes (useful for Claude Code or contributors)

## License
MIT
