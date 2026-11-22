# Studio Bridge — Servidor MCP (agnóstico de agente)

El Bridge expone Adobe Premiere Pro y After Effects a **cualquier agente que hable MCP**
(Hermes/Antigravity, DeepSeek, Claude Code, Cursor, etc.), no solo a Google.

## 1. Dos modos de conexión

### Modo compartido (recomendado, varios agentes a la vez)
Un solo proceso, el **broker**, es dueño del puente con Adobe (8765) y expone MCP por HTTP
(8766). Hermes, DeepSeek, Antigravity o cualquier agente se conectan **al mismo broker** sin
pelear por el puerto; los comandos se encolan y nunca chocan.

1. Arranca el broker una vez: `start-broker.bat` (o `node broker.js`).
   - Auto-arranque: pon un acceso directo a `start-broker-hidden.vbs` en `shell:startup`.
2. En cada agente registra el MCP **HTTP**:

```json
{
  "mcpServers": {
    "studio-bridge": {
      "type": "http",
      "url": "http://127.0.0.1:8766/mcp"
    }
  }
}
```

> Si el broker dice `el puerto 8765 ya está ocupado`, hay otro proceso con el puente
> (p. ej. un agente en modo stdio). Ciérralo y vuelve a arrancar el broker.

### Modo individual (un solo agente, sin broker)
`node index.js` habla MCP por **stdio**. Solo un agente puede usarlo a la vez porque es
dueño del 8765.

```json
{
  "mcpServers": {
    "studio-bridge": {
      "command": "node",
      "args": ["<RUTA>\\mcp-video-server\\index.js"]
    }
  }
}
```

- El panel CEP debe estar abierto en Adobe (`Ventana > Extensiones > Studio Bridge`) para que los comandos lleguen al host.

## 2. Herramientas disponibles

| Herramienta | Qué hace |
|---|---|
| `adobe_cep_bridge_status` | Estado del puente: escuchando, apps conectadas, AE instalado |
| `adobe_get_project_snapshot` | Snapshot acotado de la secuencia (Premiere) o composición (AE) |
| `adobe_cep_bridge_command` | Comando genérico al host (`evalScript`, `getProjectSnapshot`, macros…) |
| `adobe_panel_notify` | Envía mensajes/avance de tarea al panel |
| `adobe_get_panel_prompts` | Lee prompts enviados desde el panel |
| `aftereffects_execute_extendscript` | Ejecuta ExtendScript en AE (con resultado JSON) |
| `video_get_info` | Metadata de un video/audio (ffprobe) |
| `video_lossless_cut` | Corte sin recodificar |
| `video_extract_audio` | Extrae audio (WAV/MP3) |
| `video_detect_silences` | Detecta silencios (local, sin tokens) |
| `video_generate_proxy` | Genera proxy de edición |
| `video_extract_frame` | **"Ojos"**: extrae un frame JPEG + base64 para que el agente lo vea |
| `video_transcribe` | **"Oídos"**: transcribe voz con whisper.cpp local (offline) |

## 3. Seguridad

- El servidor escucha solo en `127.0.0.1:<puerto>` (por defecto `8765`, configurable con `ANTIGRAVITY_BRIDGE_PORT`).
- El token se genera por usuario en `~/.antigravity-studio-bridge/.bridge-secret` (nunca se envía por defecto).
- Se valida `Origin`/`Host` en el upgrade WebSocket (anti DNS-rebinding).
- Restricción de escritura: define `ANTIGRAVITY_WRITABLE_ROOTS` (rutas separadas por `;`) para limitar dónde pueden escribir las herramientas destructivas (corte/proxy/audio). Sin configurarla, se permite cualquier ruta (comportamiento anterior).
- Los argumentos numéricos de ffmpeg se validan estrictamente (anti inyección de filtro).

## 4. "Oídos" (transcripción local)

1. Ejecuta una vez `.\setup-whisper.ps1` (descarga whisper.cpp + modelo multilingüe).
   - `-Model small` para mejor calidad, `-Model base` (por defecto), `-Model tiny` para velocidad.
2. Listo: `video_transcribe` funcionará 100% offline.
3. Variables opcionales: `WHISPER_BIN` y `WHISPER_MODEL` para rutas personalizadas.

## 5. Pruebas

```
cd mcp-video-server
npm test            # o: node --test test/*.test.js
```

## 6. Empaquetado del panel CEP

```
node build-package.js     # genera dist/*.zxp + instalador universal (Win/Mac)
```
