<div align="center">
  <p><a href="README.md">简体中文</a> · <strong>English</strong></p>
  <img src="assets/branding/noxreel-icon.png" width="120" alt="NoxReel">
  <h1>NoxReel</h1>
  <p><strong>Turn “I have the movie” into “we are watching it together.”</strong></p>
  <p>A lightweight, dark-themed watch-party app for synchronized P2P local video sharing and public video links — now with a playlist for the whole evening, danmaku comments over the picture, and your own preferred player.</p>

  <p>
    <img src="https://img.shields.io/badge/version-0.7.3-7C5CFF?style=for-the-badge" alt="Version 0.7.3">
    <img src="https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4?style=for-the-badge&logo=windows11&logoColor=white" alt="Windows 10/11">
    <img src="https://img.shields.io/badge/Android-Beta-3DDC84?style=for-the-badge&logo=android&logoColor=white" alt="Android Beta">
    <img src="https://img.shields.io/badge/license-MIT-22C55E?style=for-the-badge" alt="MIT License">
  </p>

  <p>
    <a href="https://github.com/Felis-desuwa/NoxReel/releases/latest"><strong>Download the latest release</strong></a>
    ·
    <a href="#quick-start">Quick start</a>
    ·
    <a href="https://github.com/Felis-desuwa/NoxReel/issues">Report an issue</a>
  </p>
</div>

<p align="center">
  <img src="src/renderer/assets/home-abyss.webp" width="100%" alt="NoxReel deep-space interface">
</p>

> [!WARNING]
> **0.7 cannot connect to 0.6.x.** The transfer protocol moved to v2, so the host and every member — including the Android viewer — must be on 0.7. Invite and answer links carry the protocol version, so an older build is reported as a version problem instead of an unexplained “cannot connect”.

## Why NoxReel

| 🎞️ Safer receiving | 📃 A playlist for the evening | 💬 Danmaku chat |
|:---|:---|:---|
| Trusted rooms default to progressive playback. Safe mode remains available for full receipt and scanning first. | The playlist on the right is also the transfer order: the host and moderators queue the videos, and one follows the next. | Messages land in the chat panel and fly across the picture; press `Ctrl+Shift+D` inside the player window to send one. |

### Core experience

