# Studio Bridge MCP — Adobe After Effects & Premiere Pro MCP Server (CEP + UXP + FFmpeg)

[![GitHub Stars](https://img.shields.io/github/stars/sergiopayares-creator/studio-bridge-mcp?style=for-the-badge&logo=github&label=Stars&color=yellow)](https://github.com/sergiopayares-creator/studio-bridge-mcp/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](./LICENSE)
[![MCP Server](https://img.shields.io/badge/MCP-WebSocket%20%2B%20HTTP-00c853?style=for-the-badge)](https://modelcontextprotocol.io)
[![Adobe AE & Premiere](https://img.shields.io/badge/Adobe-After%20Effects%20%26%20Premiere%20Pro-9999FF?style=for-the-badge&logo=adobe)](https://github.com/sergiopayares-creator/studio-bridge-mcp)

> **Real-time WebSocket (`8765`) & Shared HTTP Broker (`8766`) Model Context Protocol (MCP) server for Adobe After Effects, Adobe Premiere Pro (CEP + UXP 25.6+), and local FFmpeg / Whisper post-production.**
>
> **Author:** Sergio Payares · **License:** [MIT](./LICENSE)
>
> ⭐ **If Studio Bridge MCP saves you time or helps your workflow, please click the [Star ⭐ button](https://github.com/sergiopayares-creator/studio-bridge-mcp) in the top-right corner of this repository!** Stars help more creators and developers discover the project on GitHub.

**Studio Bridge MCP** connects AI coding and creative agents (**Claude Desktop, Claude Code, Cursor, Windsurf, Cline, and custom MCP agents**) directly to **Adobe After Effects** and **Adobe Premiere Pro** over a persistent, low-latency WebSocket bridge—eliminating slow `/tmp` file-polling and context-bloating 400-tool schemas.

---

## Why Studio Bridge MCP?

Most **After Effects MCP** and **Premiere Pro MCP** integrations rely on `/tmp` file-polling or expose hundreds of fragmented tools that saturate an LLM's context window. **Studio Bridge MCP** is engineered for deterministic, high-retention video production:

| Feature | Typical Adobe MCP Servers | Studio Bridge MCP |
| :--- | :--- | :--- |
| **Host Transport** | `/tmp` file-polling every 1–3 seconds | **Real-time WebSocket (`127.0.0.1:8765`)** + sequential command mutex |
| **Multi-Agent Support** | Single `stdio` process locks the port | **Shared HTTP Broker (`127.0.0.1:8766/mcp`)** for multiple simultaneous agents |
| **Context Footprint** | 250–1,200 separate tool schemas | **16 compact MCP tools** via 3 multiplexed toolkits + on-demand `adobe_guide` |
| **Apps Covered** | Either Premiere OR After Effects | **After Effects (CEP) + Premiere Pro (CEP & UXP 25.6+) + FFmpeg / Whisper** |
| **Visual Verification** | Blind script execution | **Native `renderFrame`, `contactSheet`, and `compare`** returning PNG/JPEG blocks |
| **Security & Tests** | Unauthenticated local eval | **256-bit Bearer auth, strict localhost CORS, action allowlist, 85+ automated tests** |

---

## Key Capabilities

1. **Real-Time WebSocket + Shared Multi-Agent HTTP Broker:**
   - The CEP/UXP panels maintain a persistent WebSocket connection (`127.0.0.1:8765`) with a sequential command mutex to prevent `EvalScript` thread collisions.
   - `broker.js` exposes a shared Streamable HTTP MCP endpoint (`127.0.0.1:8766/mcp`) so multiple AI clients can control Adobe simultaneously without port conflicts.
2. **Token-Efficient Multiplexed Toolkits (16 MCP Tools):**
   - Instead of loading 400+ tool schemas on every turn, Studio Bridge MCP groups deterministic host operations into three strongly-typed toolkits (`aftereffects_toolkit`, `premiere_toolkit`, `premiere_uxp_toolkit`) plus an on-demand `adobe_guide` reference.
3. **Visual Verification ("Eyes for the Agent"):**
   - Native `renderFrame`, `contactSheet`, and `compare` verbs return rendered PNG/JPEG visual blocks directly into the model context so the agent can measure and verify layout, typography, and motion before finishing.
4. **Defense-in-Depth Security:**
   - Per-install random 256-bit token (`~/.antigravity-studio-bridge/.bridge-secret`) required via `Authorization: Bearer <token>` on `/mcp`, `/health`, and `/inject`.
   - Strict `localhost` / `127.0.0.1` CORS policy.
   - Client-side action allowlist (`extension/client/js/bridge-actions.js`) validated before any `cs.evalScript`.
   - File outputs scoped to `ANTIGRAVITY_WRITABLE_ROOTS`, and arbitrary ExtendScript evaluation disabled by default unless `STUDIO_BRIDGE_ALLOW_ARBITRARY_JS=1` is explicitly set.

---

## Exposed MCP Tools (16)

| Category | Tool Name | Purpose |
| :--- | :--- | :--- |
| **After Effects (CEP)** | `aftereffects_toolkit` | Deterministic verbs: `project`, `catalog`, `comp`, `layer`, `settings`, `shape`, `shapeGroup`, `fill`, `text`, `textStyle`, `textAnimator`, `camera`, `light`, `effect`, `effectParam`, `effectKey`, `transform`, `keyframe`, `set`, `ensureKeysAfter`, `expression`, `mask`, `roto`, `tracker`, `marker`, `import`, `folder`, `items`, `measure`, `alignAnchor`, `zStack`, `pose`, `check`, `halo`, `batch`, `render`, `renderOutput`, `renderFrame`, `contactSheet`, `compare`, `selection`, `save`. |
| **Premiere Pro (CEP)** | `premiere_toolkit` | Deterministic verbs: `catalog`, `project`, `insert`, `overwrite`, `razor`, `removeClip`, `subclip`, `applyTransition`, `applyEffect`, `marker`, `clearMarkers`, `clipMotion`, `clipVolume`, `clipSpeed`, `assemble`, `import`, `bin`, `export`, `importSrt`, `renderFrame`, `contactSheet`, `save`, `saveSafe`. |
| **Premiere Pro (UXP)** | `premiere_uxp_toolkit` | Modern Premiere 25.6+ UXP panel verbs: `status`, `effectsList`, `effectsAdd`, `effectsRemove`, `clipParams`, `clipParamSet`. |
| **Documentation** | `adobe_guide` | Read-only engine invariants, coordinate math, easing rules, and verb reference for AE, Premiere, and UXP. |
| **Local FFmpeg / Audio** | `video_get_info` | Probe resolution, codec, FPS, duration, and audio streams via `ffprobe`. |
| | `video_lossless_cut` | Instant stream-copy (`-c copy`) segment trimming without re-encoding. |
| | `video_extract_audio` | Extract clean WAV/MP3 audio tracks for transcription or analysis. |
| | `video_detect_silences` | Zero-token local silence detection and EDL cut-list generation. |
| | `video_generate_proxy` | Generate lightweight editing proxies. |
| | `video_extract_frame` | Extract still PNG frames from any media file at an exact timestamp. |
| | `video_contact_sheet` | Build a timestamped multi-frame JPEG contact sheet from any video. |
| | `video_transcribe` | Local Whisper word-level transcription and SRT generation. |
| **Bridge & Raw Execution** | `adobe_get_project_snapshot` | Full structural snapshot of the active Premiere or After Effects project. |
| | `adobe_cep_bridge_status` | Live WebSocket connection health for CEP and UXP targets. |
| | `adobe_cep_bridge_command` | Dispatch allowlisted panel macros (`getSummary`, `cutAtPlayhead`, `addMarker`, etc.). |
| | `aftereffects_execute_extendscript` | Gated raw ExtendScript execution (requires `STUDIO_BRIDGE_ALLOW_ARBITRARY_JS=1`). |
| | `adobe_panel_notify` / `adobe_get_panel_prompts` | Two-way interactive chat and progress stepper inside the Adobe CEP panel UI. |

---

## Quick Start (Claude Code, Cursor, Claude Desktop, Windsurf)

### Prerequisites

- **Node.js 20+** (LTS)
- **FFmpeg** available on `PATH` (required for `renderFrame` JPEG recompression, `contactSheet`, `compare`, and local video/audio tools)
- **Adobe After Effects** and/or **Adobe Premiere Pro** (CC 2020–2027+)
- *(Optional)* Local `whisper.cpp` via `mcp-video-server/setup-whisper.ps1` for `video_transcribe`

### 1. Install Dependencies & CEP Extension

- **Windows (PowerShell or double-click `Instalar-Studio-Bridge.bat`):**
  ```powershell
  powershell -ExecutionPolicy Bypass -File .\install.ps1
  ```

- **macOS:**
  ```bash
  chmod +x install.sh
  ./install.sh
  ```

Both installers enable `PlayerDebugMode`, link `extension/` into Adobe's CEP extensions folder, and run `npm install` inside `mcp-video-server/`.

Restart **Premiere Pro** / **After Effects** and open the panel once under:
`Window > Extensions > Studio Bridge`

*(For Premiere Pro 25.6+ UXP capabilities, load the `uxp-premiere/` folder via the Adobe UXP Developer Tool).*

### 2. Connect Your MCP Client

Set `ANTIGRAVITY_WRITABLE_ROOTS` to the project/export folders the agent is allowed to write to (separated by `;` on Windows or `:` on macOS). Without it, write operations (`save`, `renderOutput`, `export`, custom output paths) fail closed. Arbitrary ExtendScript (`aftereffects_execute_extendscript`) stays disabled unless `STUDIO_BRIDGE_ALLOW_ARBITRARY_JS=1` is explicitly set.

- **Single-Client Mode (`stdio` — Claude Desktop / Cursor / Windsurf):**
  ```json
  {
    "mcpServers": {
      "studio-bridge-mcp": {
        "command": "node",
        "args": ["/absolute/path/to/studio-bridge-mcp/mcp-video-server/index.js"],
        "env": {
          "ANTIGRAVITY_WRITABLE_ROOTS": "/absolute/path/to/projects;/absolute/path/to/renders"
        }
      }
    }
  }
  ```

- **Multi-Agent Shared Broker Mode (`HTTP 8766`):**
  Start the broker once with your writable roots exported:
  ```powershell
  # Windows PowerShell
  $env:ANTIGRAVITY_WRITABLE_ROOTS = "C:\Projects;C:\Renders"
  node mcp-video-server/broker.js
  ```
  ```bash
  # macOS / Linux
  ANTIGRAVITY_WRITABLE_ROOTS="/path/to/projects:/path/to/renders" node mcp-video-server/broker.js
  ```
  Then connect any MCP client using the generated Bearer token in `~/.antigravity-studio-bridge/.bridge-secret`:
  ```json
  {
    "mcpServers": {
      "studio-bridge-mcp": {
        "type": "http",
        "url": "http://127.0.0.1:8766/mcp",
        "headers": {
          "Authorization": "Bearer <your-bridge-secret>"
        }
      }
    }
  }
  ```

### 3. Verify Installation

1. Check the broker health endpoint (in broker mode):
   ```bash
   curl -H "Authorization: Bearer $(cat ~/.antigravity-studio-bridge/.bridge-secret)" http://127.0.0.1:8766/health
   ```
2. Call `adobe_cep_bridge_status` from your AI agent to confirm `connectedApps` lists `After Effects` and/or `Premiere Pro`.
3. Run the automated test suite below to verify local dependencies.

---

## Running the Test Suite

```bash
cd mcp-video-server
npm test
```

Includes **85+ deterministic assertions** validating Bearer authentication, CORS isolation, client action allowlists, strict ES3 compilation for `toolkit.jsx` and `toolkit_ae.jsx`, PNG trailer validation, contact-sheet image packaging, and UXP isolation.

---

## ⭐ Support & Star the Project

If **Studio Bridge MCP** is useful for your video editing, motion graphics, or AI agent workflows:
- Give this repository a **⭐ Star** at the top-right of [github.com/sergiopayares-creator/studio-bridge-mcp](https://github.com/sergiopayares-creator/studio-bridge-mcp).
- Share it with other creators building with **Claude Code**, **Cursor**, **After Effects**, and **Premiere Pro**.

---

## License & Attribution

Released under the [MIT License](./LICENSE).
**Copyright (c) 2026 Sergio Payares.** Any redistribution, fork, or derivative work must preserve the original copyright notice and license terms.
