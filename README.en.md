<div align="center">
  <p><a href="README.md">简体中文</a> · <strong>English</strong></p>
  <img src="assets/branding/noxreel-icon.png" width="120" alt="NoxReel">
  <h1>NoxReel</h1>
  <p><strong>Turn “I have the movie” into “we are watching it together.”</strong></p>
  <p>A lightweight, dark-themed watch-party app for synchronized P2P local video sharing and public video links.</p>

  <p>
    <img src="https://img.shields.io/badge/version-0.5.1-7C5CFF?style=for-the-badge" alt="Version 0.5.1">
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

## Why NoxReel

| 🎞️ Safer receiving | 🔗 Link synchronization | 👥 Room collaboration |
|:---|:---|:---|
| Safe mode receives the complete file and scans it locally before playback. Trusted rooms can explicitly enable progressive playback. | Supports public video pages, direct MP4 URLs, and HLS while synchronizing playback state only. | Set a capacity of 2–16 people, view connection rate and latency, and automatically wait for the slowest buffer. |

### Core experience

- **Up to 10 GB:** MP4, MOV, M4V, and MKV local videos.
- **Short invite codes:** compact `NR2` room codes with backward compatibility for `SW2` and `SW1`.
- **Switch videos without leaving:** the host can change a local video or video link while members remain connected.
- **Buffer coordination:** playback pauses when a controlling member runs low on playable data and resumes after recovery.
- **Real member status:** only established connections are listed, with upload rate, download rate, and latency.
- **Recoverable player:** reopen the player from the room after its window is closed.
- **Modern player UI:** mpv now uses NoxReel's dark borderless appearance, rounded Windows corners, a bottom control bar, and clearer seek feedback.
- **Native EXE entry points:** double-click the branded `NoxReel.exe` from a source checkout instead of using a BAT file; `NoxReel-Signal.exe` starts the signaling service.
- **Android link playback:** after the desktop host resolves a webpage, Android viewers can approve the source site and synchronously play its temporary HTTP, HLS, or DASH stream.
- **Chinese and English UI:** switch between Simplified Chinese and English from Settings on both desktop and the Android viewer.
- **Automatic cache cleanup:** received videos and remuxed copies stay in the system temporary directory and are deleted when switching media, leaving the room, or closing the app. Crash leftovers are reclaimed on the next launch.
- **Two security modes:** Safe mode is the default and plays only after complete receipt and a Microsoft Defender scan. Trusted rooms require both the host and each member to opt in, allow progressive playback after about 8 MB of initial data, and still run a full scan after receipt.
- **Mode handshake:** invite codes and the P2P data channel both verify the selected room mode. A mismatch disconnects before media manifests, room controls, or video data are exchanged.
- **Hardened desktop shell:** Electron sandboxing, constrained IPC, safe DOM rendering, strict room-role authorization, and a unified dark Windows title bar.

> [!IMPORTANT]
> `v0.5.1` replaces the source checkout's BAT entry points with native Windows launchers carrying the NoxReel icon. It also includes the website parsing, modern mpv interface, and Android link playback introduced in `v0.5.0`.

## Downloads

| Build | Best for | Download |
|---|---|---|
| Windows full installer | Recommended. Bundles mpv and yt-dlp | [NoxReel-Setup-0.5.1.exe](https://github.com/Felis-desuwa/NoxReel/releases/latest/download/NoxReel-Setup-0.5.1.exe) |
| Windows web installer | Smaller installer that downloads application components during setup | [NoxReel-WebSetup-0.5.1.exe](https://github.com/Felis-desuwa/NoxReel/releases/latest/download/NoxReel-WebSetup-0.5.1.exe) |
| Android beta | Join a desktop room as a viewer | [app-debug.apk](https://github.com/Felis-desuwa/NoxReel/releases/latest/download/app-debug.apk) |
| SHA-256 | Verify downloaded files | [SHA256SUMS.txt](https://github.com/Felis-desuwa/NoxReel/releases/latest/download/SHA256SUMS.txt) |

> [!NOTE]
> The Windows installers are not currently signed with a commercial code-signing certificate, so Windows may display an “Unknown publisher” warning. Download only from this repository’s [Releases](https://github.com/Felis-desuwa/NoxReel/releases) page.

## Quick start

1. Install and open NoxReel.
2. In Settings, choose Safe mode (default) or Trusted room. The host and every member must select the same mode locally.
3. Create a room and set its capacity.
4. Choose a local video or paste a supported video link.
5. Send the short invite code to the other members.
6. After they join, the host can synchronize play, pause, and seek operations.

```text
Local video → Direct WebRTC P2P
Video link → Each member connects to the source site
             ↓
Safe mode: verify and scan the complete file before playback
Trusted room: start near 8 MB and scan after full receipt
                         ↕
                Synchronized room state
```

## Connection methods

| Method | Workflow | Server required | Best for |
|---|---|---:|---|
| Short-code room | Paste one invite code | Lightweight signaling server | Everyday multi-person rooms |
| Manual two-code exchange | Exchange an invite code and answer code | No | Temporary use or no signaling deployment |

The signaling server exchanges SDP, ICE, and room state only. It never reads or stores video content. Strict NAT, CGNAT, or firewall environments may require a self-hosted TURN relay.

## Privacy and content boundaries

- Local video chunks travel over encrypted WebRTC connections between members.
- Every member loads video links directly from the original website; the NoxReel signaling server does not relay them. Short-lived Android playback URLs travel only through an authenticated room connection and exclude Cookie and Authorization headers.
- User-selected source videos are never deleted. Generated receive caches do not remain in Downloads and do not support cross-restart resume.
- The desktop app enables the Chromium sandbox, context isolation, strict CSP, and allowlisted privileged IPC.
- Nicknames, member information, and errors are rendered as text rather than executable HTML.
- Received media is limited to MP4, M4V, MOV, and MKV, with extension, container header, and per-chunk hash validation. Safe mode plays after the complete file passes a local scan; Trusted room intentionally plays before that scan is complete.
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
| mpv | Video playback and IPC control |
| WebRTC DataChannel | P2P video chunk transfer |
| WebSocket | Optional signaling service |
| yt-dlp | Public video link parsing |

Local files use per-chunk verification and a contiguous playback watermark. A bounded memory cache and merged adjacent writes reduce repeated disk reads and small writes. Safe mode gives the cache path to mpv only after the complete file passes a local scan. Trusted rooms start after roughly 8 MB of contiguous initial data and scan after full receipt.

</details>

<details>
<summary><strong>Current limitations</strong></summary>

- Public-internet NAT traversal depends on both networks and cannot be guaranteed.
- Users must provide their own TURN relay and credentials.
- The 10 GB limit is supported by manifest splitting and sparse-file logic; the largest current end-to-end real-media test is 1.75 GB.
- Android remains a beta viewer and can receive local videos or host-resolved video links.
- Website support changes with yt-dlp and the source site. If a short-lived stream expires, the host must switch to that link again.
- Safe mode requires an available Microsoft Defender installation to automatically play local video received from another member. Trusted rooms start before the final scan and should be used only when every participant trusts the host and content source.

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
npm run dist:offline  # Build the full Windows installer
npm run dist:web      # Build the Windows web installer
```

The full installer bundles mpv and yt-dlp. Source builds can also use compatibility environment variables:

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
