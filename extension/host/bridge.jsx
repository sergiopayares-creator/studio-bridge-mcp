/**
 * Studio Bridge — Host Script (ExtendScript)
 * Pure ES3 JSON + Robust Host Detection (PPRO/AEFT) + Safe QE DOM Initialization
 */

// =============================================================================
// 1. ES3 PURE JSON POLYFILL (Compatibilidad absoluta ExtendScript en PPRO y AEFT)
// =============================================================================
if (typeof JSON === 'undefined' || !JSON.stringify) {
    JSON = (function() {
        var rx_escapable = /[\\\"\x00-\x1f\x7f-\x9f\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g;
        var meta = {
            '\b': '\\b',
            '\t': '\\t',
            '\n': '\\n',
            '\f': '\\f',
            '\r': '\\r',
            '"': '\\"',
            '\\': '\\\\'
        };

        function quote(string) {
            rx_escapable.lastIndex = 0;
            return rx_escapable.test(string) ? '"' + string.replace(rx_escapable, function(a) {
                var c = meta[a];
                return typeof c === 'string' ? c : '\\u' + ('0000' + a.charCodeAt(0).toString(16)).slice(-4);
            }) + '"' : '"' + string + '"';
        }

        function str(key, holder) {
            var value = holder[key];
            if (value && typeof value === 'object' && typeof value.toJSON === 'function') {
                value = value.toJSON(key);
            }

            switch (typeof value) {
                case 'string':
                    return quote(value);
                case 'number':
                    return isFinite(value) ? String(value) : 'null';
                case 'boolean':
                case 'null':
                    return String(value);
                case 'object':
                    if (!value) return 'null';
                    var partial = [];
                    if (Object.prototype.toString.apply(value) === '[object Array]') {
                        var length = value.length;
                        for (var i = 0; i < length; i += 1) {
                            partial[i] = str(i, value) || 'null';
                        }
                        return '[' + partial.join(',') + ']';
                    }
                    for (var k in value) {
                        if (Object.prototype.hasOwnProperty.call(value, k)) {
                            var v = str(k, value);
                            if (v) {
                                partial.push(quote(k) + ':' + v);
                            }
                        }
                    }
                    return '{' + partial.join(',') + '}';
            }
            return 'null';
        }

        return {
            stringify: function(value) {
                return str('', { '': value });
            },
            parse: function(text) {
                return eval('(' + text + ')');
            }
        };
    })();
}

// =============================================================================
// 2. ANTIGRAVITY STUDIO BRIDGE HOST ENGINE
// =============================================================================
var AntigravityBridge = (function() {

    function getAppType() {
        try {
            if (typeof BridgeTalk !== 'undefined' && BridgeTalk.appName) {
                var bName = BridgeTalk.appName.toLowerCase();
                if (bName.indexOf('premiere') !== -1) return 'PPRO';
                if (bName.indexOf('aftereffects') !== -1) return 'AEFT';
            }
        } catch (_) {}
        try {
            if (typeof app !== 'undefined' && app.name) {
                var aName = app.name.toLowerCase();
                if (aName.indexOf('premiere') !== -1) return 'PPRO';
                if (aName.indexOf('after effects') !== -1) return 'AEFT';
            }
        } catch (_) {}
        if (typeof app !== 'undefined' && app.project) {
            if (typeof app.project.activeSequence !== 'undefined' || typeof app.project.openSequence !== 'undefined') return 'PPRO';
            if (typeof app.project.activeItem !== 'undefined' || typeof app.project.renderQueue !== 'undefined') return 'AEFT';
        }
        return 'UNKNOWN';
    }

    function isPremiere() {
        return getAppType() === 'PPRO';
    }

    function isAfterEffects() {
        return getAppType() === 'AEFT';
    }

    function ensureQE() {
        if (!isPremiere()) return false;
        try {
            if (typeof qe === 'undefined') {
                if (typeof app.enableQE === 'function') {
                    app.enableQE();
                }
            }
            return (typeof qe !== 'undefined');
        } catch (_) {
            return false;
        }
    }

    return {
        // Expose pure ES3 JSON for external scripts
        JSON: JSON,

        // Safe wrapper for QE DOM in Premiere Pro
        enableQE: ensureQE,

        // =====================================================================
        // INSPECCIÓN COMPLETA DE PROYECTO Y TIMELINE
        // =====================================================================
        getSummary: function() {
            var res = {
                success: true,
                app: isPremiere() ? 'Premiere Pro' : (isAfterEffects() ? 'After Effects' : 'Unknown'),
                appType: getAppType(),
                hasProject: false,
                projectName: null,
                hasActiveItem: false,
                activeSequenceOrComp: null,
                playheadSeconds: null,
                durationSeconds: null,
                fps: null,
                qeAvailable: false
            };

            try {
                if (isPremiere()) {
                    res.qeAvailable = ensureQE();
                    if (app.project) {
                        res.hasProject = true;
                        res.projectName = app.project.name || 'Untitled';
                        var seq = app.project.activeSequence;
                        if (seq) {
                            res.hasActiveItem = true;
                            res.activeSequenceOrComp = seq.name;
                            res.playheadSeconds = parseFloat(seq.getPlayerPosition().seconds);
                            res.durationSeconds = parseFloat(seq.end) / 254016000000;
                            res.fps = 1 / parseFloat(seq.timeDisplay);
                            res.videoTracksCount = seq.videoTracks ? seq.videoTracks.numItems : 0;
                            res.audioTracksCount = seq.audioTracks ? seq.audioTracks.numItems : 0;
                            if (seq.videoTracks && seq.videoTracks.numItems > 0 && seq.videoTracks[0].clips) {
                                res.v1ClipsCount = seq.videoTracks[0].clips.numItems;
                            }
                            if (seq.markers) {
                                res.markersCount = seq.markers.numMarkers;
                            }
                        }
                    }
                } else if (isAfterEffects()) {
                    if (app.project) {
                        res.hasProject = true;
                        res.projectName = app.project.file ? app.project.file.name : 'Untitled';
                        var comp = app.project.activeItem;
                        if (comp && comp instanceof CompItem) {
                            res.hasActiveItem = true;
                            res.activeSequenceOrComp = comp.name;
                            res.width = comp.width;
                            res.height = comp.height;
                            res.fps = comp.frameRate;
                            res.playheadSeconds = comp.time;
                            res.durationSeconds = comp.duration;
                            res.totalLayers = comp.numLayers;
                            res.selectedLayersCount = comp.selectedLayers ? comp.selectedLayers.length : 0;
                        }
                    }
                }
            } catch (err) {
                res.error = err.toString();
            }

            return JSON.stringify(res);
        },

        // Read-only structured snapshot for agent context (bounded to keep responses compact).
        getProjectSnapshot: function() {
            var res = {
                success: true,
                app: isPremiere() ? 'Premiere Pro' : (isAfterEffects() ? 'After Effects' : 'Unknown'),
                projectName: null,
                activeItem: null,
                tracks: [],
                truncated: false
            };

            function safeGet(obj, key) {
                try { return obj ? obj[key] : null; } catch (_) { return null; }
            }
            function rounded(value) {
                var n = Number(value);
                return isFinite(n) ? Math.round(n * 1000) / 1000 : null;
            }
            function seconds(value) {
                if (value === null || value === undefined) return null;
                if (typeof value === 'number' || typeof value === 'string') return rounded(value);
                var sec = safeGet(value, 'seconds');
                if (sec !== null && sec !== undefined) return rounded(sec);
                return null;
            }
            function count(collection, limit) {
                var n = safeGet(collection, 'numItems');
                if (n === null || n === undefined) n = safeGet(collection, 'numProperties');
                if (n === null || n === undefined) n = safeGet(collection, 'length');
                n = parseInt(n, 10);
                if (!isFinite(n) || n < 0) return 0;
                if (n > limit) { res.truncated = true; return limit; }
                return n;
            }
            function safeValue(value, depth) {
                if (value === null || value === undefined) return null;
                if (typeof value === 'number') return rounded(value);
                if (typeof value === 'string' || typeof value === 'boolean') return value;
                if (value instanceof Array) {
                    var arr = [];
                    var arrLen = Math.min(value.length, 8);
                    for (var ai = 0; ai < arrLen; ai++) arr.push(safeValue(value[ai], (depth || 0) + 1));
                    return arr;
                }
                if ((depth || 0) < 1 && safeGet(value, 'seconds') !== null) return seconds(value);
                return null;
            }
            function readValue(prop) {
                try {
                    if (prop && typeof prop.getValue === 'function') return safeValue(prop.getValue(), 0);
                    if (prop && prop.value !== undefined) return safeValue(prop.value, 0);
                } catch (_) {}
                try {
                    if (prop && typeof prop.getValueAsString === 'function') return prop.getValueAsString();
                } catch (_) {}
                return null;
            }
            function readKeyCount(prop) {
                try {
                    if (prop && typeof prop.getKeys === 'function') {
                        var keys = prop.getKeys();
                        return keys && keys.length !== undefined ? Math.min(parseInt(keys.length, 10) || 0, 500) : 0;
                    }
                } catch (_) {}
                try { return Math.min(parseInt(prop.numKeys, 10) || 0, 500); } catch (_) { return 0; }
            }
            function readPremiereEffects(components) {
                var effects = [];
                var n = count(components, 24);
                for (var i = 0; i < n; i++) {
                    var component = safeGet(components, i);
                    if (!component) continue;
                    var effect = {
                        name: safeGet(component, 'displayName') || safeGet(component, 'name') || ('Component ' + (i + 1)),
                        matchName: safeGet(component, 'matchName') || null,
                        parameters: []
                    };
                    var props = safeGet(component, 'properties');
                    var propCount = count(props, 32);
                    for (var p = 0; p < propCount; p++) {
                        var prop = safeGet(props, p);
                        if (!prop) continue;
                        var animated = false;
                        try { if (typeof prop.isTimeVarying === 'function') animated = !!prop.isTimeVarying(); } catch (_) {}
                        effect.parameters.push({
                            name: safeGet(prop, 'displayName') || safeGet(prop, 'name') || ('Parameter ' + (p + 1)),
                            matchName: safeGet(prop, 'matchName') || null,
                            value: readValue(prop),
                            animated: animated,
                            keyframeCount: readKeyCount(prop)
                        });
                    }
                    effects.push(effect);
                }
                return effects;
            }
            function readAeProperty(prop, depth) {
                var item = {
                    name: safeGet(prop, 'name') || 'Property',
                    matchName: safeGet(prop, 'matchName') || null
                };
                var children = parseInt(safeGet(prop, 'numProperties'), 10) || 0;
                if (children > 0 && depth < 2) {
                    item.children = [];
                    var childCount = Math.min(children, 24);
                    if (children > childCount) res.truncated = true;
                    for (var c = 1; c <= childCount; c++) {
                        try { item.children.push(readAeProperty(prop.property(c), depth + 1)); } catch (_) {}
                    }
                } else {
                    item.value = readValue(prop);
                    item.keyframeCount = readKeyCount(prop);
                    item.animated = item.keyframeCount > 0;
                }
                return item;
            }
            function readAeGroup(group) {
                var list = [];
                var n = count(group, 24);
                for (var i = 1; i <= n; i++) {
                    try { list.push(readAeProperty(group.property(i), 0)); } catch (_) {}
                }
                return list;
            }

            try {
                if (!app || !app.project) return JSON.stringify({ success: false, error: 'No open Adobe project.' });
                res.projectName = isPremiere() ? (app.project.name || 'Untitled') : (app.project.file ? app.project.file.name : 'Untitled');

                if (isPremiere()) {
                    var seq = app.project.activeSequence;
                    if (!seq) return JSON.stringify({ success: false, app: res.app, projectName: res.projectName, error: 'No active sequence in Premiere Pro.' });
                    var playhead = null;
                    try { playhead = seconds(seq.getPlayerPosition()); } catch (_) {}
                    // seq.end llega en ticks (254016000000 por segundo), no en segundos.
                    var duration = null;
                    try {
                        var endTicks = parseFloat(safeGet(seq, 'end'));
                        if (isFinite(endTicks)) duration = rounded(endTicks / 254016000000);
                    } catch (_) {}
                    var fps = null;
                    try {
                        var settings = seq.getSettings();
                        var frameRate = parseFloat(safeGet(settings, 'videoFrameRate'));
                        if (isFinite(frameRate) && frameRate > 0) {
                            fps = frameRate > 1000 ? rounded(254016000000 / frameRate) : rounded(frameRate);
                        }
                    } catch (_) {}
                    if (!fps) {
                        var ticksPerFrame = parseFloat(safeGet(seq, 'timebase'));
                        if (ticksPerFrame > 0) fps = rounded(254016000000 / ticksPerFrame);
                    }
                    res.activeItem = { kind: 'sequence', name: seq.name || 'Untitled sequence', playheadSeconds: playhead, durationSeconds: duration, fps: fps };

                    var trackKinds = [
                        { key: 'videoTracks', kind: 'video' },
                        { key: 'audioTracks', kind: 'audio' }
                    ];
                    var totalClips = 0;
                    for (var k = 0; k < trackKinds.length; k++) {
                        var tracks = safeGet(seq, trackKinds[k].key);
                        var trackCount = count(tracks, 32);
                        for (var ti = 0; ti < trackCount; ti++) {
                            var track = safeGet(tracks, ti);
                            var trackData = { kind: trackKinds[k].kind, index: ti + 1, name: safeGet(track, 'name') || (trackKinds[k].kind.toUpperCase() + (ti + 1)), clips: [] };
                            var clips = safeGet(track, 'clips');
                            var clipCount = count(clips, Math.max(0, 200 - totalClips));
                            totalClips += clipCount;
                            for (var ci = 0; ci < clipCount; ci++) {
                                var clip = safeGet(clips, ci);
                                if (!clip) continue;
                                var start = seconds(safeGet(clip, 'start'));
                                var end = seconds(safeGet(clip, 'end'));
                                var source = safeGet(clip, 'projectItem');
                                trackData.clips.push({
                                    name: safeGet(clip, 'name') || (source ? safeGet(source, 'name') : null) || ('Clip ' + (ci + 1)),
                                    sourceName: source ? (safeGet(source, 'name') || null) : null,
                                    startSeconds: start,
                                    endSeconds: end,
                                    durationSeconds: start !== null && end !== null ? rounded(end - start) : null,
                                    sourceInSeconds: seconds(safeGet(clip, 'inPoint')),
                                    sourceOutSeconds: seconds(safeGet(clip, 'outPoint')),
                                    effects: readPremiereEffects(safeGet(clip, 'components'))
                                });
                            }
                            res.tracks.push(trackData);
                        }
                    }
                    if (totalClips >= 200) res.truncated = true;
                } else if (isAfterEffects()) {
                    var comp = app.project.activeItem;
                    if (!comp || !(comp instanceof CompItem)) return JSON.stringify({ success: false, app: res.app, projectName: res.projectName, error: 'No active composition in After Effects.' });
                    res.activeItem = { kind: 'composition', name: comp.name, width: comp.width, height: comp.height, fps: comp.frameRate, playheadSeconds: rounded(comp.time), durationSeconds: rounded(comp.duration), layerCount: comp.numLayers };
                    var layerCount = Math.min(comp.numLayers, 100);
                    if (comp.numLayers > layerCount) res.truncated = true;
                    for (var li = 1; li <= layerCount; li++) {
                        var layer = comp.layer(li);
                        var sourceItem = safeGet(layer, 'source');
                        res.tracks.push({
                            kind: 'layer',
                            index: li,
                            name: safeGet(layer, 'name') || ('Layer ' + li),
                            sourceName: sourceItem ? (safeGet(sourceItem, 'name') || null) : null,
                            enabled: safeGet(layer, 'enabled'),
                            threeD: safeGet(layer, 'threeDLayer'),
                            startSeconds: rounded(safeGet(layer, 'startTime')),
                            inPointSeconds: rounded(safeGet(layer, 'inPoint')),
                            outPointSeconds: rounded(safeGet(layer, 'outPoint')),
                            transform: readAeGroup(safeGet(layer, 'ADBE Transform Group') || layer.property('ADBE Transform Group')),
                            effects: readAeGroup(layer.property('ADBE Effect Parade'))
                        });
                    }
                } else {
                    return JSON.stringify({ success: false, app: res.app, error: 'Unsupported Adobe host application.' });
                }
            } catch (err) {
                return JSON.stringify({ success: false, app: res.app, error: err.toString() });
            }

            return JSON.stringify(res);
        },

        getTimelineInfo: function() {
            return this.getProjectSnapshot();
        },

        // =====================================================================
        // EJECUTOR SEGURO DE EXTENDSCRIPT (RETORNA JSON GARANTIZADO)
        // =====================================================================
        evalCustom: function(code) {
            var inAE = isAfterEffects();
            // Keep strings and plain objects/arrays intact: the previous version
            // collapsed every object to "[object Object]" and lost the value.
            function safeResult(v) {
                if (v === undefined || v === null) return null;
                if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
                try {
                    var json = JSON.stringify(v);
                    if (json !== undefined && json !== null) return JSON.parse(json);
                } catch (_) {}
                try { return String(v); } catch (_) { return null; }
            }
            function isSyntaxError(e) {
                try {
                    return (e && (e.name === 'SyntaxError' || String(e).indexOf('SyntaxError') !== -1)) ? true : false;
                } catch (_) {
                    return false;
                }
            }
            try {
                if (inAE && app.beginUndoGroup) app.beginUndoGroup("Studio Bridge Action");
                // `eval` returns the completion value of the last expression and
                // the value returned by an IIFE, which `new Function(code)` loses.
                // Use an indirect eval so user `var` declarations cannot shadow
                // this function's locals. Code with a top-level `return` is not a
                // valid eval program: fall back to new Function(code).
                var val;
                try {
                    var globalEval = eval;
                    val = globalEval(code);
                } catch (evalErr) {
                    if (!isSyntaxError(evalErr)) throw evalErr;
                    var fn = new Function(code);
                    val = fn();
                }
                if (inAE && app.endUndoGroup) app.endUndoGroup();

                return JSON.stringify({
                    success: true,
                    result: safeResult(val)
                });
            } catch (e) {
                if (inAE && app.endUndoGroup) { try { app.endUndoGroup(); } catch(_) {} }
                var line = (e && e.line !== undefined && e.line !== null) ? e.line : null;
                return JSON.stringify({
                    success: false,
                    error: e.toString() + (line !== null ? (" (line " + line + ")") : ""),
                    line: line
                });
            }
        },

        // =====================================================================
        // MACROS ATÓMICAS (CERO RENDER, CERO FRAGMENTACIÓN)
        // =====================================================================
        cutAtPlayhead: function() {
            try {
                if (isPremiere()) {
                    var seq = app.project.activeSequence;
                    if (!seq) return JSON.stringify({ success: false, error: "No active sequence in Premiere Pro" });
                    var pos = seq.getPlayerPosition();
                    var cutDone = false;

                    if (ensureQE() && typeof qe !== 'undefined' && qe.project) {
                        try {
                            var qeSeq = qe.project.getActiveSequence();
                            if (qeSeq && typeof qeSeq.razor === 'function') {
                                qeSeq.razor(pos.ticks);
                                cutDone = true;
                            }
                        } catch (_) {}
                    }

                    if (!cutDone && typeof seq.razor === 'function') {
                        seq.razor(pos.ticks);
                        cutDone = true;
                    }

                    return JSON.stringify({
                        success: true,
                        message: "Cut applied at playhead (" + parseFloat(pos.seconds).toFixed(2) + "s)"
                    });
                }
                return JSON.stringify({ success: false, error: "Cut at playhead is only supported in Premiere Pro sequence" });
            } catch (e) {
                return JSON.stringify({ success: false, error: e.toString() });
            }
        },

        addMarker: function(comment, color) {
            try {
                var commentSafe = comment || 'Studio Bridge Marker';
                if (isPremiere()) {
                    var seq = app.project.activeSequence;
                    if (!seq) return JSON.stringify({ success: false, error: "No active sequence in Premiere Pro" });
                    var pos = seq.getPlayerPosition();
                    var newMarker = seq.markers.createMarker(pos.seconds);
                    newMarker.name = commentSafe;
                    newMarker.comments = commentSafe;
                    return JSON.stringify({ success: true, message: "Marker added at " + pos.seconds.toFixed(2) + "s" });
                } else if (isAfterEffects()) {
                    var comp = app.project.activeItem;
                    if (comp && comp instanceof CompItem) {
                        var myMarker = new MarkerValue(commentSafe);
                        comp.markerProperty.setValueAtTime(comp.time, myMarker);
                        return JSON.stringify({ success: true, message: "Marker added at " + comp.time.toFixed(2) + "s" });
                    }
                }
                return JSON.stringify({ success: false, error: "No active composition or sequence found" });
            } catch (e) {
                return JSON.stringify({ success: false, error: e.toString() });
            }
        },

        applySmartZoom: function(punchInScale) {
            try {
                var zoomVal = punchInScale ? parseFloat(punchInScale) : 115.0;
                if (isPremiere()) {
                    var seq = app.project.activeSequence;
                    if (!seq) return JSON.stringify({ success: false, error: "No active sequence in Premiere Pro" });
                    var v0 = seq.videoTracks[0];
                    if (!v0 || v0.clips.numItems === 0) {
                        return JSON.stringify({ success: false, error: "No video clips found in track V1" });
                    }
                    var count = v0.clips.numItems;
                    var applied = 0;

                    for (var i = 0; i < count; i++) {
                        var clip = v0.clips[i];
                        var scaleTarget = (i % 2 === 1) ? zoomVal : 100.0;
                        for (var c = 0; c < clip.components.numItems; c++) {
                            var compObj = clip.components[c];
                            if (compObj.displayName === "Movimiento" || compObj.displayName === "Motion") {
                                for (var p = 0; p < compObj.properties.numItems; p++) {
                                    var prop = compObj.properties[p];
                                    if (prop.displayName === "Escala" || prop.displayName === "Scale") {
                                        prop.setValue(scaleTarget, true);
                                        applied++;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    return JSON.stringify({
                        success: true,
                        message: "Smart Zoom applied to " + applied + " alternating clips (100% / " + zoomVal + "%) in V1"
                    });
                } else if (isAfterEffects()) {
                    var comp = app.project.activeItem;
                    if (!comp || !(comp instanceof CompItem)) {
                        return JSON.stringify({ success: false, error: "No active composition selected in After Effects" });
                    }
                    app.beginUndoGroup("Studio Bridge AE Smart Zoom");
                    if (comp.layers.length === 0) {
                        app.endUndoGroup();
                        return JSON.stringify({ success: false, error: "Composition has no layers" });
                    }
                    var targetLayer = comp.selectedLayers.length > 0 ? comp.selectedLayers[0] : comp.layer(1);
                    var scaleProp = targetLayer.property("Scale");
                    var dur = comp.duration;
                    if (scaleProp && dur > 1) {
                        scaleProp.setValueAtTime(0, [100, 100]);
                        scaleProp.setValueAtTime(dur * 0.3, [zoomVal, zoomVal]);
                        scaleProp.setValueAtTime(dur * 0.7, [100, 100]);
                        scaleProp.setValueAtTime(dur, [zoomVal, zoomVal]);
                        app.endUndoGroup();
                        return JSON.stringify({
                            success: true,
                            message: "Smart Zoom applied to layer '" + targetLayer.name + "'"
                        });
                    }
                    app.endUndoGroup();
                    return JSON.stringify({ success: false, error: "Unable to animate scale property on target layer" });
                }
                return JSON.stringify({ success: false, error: "Unsupported application" });
            } catch (e) {
                return JSON.stringify({ success: false, error: e.toString() });
            }
        },

        create3DCameraWithZoom: function(punchInScale) {
            try {
                if (!isAfterEffects()) {
                    return JSON.stringify({ success: false, error: "3D Camera creation is only supported in After Effects" });
                }
                var comp = app.project.activeItem;
                if (!comp || !(comp instanceof CompItem)) {
                    return JSON.stringify({ success: false, error: "No active composition open in After Effects" });
                }

                app.beginUndoGroup("Studio Bridge 3D Camera & Zoom");
                var layersCount = comp.layers.length;
                var layersConverted = 0;
                for (var i = 1; i <= layersCount; i++) {
                    var lyr = comp.layers[i];
                    if (!lyr.threeDLayer && !(lyr instanceof CameraLayer) && !(lyr instanceof LightLayer)) {
                        try {
                            lyr.threeDLayer = true;
                            layersConverted++;
                        } catch(_) {}
                    }
                }

                var centerPoint = [comp.width / 2, comp.height / 2];
                var camName = "Cámara 3D Studio Bridge";
                var cam = comp.layers.addCamera(camName, centerPoint);
                var dur = comp.duration;
                var zoomProp = cam.property("Camera Options").property("Zoom");
                var mult = punchInScale ? parseFloat(punchInScale) : 1.15;
                if (mult > 10) mult = mult / 100;

                if (zoomProp && dur > 1) {
                    var baseZoom = zoomProp.value;
                    zoomProp.setValueAtTime(0, baseZoom);
                    zoomProp.setValueAtTime(dur * 0.30, baseZoom * mult);
                    zoomProp.setValueAtTime(dur * 0.65, baseZoom * 0.98);
                    zoomProp.setValueAtTime(dur, baseZoom * 1.08);

                    for (var k = 1; k <= zoomProp.numKeys; k++) {
                        try {
                            var easeIn = new KeyframeEase(0, 35);
                            var easeOut = new KeyframeEase(0, 35);
                            zoomProp.setTemporalEaseAtKey(k, [easeIn], [easeOut]);
                        } catch(_) {}
                    }
                }

                app.endUndoGroup();
                return JSON.stringify({
                    success: true,
                    message: "3D Camera created in '" + comp.name + "' with Bézier zoom keyframes. Converted " + layersConverted + " layer(s) to 3D."
                });
            } catch (err) {
                try { if (app.endUndoGroup) app.endUndoGroup(); } catch(_) {}
                return JSON.stringify({ success: false, error: err.toString() });
            }
        },

        applyFlashTransitions: function(numFrames) {
            try {
                var frames = numFrames ? parseInt(numFrames, 10) : 6;
                if (isAfterEffects()) {
                    var comp = app.project.activeItem;
                    if (!comp || !(comp instanceof CompItem)) {
                        return JSON.stringify({ success: false, error: "No active composition in After Effects" });
                    }
                    app.beginUndoGroup("Studio Bridge Flash Transition");
                    var flashDur = frames / comp.frameRate;
                    var curTime = comp.time;

                    var solid = comp.layers.addSolid([1, 1, 1], "Flash Blanco", comp.width, comp.height, 1, flashDur);
                    solid.startTime = curTime;
                    solid.inPoint = curTime;
                    solid.outPoint = curTime + flashDur;
                    solid.blendingMode = BlendingMode.ADD;

                    var op = solid.property("Opacity");
                    op.setValueAtTime(curTime, 100);
                    op.setValueAtTime(curTime + flashDur, 0);

                    app.endUndoGroup();
                    return JSON.stringify({
                        success: true,
                        message: "White flash transition (" + frames + " frames, ADD mode) inserted at playhead"
                    });
                } else if (isPremiere()) {
                    var seq = app.project.activeSequence;
                    if (!seq) return JSON.stringify({ success: false, error: "No active sequence in Premiere Pro" });
                    var pos = seq.getPlayerPosition();
                    var markers = seq.markers;
                    var playheadMarker = markers.createMarker(pos.seconds);
                    playheadMarker.name = "⚡ FLASH (Dip to White)";
                    playheadMarker.comments = "Destello blanco (" + frames + " frames) en corte de plano.";

                    var v0 = seq.videoTracks[0];
                    var cutCount = 0;
                    if (v0) {
                        for (var i = 0; i < v0.clips.numItems; i++) {
                            var clip = v0.clips[i];
                            var cutSec = clip.start.seconds;
                            if (cutSec > 0.05) {
                                var m = markers.createMarker(cutSec);
                                m.name = "⚡ Flash Cut #" + (i + 1);
                                m.comments = "Punto de corte: Transición Flash (" + frames + "f)";
                                cutCount++;
                            }
                        }
                    }

                    var appliedQE = 0;
                    if (ensureQE() && typeof qe !== 'undefined' && qe.project && qe.project.getActiveSequence()) {
                        try {
                            var qeSeq = qe.project.getActiveSequence();
                            var qeTrack = qeSeq.getVideoTrackAt(0);
                            if (qeTrack) {
                                for (var q = 0; q < qeTrack.numItems; q++) {
                                    var qItem = qeTrack.getItemAt(q);
                                    if (qItem && typeof qItem.addTransition === 'function') {
                                        try { qItem.addTransition(); appliedQE++; } catch(_) {}
                                    }
                                }
                            }
                        } catch(_) {}
                    }

                    return JSON.stringify({
                        success: true,
                        message: "Flash markers placed at playhead and " + cutCount + " cut points in V1" + (appliedQE > 0 ? (" with " + appliedQE + " QE transitions applied") : "")
                    });
                }
                return JSON.stringify({ success: false, error: "Unsupported application" });
            } catch (err) {
                return JSON.stringify({ success: false, error: err.toString() });
            }
        }
    };
})();

// Cargar los toolkits (archivos aparte). Si fallan, el bridge sigue operativo.
try {
    if (typeof $.fileName === 'string' && $.fileName) {
        var _tkBase = $.fileName.replace(/bridge\.jsx$/i, '');
        try { $.evalFile(_tkBase + 'toolkit.jsx'); } catch (_tk1) {}
        try { $.evalFile(_tkBase + 'toolkit_ae.jsx'); } catch (_tk2) {}
    }
} catch (_tkErr) {}
