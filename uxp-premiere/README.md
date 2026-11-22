# Studio Bridge UXP (Premiere)

Plugin UXP para **Premiere Pro v25.6+ / v27.0** que conecta con el broker local de
Studio Bridge (`ws://127.0.0.1:8765`) y expone la herramienta MCP
`premiere_uxp_toolkit`: efectos por `matchName`, parámetros de MOGRT
(Essential Graphics) y transacciones con Undo atómico.

## Requisitos

- Premiere Pro 25.6 o superior (UXP).
- Broker de Studio Bridge en ejecución (`start-broker.bat` / `node broker.js`),
  que crea `%USERPROFILE%\.antigravity-studio-bridge\.bridge-secret`.
- Adobe UXP Developer Tool (UDT).

## Carga en Premiere v27.0

1. Abre Premiere Pro 27.0 y el **UXP Developer Tool**.
2. En UDT: **Add Plugin** → selecciona `uxp-premiere/manifest.json`.
3. Pulsa **Load** sobre `Studio Bridge UXP (Premiere)`.
4. En Premiere: `Window > Extensions (legacy)` / panel UXP → abre
   **Studio Bridge UXP**. Debe mostrar `EN LÍNEA`.
5. Si aparece `DESCONECTADO`, pulsa **Reconectar**: el panel reintenta cada 4 s.

El token se lee de `~/.antigravity-studio-bridge/.bridge-secret` con
`require('fs')`/`require('os')` y, si UXP no expone Node, con
`uxp.storage.localFileSystem` (`fullAccess`). No se usa
`allowCodeGenerationFromStrings`: solo verbos tipados.

## Verbos (`premiere_uxp_toolkit`)

| Verbo | Parámetros | Qué hace |
|---|---|---|
| `status` | — | Host, versión, proyecto, secuencia activa y secuencias. |
| `effectsList` | `filter?` (regex) | Lista `VideoFilterFactory.getMatchNames()`. |
| `effectsAdd` | `matchName`, `sequence?`, `kind?`, `track?` (0-based), `clips?[]`, `name?` (regex) | Añade el efecto en una transacción Undo atómica. |
| `effectsRemove` | `match` (regex), selección de clips | Quita componentes (protege Motion, Opacity, Time Remapping, Volume, Channel Volume, Panner). |
| `clipParams` | selección de clips | Lee componentes/parámetros, colores `[r,g,b,a]` y `keyframed` (incluye MOGRT). |
| `clipParamSet` | `component` (regex), `param` (nombre o índice), `value`, `at?` (s) | Escribe un parámetro; con `at` añade keyframe. |

## Notas

- El panel UXP es independiente del panel CEP: `premiere_toolkit` (ExtendScript/QE)
  nunca se envía a `premiere_uxp`, y este toolkit no ejecuta ExtendScript.
- Los clips se localizan por `kind` (`video`/`audio`), `track` (0-based),
  `clips` (índices) y `name` (regex).
- Si el proyecto está cerrado o no hay secuencia activa, los verbos devuelven
  `{ ok: false, error }`.
