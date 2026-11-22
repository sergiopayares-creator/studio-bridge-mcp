/**
 * Studio Bridge — Client Controller
 * Conexión WebSocket directa y bidireccional entre Adobe CEP y el Agente Antigravity
 * Con cola secuencial de ejecución ExtendScript (Anti-Colisión)
 */
(function() {
    var cs = new CSInterface();
    var ws = null;
    var hostApp = 'Premiere Pro';
    var reconnectTimer = null;
    var currentToken = null;

    // Elementos DOM
    var headerDot = document.getElementById('headerDot');
    var statusBadge = document.getElementById('statusBadge');
    var statusText = document.getElementById('statusText');
    var btnReload = document.getElementById('btnReload');
    var btnReconnect = document.getElementById('btnReconnect');
    var btnClearLog = document.getElementById('btnClearLog');
    var hostAppText = document.getElementById('hostAppText');
    var tokenStatusText = document.getElementById('tokenStatusText');
    var logConsole = document.getElementById('logConsole');

    // Stepper DOM
    var taskStepperWidget = document.getElementById('taskStepperWidget');
    var stepperTaskName = document.getElementById('stepperTaskName');
    var stepperTaskSubtitle = document.getElementById('stepperTaskSubtitle');
    var stepperPercent = document.getElementById('stepperPercent');
    var stepperProgressBar = document.getElementById('stepperProgressBar');
    var stepperStepsList = document.getElementById('stepperStepsList');

    // Cola secuencial de ejecución de ExtendScript (garantiza 1 script activo a la vez en Adobe)
    var scriptExecutionQueue = Promise.resolve();

    // =========================================================================
    // 1. REGISTRO Y DETECCIÓN DEL HOST
    // =========================================================================
    function log(msg, type) {
        if (!logConsole) return;
        var el = document.createElement('div');
        el.className = 'log-entry ' + (type || 'info');
        var now = new Date();
        var time = [
            String(now.getHours()).padStart(2, '0'),
            String(now.getMinutes()).padStart(2, '0'),
            String(now.getSeconds()).padStart(2, '0')
        ].join(':');
        el.textContent = '[' + time + '] ' + msg;
        logConsole.appendChild(el);
        logConsole.scrollTop = logConsole.scrollHeight;
    }

    try {
        var hostEnv = cs.getHostEnvironment();
        if (hostEnv && hostEnv.appId) {
            if (hostEnv.appId === 'PPRO') hostApp = 'Premiere Pro';
            else if (hostEnv.appId === 'AEFT') hostApp = 'After Effects';
            else if (hostEnv.appId === 'AME') hostApp = 'Media Encoder';
            else hostApp = hostEnv.appId;
        }
    } catch (e) {
        log('Error detectando host: ' + e, 'error');
    }
    if (hostAppText) hostAppText.textContent = hostApp;

    function getSecretToken() {
        if (currentToken) return currentToken;

        try {
            if (typeof require === 'undefined') {
                throw new Error('Node.js access is unavailable in this CEP panel');
            }
            var fs = require('fs');
            var path = require('path');
            var os = require('os');
            var tokenFile = path.join(os.homedir(), '.antigravity-studio-bridge', '.bridge-secret');

            if (!fs.existsSync(tokenFile)) {
                throw new Error('Per-user bridge secret was not found');
            }
            var token = fs.readFileSync(tokenFile, 'utf8').trim();
            if (!/^[a-f0-9]{64}$/i.test(token)) {
                throw new Error('Bridge secret has an invalid format');
            }

            currentToken = token;
            if (tokenStatusText) {
                tokenStatusText.textContent = 'Token local validado';
                tokenStatusText.className = 'setting-val green';
            }
            return currentToken;
        } catch (e) {
            if (tokenStatusText) {
                tokenStatusText.textContent = 'Token no disponible';
                tokenStatusText.className = 'setting-val red';
            }
            log('No se pudo leer el secreto local del puente: ' + e.message, 'error');
            return null;
        }
    }

    // =========================================================================
    // 2. CONEXIÓN WEBSOCKET Y PUENTE SEGURO
    // =========================================================================
    function setConnected(connected) {
        if (connected) {
            if (headerDot) headerDot.className = 'brand-dot';
            if (statusBadge) statusBadge.className = 'badge-status';
            if (statusText) statusText.textContent = 'EN LÍNEA';
        } else {
            if (headerDot) headerDot.className = 'brand-dot offline';
            if (statusBadge) statusBadge.className = 'badge-status disconnected';
            if (statusText) statusText.textContent = 'DESCONECTADO';
        }
    }

    function connectBridge() {
        if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
            return;
        }

        setConnected(false);
        log('Conectando al puente Studio Bridge (127.0.0.1:8765)...', 'info');

        try {
            ws = new WebSocket('ws://127.0.0.1:8765');
        } catch (err) {
            log('Error al abrir socket: ' + err, 'error');
            scheduleReconnect();
            return;
        }

        ws.onopen = function() {
            var token = getSecretToken();
            if (!token) {
                log('No se autenticará el panel sin un secreto válido.', 'error');
                ws.close();
                return;
            }
            log('Socket conectado. Enviando autenticación local...', 'info');
            ws.send(JSON.stringify({
                type: 'auth',
                token: token,
                app: hostApp
            }));
        };

        ws.onmessage = function(event) {
            try {
                var msg = JSON.parse(event.data);

                if (msg.type === 'auth_ok') {
                    setConnected(true);
                    log('✔ Conectado y autenticado con Studio Bridge (' + hostApp + ')', 'success');
                    return;
                }

                if (msg.type === 'auth_error') {
                    setConnected(false);
                    log('❌ Error de autenticación: ' + (msg.message || 'token inválido'), 'error');
                    return;
                }

                // Inyección remota de progreso de tarea desde el agente
                if (msg.type === 'task_progress') {
                    handleRemoteTaskProgress(msg);
                    return;
                }

                // Notificación en panel
                if (msg.type === 'notify') {
                    log('📢 Notificación: ' + (msg.text || ''), 'warn');
                    return;
                }

                // Mensaje de chat enviado por el agente (adobe_panel_notify → agent_chat)
                if (msg.type === 'agent_chat') {
                    log('🤖 ' + (msg.text || ''), 'agent');
                    return;
                }

                // Procesamiento secuencial de comandos (Anti-Colisión)
                if (msg.action && msg.requestId) {
                    queueAgentAction(msg.action, msg.params || {}, function(result) {
                        if (ws && ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({
                                requestId: msg.requestId,
                                payload: result
                            }));
                        }
                    });
                }
            } catch (e) {
                log('Error procesando mensaje entrante: ' + e, 'error');
            }
        };

        ws.onclose = function() {
            setConnected(false);
            log('Puente desconectado. Reintentando...', 'info');
            scheduleReconnect();
        };

        ws.onerror = function() {
            setConnected(false);
            scheduleReconnect();
        };
    }

    var lastBrokerSpawn = 0;

    function trySpawnBroker() {
        var now = Date.now();
        if (now - lastBrokerSpawn < 10000) return;
        lastBrokerSpawn = now;
        try {
            if (typeof require === 'undefined') return;
            var fs = require('fs');
            var path = require('path');
            var os = require('os');
            var spawn = require('child_process').spawn;
            var candidates = [
                path.join(os.homedir(), 'Agents', 'Sistema_Agentes', '03_Mis_Proyectos_Internos', 'Mis_Plugins_y_Apps', 'Adobe_Plugins_Activos', 'studio-bridge', 'mcp-video-server')
            ];
            for (var i = 0; i < candidates.length; i++) {
                var serverDir = candidates[i];
                var vbsPath = path.join(serverDir, 'start-broker-hidden.vbs');
                if (fs.existsSync(vbsPath)) {
                    var child = spawn('wscript.exe', [vbsPath], {
                        cwd: serverDir,
                        detached: true,
                        stdio: 'ignore',
                        windowsHide: true
                    });
                    if (child && typeof child.unref === 'function') child.unref();
                    log('Iniciando Studio Bridge broker en segundo plano...', 'info');
                    return;
                }
            }
        } catch (_) {}
    }

    function scheduleReconnect() {
        trySpawnBroker();
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(function() {
            connectBridge();
        }, 4000);
    }

    // =========================================================================
    // 3. COLA SECUENCIAL DE EJECUCIÓN (ANTI-COLISIÓN EN EL HILO DE ADOBE)
    // =========================================================================
    function queueAgentAction(action, params, callback) {
        var task = function() {
            return new Promise(function(resolveTask) {
                handleAgentAction(action, params, function(result) {
                    try {
                        callback(result);
                    } finally {
                        resolveTask();
                    }
                });
            });
        };
        scriptExecutionQueue = scriptExecutionQueue.then(task, task);
    }

    function handleAgentAction(action, params, callback) {
        log('⚡ Comando recibido: ' + action, 'info');

        var actionsApi = (typeof StudioBridgeActions !== 'undefined') ? StudioBridgeActions : null;
        if (!actionsApi || (!actionsApi.isAllowedAction(action) && !actionsApi.isAllowedMacro(action))) {
            log('⛔ Acción bloqueada por la allowlist: ' + String(action).slice(0, 120), 'error');
            callback({ success: false, error: 'Acción no permitida por la allowlist del panel.' });
            return;
        }

        if (action === 'evalScript' && params.script) {
            cs.evalScript(params.script, function(res) {
                log('✔ ExtendScript completado', 'success');
                callback({ success: true, result: res });
            });
        } else if (action === 'evalCustom' && params.code) {
            // Ejecuta código en el host con resultado JSON garantizado (éxito/error)
            cs.evalScript('AntigravityBridge.evalCustom(' + JSON.stringify(params.code) + ')', function(res) {
                var data = {};
                try { data = JSON.parse(res); } catch(_) { data = { raw: res }; }
                callback(data);
            });
        } else if (action === 'toolkit' && params.verb) {
            // Toolkit genérico: catálogo, modelo, timeline, transiciones, subclips...
            if (params.verb === 'renderFrame') {
                // QE escribe el PNG en diferido: aquí se espera y se devuelve Base64.
                cs.evalScript('AntigravityToolkit.dispatch(' + JSON.stringify(params) + ')', function(res) {
                    var write = {};
                    try { write = JSON.parse(res); } catch(_) { write = { raw: res }; }
                    if (!write.ok || !write.path) { callback(write); return; }
                    readFrameBase64(write, 0, callback);
                });
            } else {
                cs.evalScript('AntigravityToolkit.dispatch(' + JSON.stringify(params) + ')', function(res) {
                    var data = {};
                    try { data = JSON.parse(res); } catch(_) { data = { raw: res }; }
                    callback(data);
                });
            }
        } else if (action === 'toolkit_ae' && params.verb) {
            // Toolkit de After Effects: comps, capas, efectos, keyframes...
            if (params.verb === 'renderFrame') {
                // saveFrameToPng escribe en diferido: el host devuelve la ruta,
                // y aquí esperamos el PNG para leerlo y convertirlo a Base64.
                cs.evalScript('AntigravityToolkitAE.dispatch(' + JSON.stringify(params) + ')', function(res) {
                    var write = {};
                    try { write = JSON.parse(res); } catch(_) { write = { raw: res }; }
                    if (!write.ok || !write.path) { callback(write); return; }
                    readFrameBase64(write, 0, callback);
                });
            } else {
                cs.evalScript('AntigravityToolkitAE.dispatch(' + JSON.stringify(params) + ')', function(res) {
                    var data = {};
                    try { data = JSON.parse(res); } catch(_) { data = { raw: res }; }
                    callback(data);
                });
            }
        } else if (action === 'getProjectSnapshot' || action === 'getTimelineInfo') {
            cs.evalScript('AntigravityBridge.getProjectSnapshot()', function(res) {
                var data = {};
                try { data = JSON.parse(res); } catch(_) { data = { raw: res }; }
                callback(data);
            });
        } else if (action === 'getSummary') {
            cs.evalScript('AntigravityBridge.getSummary()', function(res) {
                var data = {};
                try { data = JSON.parse(res); } catch(_) { data = { raw: res }; }
                callback(data);
            });
        } else if (actionsApi.isAllowedMacro(action)) {
            // Invocación directa de macro en AntigravityBridge si existe
            var paramJson = (params && typeof params === 'object') ? JSON.stringify(params) : '{}';
            var safeCall = 'AntigravityBridge.' + action + '(' + paramJson + ')';
            cs.evalScript(safeCall, function(res) {
                var data = {};
                try { data = JSON.parse(res); } catch(_) { data = { raw: res }; }
                callback(data);
            });
        } else {
            callback({ success: false, error: 'Acción no permitida por la allowlist del panel.' });
        }
    }

    // Limpia el PNG temporal en diferido (AE puede tenerlo bloqueado al leerlo).
    function scheduleFrameCleanup(p) {
        var fs = require('fs');
        setTimeout(function() {
            try {
                if (fs.rmSync) fs.rmSync(p, { force: true, maxRetries: 10, retryDelay: 200 });
                else if (fs.existsSync(p)) fs.unlinkSync(p);
            } catch (_) {}
        }, 800);
    }

    // Espera (diferido) al PNG de renderFrame y lo devuelve en Base64.
    // Hasta 30 intentos x 100 ms (3.0 s) para comps 4K/motion blur denso.
    function readFrameBase64(write, attempt, callback) {
        var fs = require('fs');
        setTimeout(function() {
            try {
                if (!fs.existsSync(write.path)) {
                    if (attempt < 30) { readFrameBase64(write, attempt + 1, callback); return; }
                    if (write.temp) scheduleFrameCleanup(write.path);
                    callback({ ok: false, error: 'PNG no disponible aún (timeout)', comp: write.comp, sequence: write.sequence, timecode: write.timecode, time: write.time, path: write.path });
                    return;
                }
                var b64;
                try {
                    b64 = fs.readFileSync(write.path).toString('base64');
                } catch (readErr) {
                    if ((readErr.code === 'EBUSY' || readErr.code === 'EPERM' || readErr.code === 'EACCES') && attempt < 30) {
                        readFrameBase64(write, attempt + 1, callback);
                        return;
                    }
                    if (write.temp) scheduleFrameCleanup(write.path);
                    callback({ ok: false, error: String(readErr), comp: write.comp, sequence: write.sequence, timecode: write.timecode, time: write.time, path: write.path });
                    return;
                }
                if (write.temp) scheduleFrameCleanup(write.path);
                callback({ ok: true, comp: write.comp, sequence: write.sequence, timecode: write.timecode, time: write.time, path: write.path, base64: b64 });
            } catch (e) {
                if (write.temp) scheduleFrameCleanup(write.path);
                callback({ ok: false, error: String(e), comp: write.comp, sequence: write.sequence, timecode: write.timecode, time: write.time, path: write.path });
            }
        }, 100);
    }

    // =========================================================================
    // 4. TASK STEPPER ENGINE (Seguimiento de Tareas en Vivo)
    // =========================================================================
    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function renderSteps(steps, activeIndex) {
        if (!stepperStepsList) return;
        if (!steps || steps.length === 0) {
            stepperStepsList.innerHTML = '';
            return;
        }
        stepperStepsList.innerHTML = steps.map(function(s, i) {
            var cls = 'stepper-step';
            if (i < activeIndex) cls += ' completed';
            else if (i === activeIndex) cls += ' in-progress';
            return '<div class="' + cls + '">' +
                '<span class="step-icon-wrap"><span class="step-bullet"></span></span>' +
                '<span>' + escapeHtml(s) + '</span>' +
                '</div>';
        }).join('');
    }

    function handleRemoteTaskProgress(msg) {
        if (!taskStepperWidget) return;

        var action = msg.action || (msg.completed ? 'complete' : 'step');

        if (action === 'complete') {
            stepperTaskSubtitle.textContent = msg.subtitle || '✔ Tarea completada con éxito';
            stepperPercent.textContent = '100%';
            stepperProgressBar.style.width = '100%';
            if (msg.steps && msg.steps.length) renderSteps(msg.steps, msg.steps.length);
            setTimeout(function() {
                taskStepperWidget.classList.add('is-hidden');
            }, 3500);
            return;
        }

        taskStepperWidget.classList.remove('is-hidden');
        if (action === 'start') {
            if (msg.title) stepperTaskName.textContent = msg.title;
        }
        if (msg.subtitle) stepperTaskSubtitle.textContent = msg.subtitle;

        var stepIndex = (typeof msg.stepIndex === 'number' && msg.stepIndex >= 0) ? msg.stepIndex : 0;
        if (msg.steps && msg.steps.length) renderSteps(msg.steps, stepIndex);

        if (typeof msg.percent === 'number') {
            stepperPercent.textContent = Math.round(msg.percent) + '%';
            stepperProgressBar.style.width = Math.min(100, Math.max(0, msg.percent)) + '%';
        }
    }

    // =========================================================================
    // 5. EVENTOS DE INTERFAZ
    // =========================================================================
    if (btnReconnect) {
        btnReconnect.addEventListener('click', function() {
            log('Reconexión manual iniciada...', 'info');
            if (ws) {
                try { ws.close(); } catch (_) {}
            }
            connectBridge();
        });
    }

    if (btnReload) {
        btnReload.addEventListener('click', function() {
            window.location.reload();
        });
    }

    if (btnClearLog) {
        btnClearLog.addEventListener('click', function() {
            if (logConsole) {
                logConsole.innerHTML = '<div class="log-entry info">[Bridge] Registro limpiado.</div>';
            }
        });
    }

    // =========================================================================
    // 6. INICIALIZACIÓN
    // =========================================================================
    // Autocargar el host script: si el panel se recarga (↻), el motor ExtendScript
    // queda vacío y evalScript falla. Esto lo re-evalúa al abrir/recargar el panel.
    try {
        var extPath = cs.getSystemPath(SystemPath.EXTENSION);
        if (extPath) {
            var hostPath = String(extPath).replace(/\\/g, '/') + '/host/';
            cs.evalScript('$.evalFile("' + hostPath + 'bridge.jsx")');
            cs.evalScript('$.evalFile("' + hostPath + 'toolkit.jsx")');
            cs.evalScript('$.evalFile("' + hostPath + 'toolkit_ae.jsx")');
        }
    } catch (e) {
        log('No se pudo autocargar el host: ' + e, 'error');
    }

    getSecretToken();
    connectBridge();
})();
