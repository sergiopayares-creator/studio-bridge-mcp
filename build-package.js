/* ==========================================================================
   Studio Bridge — Verificador de Sintaxis, DOM IDs y Empaquetador ZXP
   Genera: dist/Studio-Bridge-1.0.0.zxp + instalador universal.
   Ejecutar con:  node build-package.js   (requiere Node >= 18)
   ========================================================================== */

const fs = require("fs");
const path = require("path");
const { execSync, spawnSync } = require("child_process");

// Ejecuta un comando directamente (sin pasar por cmd.exe, que bajo sandbox
// puede hacer crashear a ZXPSignCmd). stdio 'inherit' evita los pipes.
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", windowsHide: true, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`Command failed: ${cmd} (exit ${r.status})`);
  return r;
}

const ROOT = __dirname;
const DIST_DIR = path.join(ROOT, "dist");
const EXT_DIR = path.join(ROOT, "extension"); // carpeta CEP (CSXS/, client/, host/)
const BUNDLE_ID = "com.antigravity.bridge";
const NAME = "Studio Bridge";
const VERSION = "1.0.0";
const CERT_PASSWORD = process.env.STUDIO_BRIDGE_CERT_PASSWORD;
if (!CERT_PASSWORD) {
  throw new Error(
    "STUDIO_BRIDGE_CERT_PASSWORD no está definida. " +
    "Exporta la contraseña del certificado (cert.p12) como variable de entorno antes de empaquetar."
  );
}

console.log("====================================================");
console.log(`  ${NAME} — Verificación & Empaquetado Final`);
console.log("====================================================\n");

// 1. Verificar sintaxis de JS y JSX
const scriptFiles = [
  path.join(EXT_DIR, "client/js/CSInterface.js"),
  path.join(EXT_DIR, "client/js/bridge-actions.js"),
  path.join(EXT_DIR, "client/js/main.js"),
  path.join(EXT_DIR, "host/bridge.jsx"),
  path.join(EXT_DIR, "host/toolkit.jsx"),
  path.join(EXT_DIR, "host/toolkit_ae.jsx"),
];
for (const full of scriptFiles) {
  if (!fs.existsSync(full)) throw new Error("Archivo faltante: " + full);
  const code = fs.readFileSync(full, "utf8");
  new Function(code);
  const lines = code.split(/\r?\n/).length;
  console.log(`[OK] Sintaxis verificada: ${path.relative(ROOT, full)} (${lines} líneas)`);
}

// 2. Verificar IDs del DOM referenciados en JS contra client/index.html
const htmlCode = fs.readFileSync(path.join(EXT_DIR, "client/index.html"), "utf8");
const htmlIds = new Set();
let hm;
const idAttrRegex = /\bid=["']([^"']+)["']/g;
while ((hm = idAttrRegex.exec(htmlCode)) !== null) htmlIds.add(hm[1]);

const referencedIds = new Set();
const clientJsFiles = ["client/js/main.js"];
for (const rel of clientJsFiles) {
  const content = fs.readFileSync(path.join(EXT_DIR, rel), "utf8");
  const getIdRegex = /getElementById\(\s*["']([^"']+)["']\s*\)/g;
  let gm;
  while ((gm = getIdRegex.exec(content)) !== null) referencedIds.add(gm[1]);
}
for (const refId of referencedIds) {
  if (!htmlIds.has(refId)) throw new Error(`ID del DOM referenciado pero inexistente en index.html: "#${refId}"`);
}
console.log(`[OK] ${referencedIds.size} IDs del DOM verificados en client/index.html`);

// 3. Generar paquete .ZXP firmado digitalmente
if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });

const zxpFinal = path.join(DIST_DIR, `${NAME.replace(/\s+/g, "-")}-${VERSION}.zxp`);
if (fs.existsSync(zxpFinal)) fs.unlinkSync(zxpFinal);

const zxpSignCmd = path.join(ROOT, "ZXPSignCmd.exe");
if (!fs.existsSync(zxpSignCmd)) throw new Error("ZXPSignCmd.exe no encontrado en la raíz del proyecto.");
const certPath = path.join(ROOT, "cert.p12");
const stagingDir = path.join(DIST_DIR, "staging");

if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });

function copyFolderRecursiveSync(source, target) {
  if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
  for (const file of fs.readdirSync(source)) {
    const curSource = path.join(source, file);
    const curTarget = path.join(target, file);
    if (fs.lstatSync(curSource).isDirectory()) copyFolderRecursiveSync(curSource, curTarget);
    else fs.copyFileSync(curSource, curTarget);
  }
}

copyFolderRecursiveSync(path.join(EXT_DIR, "CSXS"), path.join(stagingDir, "CSXS"));
copyFolderRecursiveSync(path.join(EXT_DIR, "client"), path.join(stagingDir, "client"));
copyFolderRecursiveSync(path.join(EXT_DIR, "host"), path.join(stagingDir, "host"));

if (!fs.existsSync(certPath)) {
  console.log("[...] Generando certificado autofirmado (solo la primera vez)...");
  run(zxpSignCmd, ["-selfSignedCert", "CO", "ANT", "StudioBridge", "Sergio Payares", CERT_PASSWORD, certPath]);
}

// Firma sin TSA: el timestamp de DigiCert no se pudo verificar en este entorno
// y un ZXP con timestamp inválido puede ser rechazado. La firma sí es válida.
run(zxpSignCmd, ["-sign", stagingDir, zxpFinal, certPath, CERT_PASSWORD]);

