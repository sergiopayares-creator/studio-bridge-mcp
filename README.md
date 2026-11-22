# Studio Bridge MCP — Adobe After Effects & Premiere Pro MCP Server (CEP + UXP + FFmpeg)

> **Real-time WebSocket (`8765`) & Shared HTTP Broker (`8766`) Model Context Protocol (MCP) server for Adobe After Effects, Adobe Premiere Pro (CEP + UXP 25.6+), and local FFmpeg / Whisper post-production.**
>
> **Author:** Sergio Payares · **License:** [MIT](./LICENSE)

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
| **Security & Tests** | Unauthenticated local eval | **256-bit Bearer auth, strict localhost CORS, action allowlist, 81+ automated tests** |

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
| **After Effects (CEP)** | `aftereffects_toolkit` | Deterministic verbs: `status`, `measure`, `pose`, `check`, `comp`, `layer`, `text`, `textStyle`, `shape`, `set`, `ensureKeysAfter`, `zStack`, `settings`, `effects`, `mask`, `camera`, `precomp`, `markers`, `importFile`, `renderFrame`, `contactSheet`, `compare`, `renderOutput`, `save`, `undo`. |
| **Premiere Pro (CEP)** | `premiere_toolkit` | Deterministic verbs: `status`, `inspect`, `sequence`, `importFile`, `place`, `trim`, `split`, `rippleDelete`, `transition`, `transform`, `clipVolume`, `audioDuck`, `colorGrade`, `markers`, `importSrt`, `captions`, `renderFrame`, `contactSheet`, `exportMedia`, `save`. |
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

### 1. Install Dependencies & CEP Extension

```powershell
# 1. Install MCP server dependencies
cd mcp-video-server
npm install
cd ..

# 2. Install the CEP panel into Adobe's extensions directory (Windows)
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Open **Premiere Pro** or **After Effects** and enable the panel under:
`Window > Extensions > Studio Bridge`

*(For Premiere Pro 25.6+ UXP capabilities, load the `uxp-premiere/` folder via the Adobe UXP Developer Tool).*

### 2. Connect Your MCP Client

- **Single-Client Mode (`stdio` — Claude Desktop / Cursor / Windsurf):**
  ```json
  {
    "mcpServers": {
      "studio-bridge-mcp": {
        "command": "node",
        "args": ["/absolute/path/to/studio-bridge-mcp/mcp-video-server/index.js"]
      }
    }
  }
  ```

- **Multi-Agent Shared Broker Mode (`HTTP 8766`):**
  Start the broker once:
  ```bash
  node mcp-video-server/broker.js
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

---

## Running the Test Suite

```bash
cd mcp-video-server
npm test
```

Includes **81+ deterministic assertions** validating Bearer authentication, CORS isolation, client action allowlists, strict ES3 compilation for `toolkit.jsx` and `toolkit_ae.jsx`, contact-sheet image packaging, and UXP isolation.

---

## License & Attribution

Released under the [MIT License](./LICENSE).
**Copyright (c) 2026 Sergio Payares.** Any redistribution, fork, or derivative work must preserve the original copyright notice and license terms.