- **Playlist:** a table on the right side of the room where **list order = playback order = transfer order**. The host and moderators can add local videos or links, drag to reorder, play an item immediately, remove items, and toggle autoplay; guests can only watch. Dragging a later item to the top switches the transfer right away. Once playback has started it asks first, then moves the previous video to the next position, remembers its progress, and resumes it from where it stopped. Autoplay waits until everyone is ready, and the host or a moderator can still press “Start anyway”. Finished videos move into a “Played” section (up to 30) and can be played again at any time.
- **Danmaku chat:** the chat panel sits at the bottom right, and every message also flies across the picture. **Press `Ctrl+Shift+D` inside the player window to send one** without switching back to the room. Messages are capped at 200 characters and rate-limited by a token bucket; the host keeps the last 50 and replays them to newcomers (history goes to the chat list only, never on screen as danmaku). The danmaku toggle, opacity, font size, and display area are local to you. Joining, leaving, media changes, and who pressed pause appear as grey lines in the same chat stream.
- **Switchable player:** a dropdown on the control bar switches between mpv, PotPlayer, and MPC-BE. The change takes effect immediately and carries the playback position and pause state across — no need to leave the room. See [Player support](#player-support).
- **Joining mid-playback does not stall the room:** a late joiner first receives the part the room is currently at, so a missing first half no longer pauses everyone else. Every member's buffer margin is measured from their own playback position.
- **No file size limit:** MP4, MOV, M4V, and MKV local videos; receivers check free disk space first and evict caches from the played section when space runs short.
- **More formats** (requires ffmpeg, installed separately): AVI, TS / M2TS / MTS, WMV / ASF, FLV / F4V, MPG / MPEG / VOB, WebM, OGV, and 3GP are **packed losslessly into MKV** on the host's machine before entering the room — only the container changes, nothing is re-encoded, picture and sound stay identical. Your friends receive an ordinary MKV, so older 0.7 builds and the Android viewer can take it too. RM / RMVB are not supported (MKV cannot hold RealVideo without re-encoding). Whether the Android viewer can play a file depends on its codecs: most phones cannot decode older ones such as WMV, MPEG-2, or Theora.
- **External subtitles travel with the video** (requires ffmpeg): ASS / SSA / SRT / VTT files in the same folder whose names start with the video's name are found automatically (when the folder holds only this one video, mismatched names count too), and you can add more by hand. Checked subtitles are packed losslessly into the MKV; GBK, Big5, and Shift-JIS files are converted to UTF-8. Everyone can switch subtitle tracks in their player, and the first checked one shows by default. Fonts used by an external ASS file are not carried along; viewers without them see a system font.
- **Stall prediction:** when the host picks a file, NoxReel compares its bitrate with the measured uplink to estimate how many people can smoothly stream at once, and asks before continuing if members would stall. In the room, every member shows a live receive speed and how long smooth playback will last.
- **One-click invite links:** serverless `noxreel://` invite and answer links are generated by default and carry the protocol version, so an older build is named as such on the spot.
- **Resilient link parsing:** YouTube uses a dedicated anonymous-client fallback. Cloudflare 403 pages fall back to a permissionless, non-persistent isolated browser that detects public media requests.
- **Lossless slim-down** (requires ffmpeg, installed separately): drop the audio tracks and image-based subtitles this screening will not use, choose which audio track to keep, and convert uncompressed PCM audio to FLAC. Video is never re-encoded, and the compression ratio is measured on your actual file before the conversion is offered. The only third-party media tools in the installer are mpv and yt-dlp — an official full ffmpeg build is about 460 MB across its two executables, which would more than double the download, so install it yourself with `winget install Gyan.FFmpeg` (the in-app dependency dialog has a copy button for the command).
- **Automatic reconnection:** in signaling mode a dropped direct connection (NAT mapping timeout, Wi-Fi roaming, ISP re-dial) renegotiates itself instead of forcing everyone through the invite flow again; a failure states whether STUN is unreachable, the relay credentials are wrong, or both sides sit behind symmetric NAT.
- **Buffer coordination:** playback pauses when a controlling member runs low on playable data and resumes after recovery.
- **Real member status:** only established connections are listed, with upload rate, download rate, and latency.
- **Recoverable player:** reopen the player from the room after its window is closed.
- **Modern player UI:** mpv uses NoxReel's dark borderless appearance, rounded Windows corners, a bottom control bar, and clearer seek feedback.
- **Native EXE entry points:** double-click the branded `NoxReel.exe` from a source checkout instead of using a BAT file; `NoxReel-Signal.exe` starts the signaling service.
- **Selectable install location:** both Windows installers use a guided setup and let you choose the destination folder before installation.
- **Android viewer:** follows the playlist, sends and receives chat, and shows danmaku over the picture; it cannot edit the playlist.
- **Chinese and English UI:** switch between Simplified Chinese and English from Settings on both desktop and the Android viewer. Nicknames, video titles, and chat text are always shown verbatim and are never translated.
- **Automatic cache cleanup:** received videos and remuxed copies stay in the system temporary directory and are deleted when switching media, leaving the room, or closing the app. Crash leftovers are reclaimed on the next launch.
- **Two security modes:** Trusted room is the default and starts progressive playback after about 8 MB, with a full scan after receipt. Safe mode remains available and plays only after complete receipt and a Microsoft Defender scan.
- **Version and mode handshake:** invite codes and the P2P data channel both verify the protocol version and the selected room mode. A mismatch disconnects before media manifests, room controls, or video data are exchanged.
- **Hardened desktop shell:** Electron sandboxing, constrained IPC, safe DOM rendering, strict room-role authorization, and a unified dark Windows title bar.

> [!NOTE]
> `v0.7.3` adds **external subtitles that travel with the video** and **more video formats**. ASS / SSA / SRT / VTT files next to the video whose names start with the video's name are found automatically, and you can add more when adding a video; checked subtitles are packed losslessly into an MKV and sent with it, GBK, Big5, and Shift-JIS files are converted to UTF-8, and the first checked one shows by default. AVI, TS, WMV, FLV, MPG / VOB, WebM, and more are likewise **packed losslessly into MKV** on the host's machine (container change only, nothing re-encoded) before entering the room. Both need ffmpeg on the host; viewers receive an ordinary MKV, so **the protocol is unchanged and 0.7.3 works with 0.7.0–0.7.2**.

> [!NOTE]
> `v0.7.2` fixes two problems. **A TURN relay that is enabled but has no username or password** used to stop every connection from being created (an error as soon as you entered a room, and "Generate a new invite link" spinning forever); such a relay is now skipped so only direct connections are tried, the log says so once, and Settings refuses to save it. **PotPlayer being closed two seconds after switching to it**: right after starting, PotPlayer first reports the file it played last time, which used to be mistaken for "someone opened another file in PotPlayer"; file-name reports before startup completes are now ignored, and MPC-BE is handled the same way.

> [!NOTE]
> `v0.7.1` reorganizes the room page around "what should happen next": a single **status strip** under the title says what is going on right now, with at most one button to press (such as "Start anyway"); the progress bar doubles as the buffer bar, and its legend carries the numbers (where playback is, how long it can keep playing without waiting, how much has arrived); **live download and upload rates** with a 30-second sparkline are new; the member list is now a table that shows at a glance who is ready and who is receiving slowly; and **inviting is no longer one-shot** — an empty room shows a three-step invite flow, and once someone joins, an "Invite someone else" row stays under the member list. Leave room and Invite moved to the title bar, and the danmaku toggle moved to the chat header. The protocol is unchanged, so 0.7.1 works with 0.7.0.

> [!IMPORTANT]
> `v0.7.0` turns "one movie" into "one evening": the **playlist**, **danmaku chat**, and the **switchable player** all land together, at the cost of a **protocol bump to v2 that cannot talk to 0.6.x**. A room used to hold exactly one video — the transfer layer had a single manifest and a single bitfield, and the control messages carried no file identifier at all, so "pause the first video and transfer the second one instead" was not expressible in the old protocol. Data frames now carry a slot, and manifests, bitfields, requests, and cancellations are all per-slot, so a room can hold several videos while the scheduler only ever serves the current one: **someone who finished early and moved on to the next video does not slow down the people still receiving the current one**. The host is the single authority over the list, moderators have the same list powers (add, reorder, play now, remove, toggle autoplay), and only the host can still change roles. **Danmaku** travels over the same control channel; the receiver deduplicates by id before spending a token, and neither nicknames nor message bodies enter the translation tables. The mpv path rebuilds an ASS overlay 30 times a second (mpv renders overlays at a fixed time of 0, so `\move` never animates and every frame must be drawn), while external players get a click-through transparent overlay window that paints on a canvas. **The switchable player** adds a small C# bridge that remote-controls PotPlayer and MPC-BE: both seek away and stop when handed a file that is still growing, so they only take over fully received files, mpv still covers the progressive part of a Trusted room, and a one-click hint appears once the file is complete. **Joining mid-playback** was reworked as well: playback starts only once enough data has arrived around the starting point, and only the part near the room's current position is fetched, so nobody else has to wait. The incompatibility is a deliberate trade — maintaining two transfer stacks is not worth it for rooms of 2–16 friends, so the invite code simply carries the version and says "the other side is on 0.6.x" outright. Tests grew from 298 to more than 1,500.

## Downloads

| Build | Best for | Download |
|---|---|---|
| Windows full installer | Recommended. Bundles mpv, yt-dlp, and the player bridge, and lets you choose the install folder | [NoxReel-Setup-0.7.3.exe](https://github.com/Felis-desuwa/NoxReel/releases/latest/download/NoxReel-Setup-0.7.3.exe) |
| Windows web installer | Smaller guided installer with a selectable folder; downloads components during setup | [NoxReel-WebSetup-0.7.3.exe](https://github.com/Felis-desuwa/NoxReel/releases/latest/download/NoxReel-WebSetup-0.7.3.exe) |
| Android beta | Join a desktop room as a viewer | [app-debug.apk](https://github.com/Felis-desuwa/NoxReel/releases/latest/download/app-debug.apk) |
| SHA-256 | Verify downloaded files | [SHA256SUMS.txt](https://github.com/Felis-desuwa/NoxReel/releases/latest/download/SHA256SUMS.txt) |

> [!NOTE]
> The Android `app-debug.apk` sits next to the Windows installers on the same [Releases](https://github.com/Felis-desuwa/NoxReel/releases) page, under each release's **Assets** section; your phone also has to allow installing apps from unknown sources. **A 0.7 APK cannot connect to a 0.6.x desktop and vice versa** — upgrade the phone and the computer together.
>
> The Windows installers are not currently signed with a commercial code-signing certificate, so Windows may display an “Unknown publisher” warning. Download only from this repository’s Releases page.

## Quick start

1. Install and open NoxReel. The host and every member must be on 0.7.
2. Trusted room is the default for progressive playback. Choose Safe mode when you want full receipt and scanning first. Every participant must use the same mode.
3. Create a room and set its capacity.
4. Add videos to the playlist on the right: local files (multiple at once) or supported video links. The list order is the playback order and the transfer order.
5. Send the generated NoxReel invite link. The member opens it and sends the answer link back for the host to open.
6. Start once everyone is ready. The host and moderators synchronize play, pause, and seek and can requeue at any time; everyone can send danmaku chat.

```text
Local video → Direct WebRTC P2P
Video link → Each member connects to the source site
             ↓
Safe mode: verify and scan the complete file before playback
Trusted room: start near 8 MB and scan after full receipt
             ↓
Playlist: when one ends, the next starts once everyone is ready
                         ↕
            Synchronized room state + danmaku chat
```

## Player support

| Player | Where it comes from | Progressive playback | Danmaku | Send danmaku in the player |
|---|---|:---:|---|---|
| **mpv** (default) | Bundled with the installer | ✅ Supported | The player's own overlay | ✅ `Ctrl+Shift+D` |
| **PotPlayer** | Your own installation | ❌ Fully received files only | Transparent overlay window | ✅ `Ctrl+Shift+D` |
| **MPC-BE** | Your own installation | ❌ Fully received files only | Transparent overlay window | ✅ `Ctrl+Shift+D` |

- **Switch at any time:** the control-bar dropdown lists what is installed locally, and anything missing offers “Set path…”. Switching takes effect immediately and carries the position and pause state across.
- **Why external players are not progressive:** in testing, PotPlayer and MPC-BE both seek away and stop when opening a file that is still growing. mpv therefore covers the progressive part of a Trusted room, and once the file is complete the control bar and the player OSD offer a one-click “Fully received · switch to PotPlayer”. Nothing switches by itself mid-playback.
- **Danmaku is invisible under exclusive fullscreen:** danmaku for external players is painted on a click-through transparent overlay window, and an exclusive-fullscreen picture is scanned out by the GPU directly, so no window can sit above it. NoxReel detects this and suggests switching the player to borderless fullscreen.
- **MPC-BE cannot open a link that needs request headers:** such links fall back to mpv with a message.
- **A player running as administrator cannot be remote-controlled** (UIPI blocks the messages); this also falls back to mpv with a message.
- PotPlayer and MPC-BE are Windows-only and rely on the bridge program shipped in the installer. From a source checkout, build it once with `npm run build:bridge`.

## Connection methods

| Method | Workflow | Server required | Best for |
|---|---|---:|---|
| Serverless links (default) | Each side clicks one invite/answer link | No | Default; one invite per member |
| Signaling room (optional) | Members open one reusable room invite | Lightweight signaling server | Frequent multi-person joining |

Serverless WebRTC must exchange both an offer and an answer, so the member still sends one answer link back; long codes no longer need manual pasting. The optional signaling server exchanges SDP, ICE, and room state only and never reads video. Strict NAT, CGNAT, or firewall environments may require a self-hosted TURN relay.

## Privacy and content boundaries

- Local video chunks travel over encrypted WebRTC connections between members.
- Chat and danmaku use the same encrypted P2P connections, never touch a server, and are never written to disk; the host keeps only the last 50 messages in memory to replay them to newcomers.
- Every member loads video links directly from the original website; the NoxReel signaling server does not relay them. Short-lived Android playback URLs travel only through an authenticated room connection and exclude Cookie and Authorization headers.
- User-selected source videos are never deleted. Generated receive caches do not remain in Downloads and do not support cross-restart resume.
- The desktop app enables the Chromium sandbox, context isolation, strict CSP, and allowlisted privileged IPC. The danmaku overlay window has no Node access and only paints canvas text.
- Nicknames, video titles, chat messages, and errors are rendered as text rather than executable HTML, and never enter the translation tables.
- External players can only be chosen through a main-process dialog restricted to allowlisted file names, their arguments are validated, and they are never launched through a shell; the bridge only sends messages to the process it started itself.
- Received media is limited to MP4, M4V, MOV, and MKV, with extension, container header, and per-chunk hash validation. AVI and the other extra formats, as well as external subtitles, are packed into MKV on the host's machine before entering the room, so this receiving whitelist is not widened. Safe mode plays after the complete file passes a local scan; Trusted room intentionally plays before that scan is complete.
- NoxReel does not bypass login, paywalls, regional restrictions, or DRM.
- The project does not provide content search, resource indexes, or copyrighted media sources.

> Share and watch only content you have the legal right to use.

## Security notice and disclaimer

> [!CAUTION]
> NoxReel is provided “as is.” No software, network connection, third-party player, or security scanner can identify and prevent every risk. Join only rooms you trust, receive content only from trusted sources, and keep Windows, Microsoft Defender, NoxReel, and player components up to date. You are responsible for third-party content, services, and self-hosted infrastructure. To the maximum extent permitted by applicable law, the project authors provide no express or implied warranty.

If you discover a security issue, do not publish exploitable details in a public Issue. Contact the repository maintainer privately first so the report can be verified and addressed.

<details>
<summary><strong>Technical structure</strong></summary>

| Component | Purpose |
|---|---|
| Electron | Desktop shell and room interface |
| mpv | Default player and IPC control |
| NoxReelPlayerBridge | C# bridge that remote-controls PotPlayer and MPC-BE |
| WebRTC DataChannel | P2P video chunks, control messages, and chat |
| WebSocket | Optional signaling service |
| yt-dlp | Public video link parsing |

The transfer layer is keyed by slot: a room can hold several videos at once, each with its own manifest, bitfield, and session, while the scheduler only ever serves the current one. Local files use per-chunk verification and two watermarks: contiguous bytes from the start of the file measure completeness, while contiguous bytes from the current playback position measure how far playback can safely continue. The two differ widely when someone joins mid-playback, so stall detection only looks at the latter. A bounded memory cache and merged adjacent writes reduce repeated disk reads and small writes. Safe mode gives the cache path to the player only after the complete file passes a local scan. Trusted rooms start once roughly the first 8 MB (the container index) has arrived and enough contiguous data exists from the starting position, then scan after full receipt.

</details>

<details>
<summary><strong>Current limitations</strong></summary>

- **No interoperability with 0.6.x:** protocol v2 has no backward-compatible path, so a mixed room disconnects during the handshake and asks for an upgrade.
- Public-internet NAT traversal depends on both networks and cannot be guaranteed.
- Users must provide their own TURN relay and credentials.
- There is no file size cap: the manifest and chunk bitfield are split automatically to stay under the DataChannel per-message limit. The largest current end-to-end real-media test is 1.75 GB.
- The playlist holds at most 100 items, and the played section keeps at most 30.
- PotPlayer and MPC-BE only take over fully received files and are Windows-only; danmaku is invisible under exclusive fullscreen, and MPC-BE additionally cannot open links that need request headers.
- Android remains a beta viewer: it follows the playlist, sends and receives chat, and shows danmaku, but **cannot edit the playlist**.
- Uplink bandwidth is estimated by uploading random data to a Cloudflare speed-test node. It cannot see losses on the P2P path itself (cross-region routes and TURN relays are slower), so the UI always labels it as an estimate.
- Website support changes with yt-dlp and the source site. If a short-lived stream expires, the host must switch to that link again.
- Safe mode requires a **running** Microsoft Defender to automatically play local video received from another member; playback is refused when the scan is unavailable or does not pass. On machines with third-party antivirus software installed, Defender is often taken over and disabled, so Safe mode cannot release any received file — the dependency status shows “Missing Defender” at startup when this happens. Trusted rooms start before the final scan, and an unavailable scanner only produces a warning rather than interrupting playback; use them only when every participant trusts the host and content source.

</details>

## Run from source

Node.js 22.12 or newer is required:

```powershell
git clone https://github.com/Felis-desuwa/NoxReel.git
cd NoxReel
npm install
npm start
```

On Windows, you can also double-click `NoxReel.exe` in the source checkout. It checks Node.js, installs missing dependencies, and starts the desktop app. Use `NoxReel-Signal.exe` for the local signaling service. Both launchers carry the NoxReel icon and do not depend on BAT files.

### Common commands

```powershell
npm test              # Run tests
npm run signal        # Start the local signaling server
npm run build:launcher # Rebuild the branded EXE launchers
npm run build:bridge  # Build the bridge that remote-controls PotPlayer / MPC-BE
npm run dist:offline  # Build the full Windows installer
npm run dist:web      # Build the Windows web installer
```

The full installer bundles mpv, yt-dlp, and the player bridge. Source builds can also use compatibility environment variables:

- `SYNCWATCH_MPV_PATH`
- `SYNCWATCH_YTDLP_PATH`
- `SYNCWATCH_FFMPEG_PATH`

## Contributing

Use [Issues](https://github.com/Felis-desuwa/NoxReel/issues) for bug reports and feature requests. Include your operating system version, connection method, media format, and reproduction steps whenever possible.

## License

NoxReel is available under the [MIT License](LICENSE).

<div align="center">
  <sub>Built for movie nights across distance.</sub>
</div>