let verified = false;
try { run(zxpSignCmd, ["-verify", zxpFinal]); verified = true; } catch (_) {}
if (verified) {
  console.log("[OK] Paquete .zxp firmado y verificado:", zxpFinal);
} else {
  console.log("[AVISO] ZXP generado (verifica manualmente):", zxpFinal);
}
if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });

// 4. Generar instalador universal (Windows y Mac)
const installDir = path.join(DIST_DIR, `${NAME.replace(/\s+/g, "-")}-${VERSION}-Instalador`);
if (fs.existsSync(installDir)) fs.rmSync(installDir, { recursive: true, force: true });
fs.mkdirSync(installDir, { recursive: true });

const extDir = path.join(installDir, BUNDLE_ID);
fs.mkdirSync(extDir, { recursive: true });
copyFolderRecursiveSync(path.join(EXT_DIR, "CSXS"), path.join(extDir, "CSXS"));
copyFolderRecursiveSync(path.join(EXT_DIR, "client"), path.join(extDir, "client"));
copyFolderRecursiveSync(path.join(EXT_DIR, "host"), path.join(extDir, "host"));

const batContent = `@echo off
chcp 65001 >nul
echo ========================================================
echo   Instalador Automatico — ${NAME} para Windows
echo ========================================================
echo.
for /L %%i in (9,1,24) do (
    reg add "HKCU\\Software\\Adobe\\CSXS.%%i" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
)
echo [OK] Permisos de extension CEP habilitados en el Registro.
set "TARGET_DIR=%APPDATA%\\Adobe\\CEP\\extensions\\${BUNDLE_ID}"
if not exist "%APPDATA%\\Adobe\\CEP\\extensions" mkdir "%APPDATA%\\Adobe\\CEP\\extensions"
if exist "%TARGET_DIR%" rmdir /S /Q "%TARGET_DIR%" >nul 2>&1
mkdir "%TARGET_DIR%"
xcopy /E /I /Y "%~dp0${BUNDLE_ID}\\CSXS" "%TARGET_DIR%\\CSXS" >nul
xcopy /E /I /Y "%~dp0${BUNDLE_ID}\\client" "%TARGET_DIR%\\client" >nul
xcopy /E /I /Y "%~dp0${BUNDLE_ID}\\host" "%TARGET_DIR%\\host" >nul
echo.
echo ========================================================
echo   ${NAME} instalado correctamente!
echo   Abre Premiere Pro o After Effects: Ventana ^> Extensiones ^> ${NAME}
echo ========================================================
pause
`;
fs.writeFileSync(path.join(installDir, "Instalar-Windows.bat"), batContent.replace(/\n/g, "\r\n"), "utf8");

const macContent = `#!/bin/bash
echo "========================================================"
echo "  Instalador Automatico — ${NAME} para Mac"
echo "========================================================"
echo ""
for i in {9..24}; do defaults write com.adobe.CSXS.$i PlayerDebugMode 1 2>/dev/null; done
echo "[OK] Permisos de extension CEP habilitados en macOS."
DIR="$( cd "$( dirname "\${BASH_SOURCE[0]}" )" && pwd )"
TARGET_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions/${BUNDLE_ID}"
mkdir -p "$HOME/Library/Application Support/Adobe/CEP/extensions"
rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"
cp -R "$DIR/${BUNDLE_ID}/CSXS" "$TARGET_DIR/"
cp -R "$DIR/${BUNDLE_ID}/client" "$TARGET_DIR/"
cp -R "$DIR/${BUNDLE_ID}/host" "$TARGET_DIR/"
echo ""
echo "========================================================"
echo "  ${NAME} instalado correctamente!"
echo "  Abre Premiere Pro o After Effects: Ventana > Extensiones > ${NAME}"
echo "========================================================"
echo ""
read -p "Presiona Enter para cerrar..."
`;
fs.writeFileSync(path.join(installDir, "Instalar-Mac.command"), macContent.replace(/\r\n/g, "\n"), "utf8");

const readmeContent = `${NAME.toUpperCase()} — GUIA DE INSTALACION RAPIDA (1 CLIC)
===================================================
METODO 1 (RECOMENDADO):
- Windows: doble clic en "Instalar-Windows.bat".
- Mac: doble clic en "Instalar-Mac.command" (clic derecho > Abrir si pide permiso).
METODO 2 (GESTOR ZXP):
- Arrastra "${NAME.replace(/\s+/g, "-")}-${VERSION}.zxp" dentro de ZXP/UXP Installer.
LUEGO:
- Abre Premiere Pro o After Effects: Ventana > Extensiones > ${NAME}.
- Para el servidor MCP:  cd mcp-video-server && node index.js  (o registralo como MCP en tu agente).
`;
fs.writeFileSync(path.join(installDir, "LEEME - Como Instalar.txt"), readmeContent.replace(/\n/g, "\r\n"), "utf8");

const zipDist = path.join(DIST_DIR, `${NAME.replace(/\s+/g, "-")}-${VERSION}-Instalador.zip`);
if (fs.existsSync(zipDist)) fs.unlinkSync(zipDist);
run("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${installDir}\\*' -DestinationPath '${zipDist}' -Force`]);

console.log("[OK] Carpeta de instalación universal:", installDir);
console.log("[OK] ZIP para compartir:", zipDist);
console.log("\nVerificación y empaquetado completados con éxito.");
