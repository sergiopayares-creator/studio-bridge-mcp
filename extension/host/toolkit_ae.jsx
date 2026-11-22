// =============================================================================
// ANTIGRAVITY TOOLKIT — AFTER EFFECTS (cobertura amplia)
// Verbos: project/comp/layer/shape/text/textStyle/textAnimator/camera/cameraMove/
//         lowerThird/overlay/light/settings/effect/effectParam/effectKey/
//         transform/keyframe/expression/mask/roto/tracker/marker/import/items/
//         folder/render/renderOutput/renderFrame/scripts/script/save
// Verbos Fase 2 (primitivas deterministas): measure/alignAnchor/shapeGroup/set/
//         halo/batch/check/contactSheet/zStack/pose
// ExtendScript-safe: sin regex \u, sin propiedades reservadas, ES3.
// =============================================================================
$.global.AntigravityToolkitAE = (function () {
    function esc(s) {
        s = String(s);
        var out = '';
        for (var i = 0; i < s.length; i++) {
            var code = s.charCodeAt(i);
            if (code > 127) {
                var hex = code.toString(16);
                while (hex.length < 4) hex = '0' + hex;
                out += '\\u' + hex;
            } else {
                out += s.charAt(i);
            }
        }
        return out;
    }
    function j(o) { return esc(JSON.stringify(o)); }

    function getComp(ref) {
        var active = app.project.activeItem;
        if (!ref) return (active && active instanceof CompItem) ? active : null;
        if (typeof ref === 'number') {
            var it = app.project.item(ref);
            return (it && it instanceof CompItem) ? it : null;
        }
        for (var i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (item instanceof CompItem && item.name === ref) return item;
        }
        return null;
    }

    function getItem(name) {
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it.name === name) return it;
        }
        return null;
    }

    function getLayer(comp, ref) {
        if (!comp) return null;
        var idx = -1;
        if (typeof ref === 'number') {
            idx = ref;
        } else if (typeof ref === 'string' && ref !== '') {
            for (var i = 1; i <= comp.numLayers; i++) {
                if (comp.layer(i).name === ref) { idx = i; break; }
            }
        }
        if (idx < 1 || idx > comp.numLayers) return null;
        return comp.layer(idx);
    }

    // --- Helpers ES3 para los verbos Motion Vault -------------------------
    function num(v, def) {
        if (v === undefined || v === null || v === '') return def;
        var n = parseFloat(v);
        return isNaN(n) ? def : n;
    }

    function clampNum(v, lo, hi) {
        if (v < lo) return lo;
        if (v > hi) return hi;
        return v;
    }

    // property() puede lanzar si el matchName no existe en la versión de AE.
    function propSafe(group, name) {
        if (!group) return null;
        try {
            var pr = group.property(name);
            if (pr) return pr;
        } catch (e) {}
        return null;
    }

    function txProp(group, candidates) {
        var i;
        for (i = 0; i < candidates.length; i++) {
            var pr = propSafe(group, candidates[i]);
            if (pr) return pr;
        }
        return null;
    }

    function transformOf(ly) {
        return propSafe(ly, 'ADBE Transform Group');
    }

    function hexToRgb(hex) {
        if (hex === undefined || hex === null || hex === '') return null;
        var raw = String(hex);
        if (raw.charAt(0) === '#') raw = raw.substring(1);
        if (raw.length > 2 && raw.substring(0, 2).toLowerCase() === '0x') raw = raw.substring(2);
        if (raw.length === 3) {
            raw = raw.charAt(0) + raw.charAt(0) + raw.charAt(1) + raw.charAt(1) + raw.charAt(2) + raw.charAt(2);
        }
        if (raw.length !== 6) return null;
        var allowed = '0123456789abcdef';
        var i;
        for (i = 0; i < 6; i++) {
            if (allowed.indexOf(raw.charAt(i).toLowerCase()) < 0) return null;
        }
        var n = parseInt(raw, 16);
        return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    }

    function blendModeFrom(v) {
        if (typeof BlendingMode === 'undefined') return null;
        if (v === undefined || v === null || v === '') return BlendingMode.OVERLAY;
        if (typeof v === 'number') return v;
        var s = String(v).toUpperCase().split(' ').join('_').split('-').join('_');
        if (s === 'SOFTLIGHT') s = 'SOFT_LIGHT';
        else if (s === 'HARDLIGHT') s = 'HARD_LIGHT';
        else if (s === 'COLORBURN') s = 'COLOR_BURN';
        else if (s === 'COLORDODGE') s = 'COLOR_DODGE';
        else if (s === 'LINEARBURN') s = 'LINEAR_BURN';
        else if (s === 'LINEARDODGE') s = 'LINEAR_DODGE';
        var mode = BlendingMode[s];
        return (typeof mode === 'number') ? mode : null;
    }

    // --- Fase 2: flags de capa, sampling, track matte y texto --------------
    function enumKey(v) {
        return String(v).toUpperCase().split(' ').join('_').split('-').join('_');
    }

    function resolveSamplingQuality(v) {
        if (v === undefined || v === null || v === '') return null;
        if (typeof v === 'number') return v;
        var s = enumKey(v);
        if (s === 'BICUBIC_SAMPLING') s = 'BICUBIC';
        if (s === 'BILINEAR_SAMPLING') s = 'BILINEAR';
        if (typeof LayerSamplingQuality !== 'undefined') {
            if (LayerSamplingQuality[s] !== undefined) return LayerSamplingQuality[s];
        }
        if (s === 'BICUBIC') return 1;
        if (s === 'BILINEAR') return 2;
        return null;
    }

    function resolveJustification(v) {
        if (v === undefined || v === null || v === '') return null;
        if (typeof v === 'number') return v;
        var s = enumKey(v);
        if (s.indexOf('_JUSTIFY') < 0) s = s + '_JUSTIFY';
        if (typeof ParagraphJustification !== 'undefined') {
            if (ParagraphJustification[s] !== undefined) return ParagraphJustification[s];
        }
        if (s === 'LEFT_JUSTIFY') return 0;
        if (s === 'CENTER_JUSTIFY') return 1;
        if (s === 'RIGHT_JUSTIFY') return 2;
        if (s === 'FULL_JUSTIFY_LASTLINE_LEFT') return 3;
        if (s === 'FULL_JUSTIFY_LASTLINE_CENTER') return 4;
        if (s === 'FULL_JUSTIFY_LASTLINE_RIGHT') return 5;
        if (s === 'FULL_JUSTIFY_LASTLINE_FULL') return 6;
        return null;
    }

    function isNoTrackMatte(v) {
        if (v === undefined || v === null || v === '') return true;
        if (typeof v === 'number') return v === 0;
        var s = enumKey(v);
        return (s === 'NONE' || s === 'NO_TRACK_MATTE' || s === 'NOTRACKMATTE') ? true : false;
    }

    function resolveTrackMatteMode(v) {
        if (v === undefined || v === null || v === '') return null;
        if (typeof v === 'number') return v;
        var s = enumKey(v);
        if (s === 'ALPHAINVERTED') s = 'ALPHA_INVERTED';
        if (s === 'LUMAINVERTED') s = 'LUMA_INVERTED';
        if (s === 'NONE' || s === 'NOTRACKMATTE') s = 'NO_TRACK_MATTE';
        if (typeof TrackMatteType !== 'undefined') {
            if (TrackMatteType[s] !== undefined) return TrackMatteType[s];
        }
        if (s === 'NO_TRACK_MATTE') return 0;
        if (s === 'ALPHA') return 1;
        if (s === 'ALPHA_INVERTED') return 2;
        if (s === 'LUMA') return 3;
        if (s === 'LUMA_INVERTED') return 4;
        return null;
    }

    // Aplica enabled/audioEnabled/guideLayer/motionBlur/samplingQuality. Cada
    // propiedad va en try/catch: cámaras, luces o capas sin audio no las tienen.
    function applyLayerOptions(ly, c, p) {
        var report = {};
        if (p.enabled !== undefined) {
            try { ly.enabled = !!p.enabled; report.enabled = !!p.enabled; } catch (eEn) { report.enabledError = eEn.toString(); }
        }
        if (p.audioEnabled !== undefined) {
            try { ly.audioEnabled = !!p.audioEnabled; report.audioEnabled = !!p.audioEnabled; } catch (eAu) { report.audioEnabledError = eAu.toString(); }
        }
        if (p.guideLayer !== undefined) {
            try { ly.guideLayer = !!p.guideLayer; report.guideLayer = !!p.guideLayer; } catch (eGu) { report.guideLayerError = eGu.toString(); }
        }
        if (p.motionBlur !== undefined) {
            try { ly.motionBlur = !!p.motionBlur; report.motionBlur = !!p.motionBlur; } catch (eMb) { report.motionBlurError = eMb.toString(); }
            if (p.motionBlur === true) {
                try { c.motionBlur = true; report.compMotionBlur = true; } catch (eCm) { report.compMotionBlurError = eCm.toString(); }
            }
        }
        if (p.samplingQuality !== undefined && p.samplingQuality !== null && p.samplingQuality !== '') {
            var sq = resolveSamplingQuality(p.samplingQuality);
            if (sq === null) {
                report.samplingQualityError = 'samplingQuality inválido: ' + p.samplingQuality;
            } else {
                try { ly.samplingQuality = sq; report.samplingQuality = sq; } catch (eSq) { report.samplingQualityError = eSq.toString(); }
            }
        }
        return report;
    }

    // AE 2023-2027: setTrackMatte(matteLayer, mode) reemplaza trackMatteType.
    // "none" quita el matte; sin setTrackMatte se usa el enum clásico.
    function applyTrackMatte(ly, c, p) {
        var report = { requested: false, applied: false, mode: null, matteLayer: null };
        var hasMode = (p.trackMatte !== undefined);
        var hasLayer = (p.trackMatteLayer !== undefined && p.trackMatteLayer !== null && p.trackMatteLayer !== '');
        if (!hasMode && !hasLayer) return report;
        report.requested = true;

        if (hasMode && isNoTrackMatte(p.trackMatte)) {
            var removed = false;
            try {
                if (typeof ly.removeTrackMatte === 'function') { ly.removeTrackMatte(); removed = true; }
            } catch (eRm) { report.error = eRm.toString(); }
            if (!removed) {
                var noMatte = 0;
                if (typeof TrackMatteType !== 'undefined' && TrackMatteType.NO_TRACK_MATTE !== undefined) noMatte = TrackMatteType.NO_TRACK_MATTE;
                try { ly.trackMatteType = noMatte; removed = true; } catch (eNo) { report.error = eNo.toString(); }
            }
            report.applied = removed;
            report.mode = 'none';
            return report;
        }

        var matteLy = null;
        if (hasLayer) {
            matteLy = getLayer(c, p.trackMatteLayer);
            if (!matteLy) {
                report.error = 'capa de track matte no encontrada: ' + p.trackMatteLayer;
                return report;
            }
            report.matteLayer = matteLy.name;
        }

        var requestedMode = hasMode ? p.trackMatte : 'alpha';
        var mode = resolveTrackMatteMode(requestedMode);
        if (mode === null) {
            report.error = 'trackMatte inválido: ' + requestedMode;
            return report;
        }

        var applied = false;
        if (matteLy && typeof ly.setTrackMatte === 'function') {
            try { ly.setTrackMatte(matteLy, mode); applied = true; } catch (eSet) { report.error = eSet.toString(); }
        }
        if (!applied) {
            try { ly.trackMatteType = mode; applied = true; } catch (eType) { if (!report.error) report.error = eType.toString(); }
        }
        report.applied = applied;
        report.mode = mode;
        return report;
    }

    // valueAtTime(t, false) evalúa sin mutar la comp (pose es solo lectura).
    function valueAtTimeOf(prop, t, def) {
        if (!prop) return def;
        try {
            if (typeof prop.valueAtTime === 'function') return prop.valueAtTime(t, false);
        } catch (e) {}
        return propValue(prop, def);
    }

    function setInterp(prop, type) {
        if (!prop) return;
        for (var k = 1; k <= prop.numKeys; k++) {
            try { prop.setInterpolationTypeAtKey(k, type, type); } catch (e) {}
        }
    }

    // AE exige un número de KeyframeEase distinto según propertyValueType:
    // TwoD_SPATIAL, ThreeD_SPATIAL, COLOR y OneD -> 1; TwoD -> 2; ThreeD -> 3.
    function getEaseDimensions(prop) {
        var pvt = null;
        try { pvt = prop.propertyValueType; } catch (e) { pvt = null; }
        if (pvt === null || pvt === undefined) return 1;
        if (typeof PropertyValueType !== 'undefined') {
            if (pvt === PropertyValueType.TwoD) return 2;
            if (pvt === PropertyValueType.ThreeD) return 3;
            return 1;
        }
        // Sin enum disponible (mocks): heurística por longitud del valor.
        var val = null;
        try { val = prop.value; } catch (e2) { val = null; }
        if (val && typeof val !== 'string' && typeof val.length === 'number') {
            if (val.length === 2) return 2;
            if (val.length === 3) return 3;
        }
        return 1;
    }

    function applyEase(prop, keyIndex, inInf, outInf) {
        if (!prop || keyIndex < 1 || keyIndex > prop.numKeys) return false;
        var dims = getEaseDimensions(prop);
        var inV = (inInf === undefined || inInf === null || isNaN(Number(inInf))) ? 33.33 : Number(inInf);
        var outV = (outInf === undefined || outInf === null || isNaN(Number(outInf))) ? 33.33 : Number(outInf);
        if (inV < 0.1) inV = 0.1;
        if (inV > 100) inV = 100;
        if (outV < 0.1) outV = 0.1;
        if (outV > 100) outV = 100;
        var ins = [];
        var outs = [];
        var i;
        for (i = 0; i < dims; i++) {
            ins.push(new KeyframeEase(0, inV));
            outs.push(new KeyframeEase(0, outV));
        }
        try {
            prop.setTemporalEaseAtKey(keyIndex, ins, outs);
            return true;
        } catch (e) {
            return false;
        }
    }

    function resolveBasedOn(v) {
        if (typeof v === 'number') return (v >= 1 && v <= 4) ? v : null;
        var s = String(v).toLowerCase().split(' ').join('-').split('_').join('-');
        if (s === 'characters' || s === 'character' || s === 'chars' || s === 'char') return 1;
        if (s === 'characters-no-spaces' || s === 'chars-no-spaces' || s === 'no-spaces' || s === 'charactersexcludingspaces') return 2;
        if (s === 'words' || s === 'word') return 3;
        if (s === 'lines' || s === 'line') return 4;
        return null;
    }

    function resolveSelectorShape(v) {
        if (typeof v === 'number') return (v >= 1 && v <= 6) ? v : null;
        var s = String(v).toLowerCase().split(' ').join('-').split('_').join('-');
        if (s === 'square') return 1;
        if (s === 'ramp-up' || s === 'rampup') return 2;
        if (s === 'ramp-down' || s === 'rampdown') return 3;
        if (s === 'triangle') return 4;
        if (s === 'round') return 5;
        if (s === 'smooth') return 6;
        return null;
    }

    function findEffect(q) {
        q = String(q).toLowerCase();
        for (var i = 0; i < app.effects.length; i++) {
            var e = app.effects[i];
            var d = String(e.displayName || '').toLowerCase();
            var m = String(e.matchName || '').toLowerCase();
            if (d === q || m === q || d.indexOf(q) >= 0) return e;
        }
        return null;
    }

    function compInfo(c) {
        return { name: c.name, width: c.width, height: c.height, duration: c.duration, frameRate: c.frameRate, layers: c.numLayers, id: c.id };
    }

    function layerInfo(ly) {
        var kind = 'other';
        try {
            if (ly instanceof TextLayer) kind = 'text';
            else if (ly instanceof ShapeLayer) kind = 'shape';
            else if (ly instanceof CameraLayer) kind = 'camera';
            else if (ly instanceof LightLayer) kind = 'light';
            else if (ly instanceof AVLayer) kind = 'av';
        } catch (e) {}
        if (ly.adjustmentLayer) kind = 'adjustment';
        return { index: ly.index, name: ly.name, kind: kind, inPoint: ly.inPoint, outPoint: ly.outPoint, enabled: ly.enabled };
    }
    // Undo group + try/catch/finally para toda mutación del proyecto.
    function withUndo(label, fn) {
        var undo = (typeof app.beginUndoGroup === 'function');
        if (undo) app.beginUndoGroup('Antigravity: ' + label);
        try {
            return fn();
        } catch (e) {
            return { ok: false, error: e.toString() };
        } finally {
            if (undo && typeof app.endUndoGroup === 'function') app.endUndoGroup();
        }
    }

    // saveFrameToPng escribe en diferido: espera acotada a que el archivo exista
    // y tenga bytes en disco antes de devolver su ruta al panel/MCP.
    function waitForFileWritten(file, timeoutMs) {
        var start = new Date().getTime();
        var limit = (timeoutMs === undefined || timeoutMs === null) ? 10000 : timeoutMs;
        while (true) {
            var ok = false;
            try {
                // Un File nuevo fuerza una lectura fresca de exists/length: el
                // objeto original puede tener cacheado el estado previo.
                var probe = new File(file.fsName);
                ok = (probe.exists && probe.length > 0) ? true : false;
            } catch (eChk) { ok = false; }
            if (ok) return true;
            if (new Date().getTime() - start >= limit) return false;
            if (typeof $.sleep === 'function') $.sleep(100);
        }
    }

    // Ojos: captura un frame de la comp a PNG. saveFrameToPng escribe de forma
    // diferida; aquí se espera a que termine y se devuelve la ruta exacta.
    // Con p.path / p.outputPath el PNG es del usuario: temp=false y no se borra.
    function renderFrame(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrada' };
        var t = (p.time !== undefined && p.time !== null) ? Number(p.time) : c.time;
        if (isNaN(t)) t = c.time;
        if (t < 0) t = 0;
        if (t > c.duration) t = c.duration;
        var target = null;
        if (p.path !== undefined && p.path !== null && String(p.path).length > 0) target = String(p.path);
        else if (p.outputPath !== undefined && p.outputPath !== null && String(p.outputPath).length > 0) target = String(p.outputPath);
        var file = null;
        var temp = false;
        if (target) {
            file = new File(target);
            if (file.parent && !file.parent.exists) {
                return { ok: false, error: 'carpeta no existe: ' + file.parent.fsName };
            }
        } else {
            var name = 'antigravity_frame_' + (new Date().getTime()) + '_' + Math.floor(Math.random() * 100000) + '.png';
            file = new File(Folder.temp.fsName + '/' + name);
            temp = true;
        }
        try {
            c.saveFrameToPng(t, file);
        } catch (eSave) {
            return { ok: false, error: 'saveFrameToPng falló: ' + eSave.toString(), comp: c.name, time: t, path: file.fsName, temp: temp };
        }
        var written = waitForFileWritten(file, 10000);
        if (!written) {
            return { ok: false, error: 'saveFrameToPng no terminó de escribir el PNG', comp: c.name, time: t, path: file.fsName, temp: temp, written: false };
        }
        return { ok: true, comp: c.name, time: t, path: file.fsName, temp: temp, written: true };
    }

    // Contexto de la GUI: comp activa y capas seleccionadas.
    function selection() {
        var c = app.project.activeItem;
        if (!c || !(c instanceof CompItem)) {
            return { ok: true, comp: null, selectedLayers: [] };
        }
        var sel = [];
        var layers = c.selectedLayers;
        if (layers) {
            for (var i = 0; i < layers.length; i++) {
                var ly = layers[i];
                sel.push({ index: ly.index, name: ly.name, kind: layerInfo(ly).kind });
            }
        }
        return { ok: true, comp: c.name, time: c.time, selectedLayers: sel };
    }

    function transformProp(ly, prop) {
        var map = {
            position: ['ADBE Transform Group', 'ADBE Position'],
            scale: ['ADBE Transform Group', 'ADBE Scale'],
            rotation: ['ADBE Transform Group', 'ADBE Rotate Z'],
            opacity: ['ADBE Transform Group', 'ADBE Opacity'],
            anchor: ['ADBE Transform Group', 'ADBE Anchor Point']
        };
        var m = map[prop];
        if (!m) return null;
        return ly.property(m[0]).property(m[1]);
    }

    // --- Medición y geometría ---------------------------------------------
    // Base compartida por measure, alignAnchor y check. Todo en espacio de
    // capa: world = position + R(rotation) * S(scale) * (punto - anchorPoint).
    function propValue(prop, def) {
        if (!prop) return def;
        try { return prop.value; } catch (e) { return def; }
    }

    function timeOfComp(c, p) {
        var t = (p && p.time !== undefined && p.time !== null) ? num(p.time, c.time) : c.time;
        if (t < 0) t = 0;
        if (t > c.duration) t = c.duration;
        return t;
    }

    function sourceRectOf(ly, t) {
        if (!ly) return null;
        var has = false;
        try { has = (typeof ly.sourceRectAtTime === 'function'); } catch (e0) { has = false; }
        if (!has) return null;
        try {
            var r = ly.sourceRectAtTime(t, false);
            if (!r) return null;
            return { left: num(r.left, 0), top: num(r.top, 0), width: num(r.width, 0), height: num(r.height, 0) };
        } catch (e) {
            return null;
        }
    }

    function transformValues(ly) {
        var g = transformOf(ly);
        var rotProp = g ? txProp(g, ['ADBE Rotate Z', 'ADBE Rotate X', 'ADBE Rotate Y']) : null;
        return {
            position: propValue(g ? propSafe(g, 'ADBE Position') : null, null),
            anchor: propValue(g ? propSafe(g, 'ADBE Anchor Point') : null, null),
            scale: propValue(g ? propSafe(g, 'ADBE Scale') : null, null),
            rotation: propValue(rotProp, 0),
            opacity: propValue(g ? propSafe(g, 'ADBE Opacity') : null, null)
        };
    }

    // Variante temporal: check mide en el time solicitado, sin mover el playhead.
    function transformValuesAt(ly, t) {
        var g = transformOf(ly);
        var rotProp = g ? txProp(g, ['ADBE Rotate Z', 'ADBE Rotate X', 'ADBE Rotate Y']) : null;
        return {
            position: valueAtTimeOf(g ? propSafe(g, 'ADBE Position') : null, t, null),
            anchor: valueAtTimeOf(g ? propSafe(g, 'ADBE Anchor Point') : null, t, null),
            scale: valueAtTimeOf(g ? propSafe(g, 'ADBE Scale') : null, t, null),
            rotation: valueAtTimeOf(rotProp, t, 0),
            opacity: valueAtTimeOf(g ? propSafe(g, 'ADBE Opacity') : null, t, null)
        };
    }

    function numAt(arr, idx, def) {
        if (!arr || typeof arr.length !== 'number') return def;
        if (idx < 0 || idx >= arr.length) return def;
        return num(arr[idx], def);
    }

    function worldBoundsOf(ly, t) {
        var r = sourceRectOf(ly, t);
        if (!r) return null;
        var tv = transformValuesAt(ly, t);
        var pos = tv.position;
        if (!pos || typeof pos.length !== 'number') return null;
        var anchor = tv.anchor || [0, 0];
        var scale = tv.scale || [100, 100];
        var sx = numAt(scale, 0, 100) / 100;
        var sy = numAt(scale, 1, 100) / 100;
        var rad = num(tv.rotation, 0) * Math.PI / 180;
        var cos = Math.cos(rad);
        var sin = Math.sin(rad);
        var xs = [r.left, r.left + r.width, r.left + r.width, r.left];
        var ys = [r.top, r.top, r.top + r.height, r.top + r.height];
        var left = null;
        var top = null;
        var right = null;
        var bottom = null;
        var i;
        for (i = 0; i < 4; i++) {
            var lx = (xs[i] - numAt(anchor, 0, 0)) * sx;
            var lyy = (ys[i] - numAt(anchor, 1, 0)) * sy;
            var wx = numAt(pos, 0, 0) + lx * cos - lyy * sin;
            var wy = numAt(pos, 1, 0) + lx * sin + lyy * cos;
            if (left === null || wx < left) left = wx;
            if (right === null || wx > right) right = wx;
            if (top === null || wy < top) top = wy;
            if (bottom === null || wy > bottom) bottom = wy;
        }
        return {
            left: left, top: top, right: right, bottom: bottom,
            centerX: (left + right) / 2, centerY: (top + bottom) / 2
        };
    }

    function valuesClose(a, b) {
        if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 0.001;
        return false;
    }

    function valuesMatch(a, b) {
        if (a === b) return true;
        if (typeof a === 'number' || typeof b === 'number') return valuesClose(Number(a), Number(b));
        if (a && b && typeof a === 'object' && typeof b === 'object') {
            if (typeof a.length === 'number' && typeof b.length === 'number') {
                // AE devuelve [x, y, 0] en Anchor Point / Position incluso cuando se escribe [x, y].
                if (a.length !== b.length) {
                    if (a.length === 2 && b.length === 3 && valuesClose(Number(b[2]), 0)) {
                        return valuesClose(Number(a[0]), Number(b[0])) && valuesClose(Number(a[1]), Number(b[1]));
                    }
                    if (b.length === 2 && a.length === 3 && valuesClose(Number(a[2]), 0)) {
                        return valuesClose(Number(a[0]), Number(b[0])) && valuesClose(Number(a[1]), Number(b[1]));
                    }
                    return false;
                }
                for (var i = 0; i < a.length; i++) {
                    if (!valuesClose(Number(a[i]), Number(b[i]))) return false;
                }
                return true;
            }
        }
        if (typeof a === 'string' && typeof b === 'string') return String(a) === String(b);
        return false;
    }

    function isShapeValue(val) {
        try {
            if (typeof Shape !== 'undefined' && val instanceof Shape) return true;
        } catch (e) {}
        return !!(val && typeof val === 'object' && typeof val.vertices !== 'undefined');
    }

    // Absorbe el falso "divide by zero" que AE lanza cuando la comp no está
    // activa en el visor: si el readback coincide, el valor sí se aplicó.
    function setValueChecked(prop, val) {
        if (!prop) return { ok: false, error: 'propiedad inexistente' };
        var threw = false;
        var errMsg = '';
        try {
            prop.setValue(val);
        } catch (e) {
            var msg = String(e).toLowerCase();
            if (msg.indexOf('divide by zero') < 0) {
                return { ok: false, error: String(e) };
            }
            threw = true;
            errMsg = String(e);
        }
        if (isShapeValue(val)) return { ok: true, verified: false, warning: 'valor Shape aplicado sin readback' };
        var got = null;
        var unreadable = false;
        try { got = prop.value; } catch (eRead) { unreadable = true; }
        if (unreadable) return { ok: true, verified: false, warning: 'valor aplicado sin readback' };
        if (valuesMatch(got, val)) {
            var res = { ok: true, verified: true };
            if (threw) res.warning = 'setValue lanzó "' + errMsg + '" pero el readback coincide';
            return res;
        }
        return { ok: false, error: 'el valor no coincide tras setValue', expected: val, got: got };
    }

    function justificationName(v) {
        if (typeof ParagraphJustification === 'undefined') return null;
        var names = ['LEFT_JUSTIFY', 'RIGHT_JUSTIFY', 'CENTER_JUSTIFY', 'FULL_JUSTIFY_LASTLINE_LEFT', 'FULL_JUSTIFY_LASTLINE_RIGHT', 'FULL_JUSTIFY_LASTLINE_CENTER', 'FULL_JUSTIFY_LASTLINE_FULL'];
        for (var i = 0; i < names.length; i++) {
            if (ParagraphJustification[names[i]] === v) return names[i];
        }
        return null;
    }

    function textInfoOf(ly) {
        var td = propSafe(propSafe(ly, 'ADBE Text Properties'), 'ADBE Text Document');
        if (!td) return null;
        var doc = propValue(td, null);
        if (!doc) return null;
        return {
            text: String(doc.text === undefined || doc.text === null ? '' : doc.text),
            font: doc.font,
            fontSize: doc.fontSize,
            tracking: doc.tracking,
            leading: doc.leading,
            justification: doc.justification,
            justificationName: justificationName(doc.justification)
        };
    }

    function layerMeasurement(ly, t) {
        var tv = transformValues(ly);
        var info = layerInfo(ly);
        var out = {
            index: ly.index,
            name: ly.name,
            kind: info.kind,
            parent: ly.parent ? ly.parent.name : null,
            threeD: !!ly.threeDLayer,
            enabled: !!ly.enabled,
            inPoint: ly.inPoint,
            outPoint: ly.outPoint,
            position: tv.position,
            anchorPoint: tv.anchor,
            scale: tv.scale,
            rotation: tv.rotation,
            opacity: tv.opacity,
            sourceRect: null,
            worldBounds: null
        };
        var r = sourceRectOf(ly, t);
        if (r) out.sourceRect = r;
        var wb = worldBoundsOf(ly, t);
        if (wb) out.worldBounds = wb;
        if (info.kind === 'text') {
            var ti = textInfoOf(ly);
            if (ti) {
                out.text = ti.text;
                out.font = ti.font;
                out.fontSize = ti.fontSize;
                out.tracking = ti.tracking;
                out.leading = ti.leading;
                out.justification = ti.justification;
                out.justificationName = ti.justificationName;
            }
        }
        return out;
    }

    // PASO 0: medición determinista de la comp y sus capas.
    function measure(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var t = timeOfComp(c, p);
        var targets = [];
        var i;
        if (p.layers && typeof p.layers.length === 'number') {
            for (i = 0; i < p.layers.length; i++) {
                var one = getLayer(c, p.layers[i]);
                if (one) targets.push(one);
            }
        } else if (p.layer !== undefined && p.layer !== null && p.layer !== '') {
            var only = getLayer(c, p.layer);
            if (!only) return { ok: false, error: 'capa no encontrada: ' + p.layer };
            targets.push(only);
        } else {
            for (i = 1; i <= c.numLayers; i++) targets.push(c.layer(i));
        }
        var layers = [];
        for (i = 0; i < targets.length; i++) layers.push(layerMeasurement(targets[i], t));
        return {
            ok: true,
            comp: { name: c.name, width: c.width, height: c.height, fps: c.frameRate, duration: c.duration, time: t },
            layers: layers
        };
    }

    function anchorPreset(name) {
        var raw = (name === undefined || name === null || name === '') ? 'center' : String(name);
        var s = raw.toLowerCase().split(' ').join('-').split('_').join('-');
        if (s === 'center' || s === 'centro') return { x: 0.5, y: 0.5, baseline: false };
        if (s === 'top-left' || s === 'arriba-izquierda') return { x: 0, y: 0, baseline: false };
        if (s === 'center-left' || s === 'izquierda-centro') return { x: 0, y: 0.5, baseline: false };
        if (s === 'bottom-left' || s === 'abajo-izquierda') return { x: 0, y: 1, baseline: false };
        if (s === 'top-right' || s === 'arriba-derecha') return { x: 1, y: 0, baseline: false };
        if (s === 'center-right' || s === 'derecha-centro') return { x: 1, y: 0.5, baseline: false };
        if (s === 'bottom-right' || s === 'abajo-derecha') return { x: 1, y: 1, baseline: false };
        if (s === 'baseline-left' || s === 'linea-base-izquierda') return { x: 0, y: 0, baseline: true };
        if (s === 'baseline-center' || s === 'linea-base-centro') return { x: 0.5, y: 0, baseline: true };
        return null;
    }

    // Mueve el Anchor Point al punto pedido del sourceRect y compensa Position
    // (con Scale y Rotation) para que la capa no se mueva en pantalla.
    function alignAnchor(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var ly = getLayer(c, p.layer);
        if (!ly) return { ok: false, error: 'capa no encontrada: ' + p.layer };
        var cfg = anchorPreset(p.preset);
        if (!cfg) return { ok: false, error: 'preset inválido: ' + p.preset };
        var t = timeOfComp(c, p);
        var rect = sourceRectOf(ly, t);
        if (!rect) return { ok: false, error: 'la capa no expone sourceRectAtTime' };
        var tv = transformValues(ly);
        var oldAnchor = tv.anchor || [0, 0];
        var newAnchor = [0, 0];
        newAnchor[0] = rect.left + rect.width * cfg.x;
        if (cfg.baseline) newAnchor[1] = 0;
        else newAnchor[1] = rect.top + rect.height * cfg.y;

        var sx = numAt(tv.scale, 0, 100) / 100;
        var sy = numAt(tv.scale, 1, 100) / 100;
        var rad = num(tv.rotation, 0) * Math.PI / 180;
        var cos = Math.cos(rad);
        var sin = Math.sin(rad);
        var dx = (newAnchor[0] - numAt(oldAnchor, 0, 0)) * sx;
        var dy = (newAnchor[1] - numAt(oldAnchor, 1, 0)) * sy;
        var moveX = dx * cos - dy * sin;
        var moveY = dx * sin + dy * cos;
        var pos = tv.position || [0, 0];
        var newPos = [numAt(pos, 0, 0) + moveX, numAt(pos, 1, 0) + moveY];
        if (typeof pos.length === 'number' && pos.length > 2) newPos.push(numAt(pos, 2, 0));

        var g = transformOf(ly);
        var anchorProp = g ? propSafe(g, 'ADBE Anchor Point') : null;
        var posProp = g ? propSafe(g, 'ADBE Position') : null;
        if (!anchorProp || !posProp) return { ok: false, error: 'la capa no expone Anchor Point/Position' };

        var anchorRes = setValueChecked(anchorProp, newAnchor);
        if (!anchorRes.ok) return { ok: false, error: 'anchorPoint: ' + anchorRes.error };
        var posRes = setValueChecked(posProp, newPos);
        if (!posRes.ok) return { ok: false, error: 'position: ' + posRes.error };

        return {
            ok: true,
            layer: ly.name,
            preset: (p.preset === undefined || p.preset === null || p.preset === '') ? 'center' : String(p.preset),
            time: t,
            sourceRect: rect,
            oldAnchorPoint: oldAnchor,
            anchorPoint: newAnchor,
            position: newPos,
            offset: [moveX, moveY],
            parent: ly.parent ? ly.parent.name : null,
            verified: !!(anchorRes.verified && posRes.verified)
        };
    }

    // ---------------- PROJECT ----------------
    function project() {
        var comps = [];
        var items = [];
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            items.push({ id: it.id, name: it.name, type: it.typeName });
            if (it instanceof CompItem) comps.push(compInfo(it));
        }
        var active = app.project.activeItem;
        var layers = [];
        if (active && active instanceof CompItem) {
            for (var l = 1; l <= active.numLayers; l++) layers.push(layerInfo(active.layer(l)));
        }
        return { ok: true, project: app.project.name, active: active ? active.name : null, comps: comps, items: items, activeLayers: layers };
    }

    function catalog(p) {
        var q = p.query ? String(p.query).toLowerCase() : '';
        var cat = p.category ? String(p.category).toLowerCase() : '';
        var limit = p.limit || 200;
        var list = [];
        for (var i = 0; i < app.effects.length; i++) {
            var e = app.effects[i];
            var d = String(e.displayName || '');
            var m = String(e.matchName || '');
            var c = String(e.category || '');
            if (cat && c.toLowerCase().indexOf(cat) < 0) continue;
            if (!q || d.toLowerCase().indexOf(q) >= 0 || m.toLowerCase().indexOf(q) >= 0) {
                list.push({ name: d, matchName: m, category: c });
                if (list.length >= limit) break;
            }
        }
        return { ok: true, total: app.effects.length, count: list.length, items: list };
    }

    function comp(p) {
        var c = app.project.items.addComp(p.name || 'AG Comp', p.width || 1920, p.height || 1080, p.pixelAspect || 1, p.duration || 5, p.fps || 30);
        try { c.openInViewer(); } catch (eOpen) {}
        return { ok: true, comp: compInfo(c) };
    }

    function layer(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var kind = p.kind || 'solid';
        var ly = null;
        var fps = (c.frameRate > 0) ? c.frameRate : 30;
        var t0 = (p.time !== undefined && p.time !== null) ? num(p.time, c.time) : c.time;
        if (t0 < 0) t0 = 0;
        if (kind === 'text') ly = c.layers.addText(p.text || p.name || 'Texto');
        else if (kind === 'null') { ly = c.layers.addNull(); if (p.name) ly.name = p.name; }
        else if (kind === 'shape') { ly = c.layers.addShape(); if (p.name) ly.name = p.name; }
        else if (kind === 'camera') ly = c.layers.addCamera(p.name || 'Camera', p.center || [c.width / 2, c.height / 2]);
        else if (kind === 'light') ly = c.layers.addLight(p.name || 'Light', p.center || [c.width / 2, c.height / 2]);
        else if (kind === 'footage' || kind === 'precomp') {
            var item = getItem(p.item);
            if (!item) return { ok: false, error: 'ítem no encontrado: ' + p.item };
            ly = c.layers.add(item);
            if (p.name) ly.name = p.name;
        } else {
            var col = p.color;
            if (typeof col === 'string') col = hexToRgb(col);
            if (!col || !col.length) col = [0.1, 0.4, 1];
            var dur = (p.duration !== undefined && p.duration !== null) ? num(p.duration, c.duration) : c.duration;
            ly = c.layers.addSolid(col, p.name || 'Solid', c.width, c.height, c.pixelAspect || 1, dur);
            if (kind === 'adjustment') ly.adjustmentLayer = true;
        }
        if (p.blendingMode !== undefined && p.blendingMode !== null) {
            var bm = blendModeFrom(p.blendingMode);
            if (bm !== null) ly.blendingMode = bm;
        }
        if (p.startTime !== undefined) ly.startTime = p.startTime;
        else ly.startTime = t0;
        if (p.inPoint !== undefined) ly.inPoint = p.inPoint;
        if (p.outPoint !== undefined) ly.outPoint = p.outPoint;
        else if (p.duration !== undefined) ly.outPoint = ly.inPoint + num(p.duration, 1);

        if (p.keyframes && typeof p.keyframes === 'object') {
            var transGroup = transformOf(ly);
            if (p.keyframes.opacity && transGroup) {
                var opProp = propSafe(transGroup, 'ADBE Opacity');
                if (opProp) {
                    var kfs = p.keyframes.opacity;
                    for (var ki = 0; ki < kfs.length; ki++) {
                        var kf = kfs[ki];
                        var kfTime = (kf.frame !== undefined) ? (t0 + num(kf.frame, 0) / fps) : (t0 + num(kf.time, 0));
                        var kfVal = num(kf.value, 100);
                        opProp.setValueAtTime(kfTime, kfVal);
                    }
                    for (var kj = 1; kj <= opProp.numKeys; kj++) {
                        var kfObj = kfs[kj - 1];
                        if (kfObj && (kfObj.interpolation === 'hold' || kfObj.interp === 'hold')) {
                            try { opProp.setInterpolationTypeAtKey(kj, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD); } catch (eH) {}
                        }
                    }
                }
            }
        }
        var layerFlags = applyLayerOptions(ly, c, p);
        var matteResult = applyTrackMatte(ly, c, p);
        return { ok: true, layer: layerInfo(ly), flags: layerFlags, trackMatte: matteResult };
    }

    function settings(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var ly = getLayer(c, p.layer);
        if (!ly) return { ok: false, error: 'capa no encontrada' };
        var matteApplied = false;
        var matteError = null;
        var matteMode = null;
        var matteLayerName = null;
        if (p.parent !== undefined) {
            if (p.parent === null || p.parent === 0) ly.parent = null;
            else ly.parent = getLayer(c, p.parent);
        }
        if (p.threeD !== undefined) ly.threeDLayer = !!p.threeD;
        if (p.blend !== undefined) {
            try { ly.blendingMode = BlendingMode[p.blend] !== undefined ? BlendingMode[p.blend] : p.blend; } catch (e) {}
        }
        if (p.trackMatte !== undefined || p.trackMatteLayer !== undefined) {
            var matteResult = applyTrackMatte(ly, c, p);
            if (matteResult && matteResult.error) matteError = matteResult.error;
            if (matteResult && matteResult.applied) matteApplied = true;
            if (matteResult && matteResult.mode !== null && matteResult.mode !== undefined) matteMode = matteResult.mode;
            if (matteResult && matteResult.matteLayer) matteLayerName = matteResult.matteLayer;
        }
        if (p.inPoint !== undefined) ly.inPoint = p.inPoint;
        if (p.outPoint !== undefined) ly.outPoint = p.outPoint;
        if (p.startTime !== undefined) ly.startTime = p.startTime;
        if (p.solo !== undefined) ly.solo = !!p.solo;
        if (p.locked !== undefined) ly.locked = !!p.locked;
        var layerFlags = applyLayerOptions(ly, c, p);
        return {
            ok: true,
            layer: ly.name,
            parent: ly.parent ? ly.parent.name : null,
            threeD: ly.threeDLayer,
            blend: ly.blendingMode,
            trackMatte: ly.trackMatteType,
            trackMatteApplied: matteApplied,
            trackMatteMode: matteMode,
            trackMatteLayer: matteLayerName,
            trackMatteError: matteError,
            flags: layerFlags
        };
    }

    // ---------------- SHAPE ----------------
    function shape(p) {
        var step = 'comp';
        try {
            var c = getComp(p.comp);
            if (!c) return { ok: false, error: 'comp no encontrado' };
            step = 'layer';
            var ly = getLayer(c, p.layer);
            if (!ly) {
                ly = c.layers.addShape();
                if (p.name) ly.name = p.name;
            }
            step = 'root';
            var root = ly.property('ADBE Root Vectors Group');
            if (!root) return { ok: false, error: 'la capa no es shape' };
            var kind = p.shape || p.type || 'rect';
            var map = { rect: 'ADBE Vector Shape - Rect', ellipse: 'ADBE Vector Shape - Ellipse', star: 'ADBE Vector Shape - Star' };
            var match = map[kind];
            if (!match) return { ok: false, error: 'shape inválido (rect|ellipse|star)' };
            step = 'add:' + match;
            var prim = root.addProperty(match);
            if (!prim) return { ok: false, error: 'no se pudo crear la primitiva' };
            step = 'size';
            if (p.size) {
                if (kind === 'rect') prim.property('ADBE Vector Rect Size').setValue(p.size);
                else if (kind === 'ellipse') prim.property('ADBE Vector Ellipse Size').setValue(p.size);
                else prim.property('ADBE Vector Star Outer Radius').setValue(p.size);
            }
            if (kind === 'rect' && p.roundness !== undefined) {
                var rProp = propSafe(prim, 'ADBE Vector Rect Roundness');
                if (rProp) try { rProp.setValue(num(p.roundness, 0)); } catch (eR) {}
            }
            step = 'pos';
            if (p.position) {
                var posName = (kind === 'rect') ? 'ADBE Vector Rect Position' : (kind === 'ellipse' ? 'ADBE Vector Ellipse Position' : 'ADBE Vector Star Position');
                prim.property(posName).setValue(p.position);
            }
            if (p.fillColor) {
                var f = root.addProperty('ADBE Vector Graphic - Fill');
                if (f) {
                    var fc = (typeof p.fillColor === 'string') ? hexToRgb(p.fillColor) : p.fillColor;
                    if (fc) f.property('ADBE Vector Fill Color').setValue(fc);
                    if (p.opacity !== undefined) f.property('ADBE Vector Fill Opacity').setValue(num(p.opacity, 100));
                }
            }
            if (p.scaleX) {
                var sx = p.scaleX;
                var t0 = num(p.time, c.time);
                var fps = (c.frameRate > 0) ? c.frameRate : 30;
                var dt = (sx.durationFrames !== undefined) ? (num(sx.durationFrames, 15) / fps) : 0.5;
                var transGroup = transformOf(ly);
                var scaleProp = transGroup ? propSafe(transGroup, 'ADBE Scale') : null;
                if (scaleProp) {
                    scaleProp.setValueAtTime(t0, [num(sx.startVal, 0), 100]);
                    scaleProp.setValueAtTime(t0 + dt, [num(sx.endVal, 100), 100]);
                    setInterp(scaleProp, KeyframeInterpolationType.BEZIER);
                    var outEase = clampNum(num(sx.easeOut, 80), 0, 100);
                    if (outEase > 0) {
                        applyEase(scaleProp, 1, 0, 20);
                        applyEase(scaleProp, 2, outEase, 0);
                    }
                }
            }
            step = 'done';
            return { ok: true, shape: kind, name: prim.name, layer: ly.name, step: step };
        } catch (e) {
            return { ok: false, error: e.toString(), step: step };
        }
    }

    function fill(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var ly = getLayer(c, p.layer);
        if (!ly) return { ok: false, error: 'capa no encontrada' };
        var root = ly.property('ADBE Root Vectors Group');
        if (!root) return { ok: false, error: 'la capa no es shape' };
        var f = root.addProperty('ADBE Vector Graphic - Fill');
        if (!f) return { ok: false, error: 'no se pudo crear el fill' };
        f.property('ADBE Vector Fill Color').setValue(p.color || [1, 1, 1]);
        return { ok: true, fill: p.color || [1, 1, 1] };
    }

    // ---------------- TEXT ----------------
    function text(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var createdLayer = false;
        var ly = getLayer(c, p.layer);
        if (!ly && (!p.layer || p.layer === 1)) {
            if (c.selectedLayers && c.selectedLayers.length > 0 && c.selectedLayers[0] instanceof TextLayer) {
                ly = c.selectedLayers[0];
            } else {
                for (var li = 1; li <= c.numLayers; li++) {
                    if (c.layer(li) instanceof TextLayer) { ly = c.layer(li); break; }
                }
            }
        }
        if (!ly) {
            ly = c.layers.addText(p.text !== undefined ? String(p.text) : '');
            createdLayer = true;
            if (p.name) ly.name = p.name;
        }
        if (!(ly instanceof TextLayer)) return { ok: false, error: 'la capa no es de texto' };
        var td = ly.property('ADBE Text Properties').property('ADBE Text Document');
        if (!td) return { ok: false, error: 'sin propiedad de texto' };
        var doc = td.value;
        // En una capa nueva, resetCharStyle es true por defecto: si el panel
        // Carácter tiene allCaps activo, se heredaría y el texto saldría en
        // mayúsculas. Se resetea antes de tocar font/size/tracking/leading/fill.
        var reset = (p.resetCharStyle === true) || (createdLayer && p.resetCharStyle !== false);
        if (reset) {
            try { doc.resetCharStyle(); } catch (eReset) {}
        }
        if (p.text !== undefined && p.text !== null) doc.text = String(p.text);
        if (p.font) doc.font = p.font;
        if (p.fontSize !== undefined && p.fontSize !== null) doc.fontSize = num(p.fontSize, 36);
        if (p.tracking !== undefined && p.tracking !== null) doc.tracking = num(p.tracking, doc.tracking);
        if (p.leading !== undefined && p.leading !== null) doc.leading = num(p.leading, doc.leading);
        if (p.fillColor !== undefined && p.fillColor !== null) {
            var fc = (typeof p.fillColor === 'string') ? hexToRgb(p.fillColor) : p.fillColor;
            if (fc) doc.fillColor = fc;
        }
        if (p.allCaps !== undefined) {
            try { doc.allCaps = !!p.allCaps; } catch (eCaps) {}
        }
        if (p.justification !== undefined) {
            var jv = resolveJustification(p.justification);
            if (jv !== null) doc.justification = jv;
        }
        td.setValue(doc);
        if (p.expression) {
            try { td.expression = p.expression; } catch (eExpr) {}
        }
        return {
            ok: true,
            layer: ly.name,
            text: doc.text,
            resetCharStyle: reset,
            tracking: doc.tracking,
            leading: doc.leading,
            allCaps: doc.allCaps
        };
    }

    function textStyle(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var ly = getLayer(c, p.layer);
        if (!ly) return { ok: false, error: 'capa no encontrada' };
        if (!(ly instanceof TextLayer)) return { ok: false, error: 'la capa no es de texto' };
        var td = ly.property('ADBE Text Properties').property('ADBE Text Document');
        if (!td) return { ok: false, error: 'sin propiedad de texto' };
        var doc = td.value;
        var reset = (p.resetCharStyle === true);
        if (reset) {
            try { doc.resetCharStyle(); } catch (eReset) {}
        }
        if (p.font) doc.font = p.font;
        if (p.fontSize !== undefined && p.fontSize !== null) doc.fontSize = num(p.fontSize, doc.fontSize);
        if (p.fillColor !== undefined && p.fillColor !== null) {
            var fc = (typeof p.fillColor === 'string') ? hexToRgb(p.fillColor) : p.fillColor;
            if (fc) doc.fillColor = fc;
        }
        if (p.tracking !== undefined && p.tracking !== null) doc.tracking = num(p.tracking, doc.tracking);
        if (p.leading !== undefined && p.leading !== null) doc.leading = num(p.leading, doc.leading);
        if (p.allCaps !== undefined) {
            try { doc.allCaps = !!p.allCaps; } catch (eCaps) {}
        }
        if (p.justification !== undefined) {
            var jv = resolveJustification(p.justification);
            if (jv !== null) doc.justification = jv;
        }
        td.setValue(doc);
        return {
            ok: true,
            font: doc.font,
            fontSize: doc.fontSize,
            tracking: doc.tracking,
            leading: doc.leading,
            justification: doc.justification,
            fillColor: doc.fillColor,
            resetCharStyle: reset
        };
    }

    // ---------------- TEXT ANIMATOR ----------------
    function textAnimator(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var ly = getLayer(c, p.layer);
        if (!ly && (!p.layer || p.layer === 1)) {
            if (c.selectedLayers && c.selectedLayers.length > 0 && c.selectedLayers[0] instanceof TextLayer) {
                ly = c.selectedLayers[0];
            } else {
                for (var li = 1; li <= c.numLayers; li++) {
                    if (c.layer(li) instanceof TextLayer) { ly = c.layer(li); break; }
                }
            }
        }
        if (!ly && p.text) {
            ly = c.layers.addText(String(p.text));
        }
        if (!ly) return { ok: false, error: 'capa no encontrada' };
        if (!(ly instanceof TextLayer)) return { ok: false, error: 'la capa no es de texto' };

        var selCfg = p.selector || {};
        var isExpSelector = (selCfg.type === 'expression' || selCfg.expression !== undefined);
        var basedOn = null;
        if (selCfg.basedOn !== undefined && selCfg.basedOn !== null && selCfg.basedOn !== '') {
            basedOn = resolveBasedOn(selCfg.basedOn);
            if (basedOn === null) return { ok: false, error: 'selector.basedOn inválido: ' + selCfg.basedOn };
        }
        var shape = null;
        if (selCfg.shape !== undefined && selCfg.shape !== null && selCfg.shape !== '') {
            shape = resolveSelectorShape(selCfg.shape);
            if (shape === null) return { ok: false, error: 'selector.shape inválido: ' + selCfg.shape };
        }
        var smoothness = clampNum(num(selCfg.smoothness, 100), 0, 100);
        if (p.blur !== undefined && p.blur !== null && (typeof p.blur !== 'object' || typeof p.blur.length !== 'number')) return { ok: false, error: 'blur debe ser [x,y]' };
        if (p.positionOffset !== undefined && p.positionOffset !== null && (typeof p.positionOffset !== 'object' || typeof p.positionOffset.length !== 'number')) return { ok: false, error: 'positionOffset debe ser [x,y,z]' };

        var textProps = propSafe(ly, 'ADBE Text Properties');
        var animators = textProps ? propSafe(textProps, 'ADBE Text Animators') : null;
        if (!animators) return { ok: false, error: 'la capa no expone animadores de texto' };

        var animatorName = (p.name !== undefined && p.name !== null && p.name !== '') ? String(p.name) : 'MotionVault_Animator';
        var anim = null;
        try { anim = animators.addProperty('ADBE Text Animator'); } catch (e) { anim = null; }
        if (!anim) return { ok: false, error: 'no se pudo crear el animador de texto' };
        try { anim.name = animatorName; } catch (eName) {}

        var animProps = propSafe(anim, 'ADBE Text Animator Properties');
        if (!animProps && anim.numProperties > 0) animProps = anim.property(1);
        if (!animProps) return { ok: false, error: 'el animador no expone propiedades' };
        var added = [];
        var bp = null;
        var pp = null;
        var op = null;
        if (p.blur !== undefined && p.blur !== null) {
            try { bp = animProps.addProperty('ADBE Text Blur'); } catch (e) { bp = null; }
            if (!bp) return { ok: false, error: 'no se pudo añadir ADBE Text Blur' };
            bp.setValue([num(p.blur[0], 0), num(p.blur[1], 0)]);
            added.push('blur');
        }
        if (p.positionOffset !== undefined && p.positionOffset !== null) {
            try { pp = animProps.addProperty('ADBE Text Position 3D'); } catch (e) { pp = null; }
            if (!pp) pp = animProps.addProperty('ADBE Text Position');
            if (!pp) return { ok: false, error: 'no se pudo añadir ADBE Text Position 3D' };
            pp.setValue([num(p.positionOffset[0], 0), num(p.positionOffset[1], 0), num(p.positionOffset[2], 0)]);
            added.push('position');
        }
        if (p.opacity !== undefined && p.opacity !== null) {
            try { op = animProps.addProperty('ADBE Text Opacity'); } catch (e) { op = null; }
            if (!op) return { ok: false, error: 'no se pudo añadir ADBE Text Opacity' };
            op.setValue(clampNum(num(p.opacity, 0), 0, 100));
            added.push('opacity');
        }

        var selectors = propSafe(anim, 'ADBE Text Selectors');
        if (!selectors) return { ok: false, error: 'el animador no expone selectores' };

        var sel = null;
        if (isExpSelector) {
            try {
                if (selectors.numProperties > 0) selectors.property(1).remove();
            } catch (eRem) {}
            try { sel = selectors.addProperty('ADBE Text Expressible Selector'); } catch (eExp) { sel = null; }
            if (!sel) return { ok: false, error: 'no se pudo crear ADBE Text Expressible Selector' };
            var amt = txProp(sel, ['ADBE Text Expressible Amt', 'ADBE Text Expressible Amount', 'Amount', 'Cantidad', 'ADBE Text Expressible-0001']);
            if (!amt && sel.numProperties > 0) amt = sel.property(sel.numProperties);
            if (amt && selCfg.expression) {
                try { amt.expression = selCfg.expression; } catch (eAmt) {}
            }
            if (basedOn !== null) {
                var expBasedOn = txProp(sel, ['ADBE Text Expressible Selector Based On', 'Based On', 'Basado en', 'ADBE Text Index Type']);
                if (expBasedOn) try { expBasedOn.setValue(basedOn); } catch (eEbo) {}
            }
            return {
                ok: true, layer: ly.name, animator: anim.name,
                properties: added, selector: { type: 'expression', expression: selCfg.expression, basedOn: basedOn }
            };
        }

        if (selectors.numProperties > 0) sel = selectors.property(1);
        else {
            try { sel = selectors.addProperty('ADBE Text Selector'); } catch (e) { sel = null; }
        }
        if (!sel) return { ok: false, error: 'no se pudo crear el Range Selector' };

        var adv = propSafe(sel, 'ADBE Text Range Advanced') || (sel.numProperties >= 4 ? sel.property(4) : null);
        if (adv) {
            if (basedOn !== null) {
                var pBo = txProp(adv, ['ADBE Text Range Type2', 'Based On', 'Basado en']) || (adv.numProperties >= 2 ? adv.property(2) : null);
                if (pBo) try { pBo.setValue(basedOn); } catch (eBo) {}
            }
            if (shape !== null) {
                var pSh = txProp(adv, ['ADBE Text Range Shape', 'Shape', 'Forma']) || (adv.numProperties >= 5 ? adv.property(5) : null);
                if (pSh) try { pSh.setValue(shape); } catch (eSh) {}
            }
            var pSm = txProp(adv, ['ADBE Text Range Smoothness', 'Smoothness', 'Suavidad']) || (adv.numProperties >= 6 ? adv.property(6) : null);
            if (pSm) try { pSm.setValue(smoothness); } catch (eSm) {}
        }
        try { sel.basedOn = basedOn; } catch (e) {}
        try { sel.shape = shape; } catch (e) {}
        try { sel.smoothness = smoothness; } catch (e2) {}

        var offInfo = null;
        var offCfg = selCfg.offset;
        if (offCfg) {
            var off = txProp(sel, ['ADBE Text Percent Offset', 'ADBE Text Index Offset', 'Offset', 'ADBE Text Selector Offset', 'ADBE Text Offset']);
            if (!off) {
                for (var i = 1; i <= sel.numProperties; i++) {
                    var child = sel.property(i);
                    var childName = String(child.name).toLowerCase();
                    var childMatch = String(child.matchName || '').toLowerCase();
                    if (childName.indexOf('offset') >= 0 || childMatch.indexOf('offset') >= 0) { off = child; break; }
                }
            }
            if (!off) return { ok: false, error: 'el selector no expone la propiedad Offset' };
            var fps = (c.frameRate > 0) ? c.frameRate : 30;
            var sf = num(offCfg.startFrame, 0);
            var ef = num(offCfg.endFrame, sf + 15);
            if (ef <= sf) return { ok: false, error: 'offset.endFrame debe ser mayor que startFrame' };
            var sv = num(offCfg.startVal, -100);
            var ev = num(offCfg.endVal, 100);
            var ts = sf / fps;
            var te = ef / fps;
            off.setValueAtTime(ts, sv);
            off.setValueAtTime(te, ev);
            var easeCfg = offCfg.easeIn;
            var easeInf = 80;
            if (easeCfg === false) easeInf = 0;
            else if (typeof easeCfg === 'number') easeInf = clampNum(easeCfg, 0, 100);
            else if (typeof easeCfg === 'string' && !isNaN(parseFloat(easeCfg))) easeInf = clampNum(parseFloat(easeCfg), 0, 100);
            if (easeInf > 0) {
                setInterp(off, KeyframeInterpolationType.BEZIER);
                applyEase(off, 1, 0, easeInf);
                applyEase(off, 2, 0, 0);
            } else {
                setInterp(off, KeyframeInterpolationType.LINEAR);
            }
            offInfo = {
                startFrame: sf, endFrame: ef, startVal: sv, endVal: ev,
                startTime: ts, endTime: te, easeIn: easeInf, keys: off.numKeys
            };
        }

        var selectorState = null;
        try {
            selectorState = { basedOn: sel.basedOn, shape: sel.shape, smoothness: sel.smoothness };
        } catch (e3) {
            selectorState = { basedOn: basedOn, shape: shape, smoothness: smoothness };
        }
        return {
            ok: true, layer: ly.name, animator: anim.name,
            properties: added, selector: selectorState, offset: offInfo
        };
    }

    // ---------------- CAMERA / LIGHT ----------------
    // Cámara 3D: reutiliza una cámara existente; si no hay, crea
    // Camera_MotionVault. Los tipos de movimiento son zoom-in, pan-drift
    // y pull-back. Sin 'type', conserva la gestión clásica de opciones.
    function findExistingCamera(c) {
        var fallback = null;
        for (var i = 1; i <= c.numLayers; i++) {
            var ly = c.layer(i);
            if (ly instanceof CameraLayer) {
                if (String(ly.name) === 'Camera_MotionVault') return ly;
                if (!fallback) fallback = ly;
            }
        }
        return fallback;
    }

    function cameraProps(cam) {
        var group = transformOf(cam);
        var pos = group ? propSafe(group, 'ADBE Position') : null;
        if (!pos) pos = propSafe(cam, 'Position');
        var poi = group ? propSafe(group, 'ADBE Anchor Point') : null;
        if (!poi) poi = propSafe(cam, 'Point of Interest');
        return { position: pos, poi: poi };
    }

    function cameraMove(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var type = String(p.type);
        var cam = null;
        var created = false;
        if (p.layer !== undefined && p.layer !== null && p.layer !== '') {
            cam = getLayer(c, p.layer);
            if (!cam) return { ok: false, error: 'capa no encontrada' };
            if (!(cam instanceof CameraLayer)) return { ok: false, error: 'la capa no es cámara' };
        } else {
            cam = findExistingCamera(c);
            if (!cam) {
                cam = c.layers.addCamera('Camera_MotionVault', [c.width / 2, c.height / 2]);
                created = true;
            }
        }
        var props = cameraProps(cam);
        var pos = props.position;
        var poi = props.poi;
        if (!pos || !poi) return { ok: false, error: 'la cámara no expone Position/Point of Interest' };
        var p0 = pos.value;
        var poi0 = poi.value;
        if (!p0 || p0.length < 3 || !poi0 || poi0.length < 3) {
            return { ok: false, error: 'la cámara no expone transformadas 3D' };
        }
        var fps = (c.frameRate > 0) ? c.frameRate : 30;
        var t0 = (p.time !== undefined && p.time !== null) ? num(p.time, c.time) : c.time;
        if (t0 < 0) t0 = 0;

        if (type === 'zoom-in') {
            var tp = p.targetPosition;
            var fx = (tp && tp.length) ? num(tp[0], c.width / 2) : num(p.focusX, c.width / 2);
            var fy = (tp && tp.length) ? num(tp[1], c.height / 2) : num(p.focusY, c.height / 2);
            var frames = (p.durationFrames !== undefined && p.durationFrames !== null) ? Math.round(num(p.durationFrames, 15)) : (p.duration !== undefined ? Math.round(num(p.duration, 0.5) * fps) : 15);
            if (frames < 1) frames = 1;
            var dt = frames / fps;
            var zoom = num(p.scaleTarget, num(p.zoomPercent, 125));
            if (zoom <= 0) zoom = 100;
            var zEnd = p0[2] * (100 / zoom);
            pos.setValueAtTime(t0, p0);
            pos.setValueAtTime(t0 + dt, [fx, fy, zEnd]);
            poi.setValueAtTime(t0, poi0);
            poi.setValueAtTime(t0 + dt, [fx, fy, poi0[2]]);
            var isContinuous = (p.easing === 'continuous' || p.easing === 'linear');
            if (isContinuous) {
                setInterp(pos, KeyframeInterpolationType.LINEAR);
                setInterp(poi, KeyframeInterpolationType.LINEAR);
            } else {
                var inf = clampNum(num(p.easing, num(p.easeIn, 85)), 0, 100);
                setInterp(pos, KeyframeInterpolationType.BEZIER);
                setInterp(poi, KeyframeInterpolationType.BEZIER);
                if (inf > 0) {
                    applyEase(pos, 1, 0, inf);
                    applyEase(pos, 2, Math.round(inf * 0.35), 0);
                    applyEase(poi, 1, 0, inf);
                    applyEase(poi, 2, Math.round(inf * 0.35), 0);
                }
            }
            return {
                ok: true, type: type, layer: cam.name, cameraCreated: created,
                startTime: t0, durationFrames: frames, endTime: t0 + dt,
                targetPosition: [fx, fy], zoomPercent: zoom,
                position: [fx, fy, zEnd], pointOfInterest: [fx, fy, poi0[2]],
                keys: pos.numKeys, easing: isContinuous ? 'linear' : inf
            };
        }

        if (type === 'pan-drift') {
            var distance = num(p.distance, c.width * 0.25);
            var direction = p.direction ? String(p.direction).toLowerCase() : 'right';
            var sign = (direction === 'left') ? -1 : 1;
            var seconds = num(p.duration, 2);
            var panFrames = (p.durationFrames !== undefined && p.durationFrames !== null) ? Math.round(num(p.durationFrames, 30)) : Math.round(seconds * fps);
            if (panFrames < 1) panFrames = 1;
            var panDt = panFrames / fps;
            var offset = sign * distance;
            pos.setValueAtTime(t0, p0);
            pos.setValueAtTime(t0 + panDt, [p0[0] + offset, p0[1], p0[2]]);
            poi.setValueAtTime(t0, poi0);
            poi.setValueAtTime(t0 + panDt, [poi0[0] + offset, poi0[1], poi0[2]]);
            setInterp(pos, KeyframeInterpolationType.LINEAR);
            setInterp(poi, KeyframeInterpolationType.LINEAR);
            return {
                ok: true, type: type, layer: cam.name, cameraCreated: created,
                startTime: t0, durationSeconds: panDt, endTime: t0 + panDt,
                direction: direction, distance: distance, offsetX: offset,
                keys: pos.numKeys
            };
        }

        // pull-back: startScale/endScale aceptan 150/100 (%) o 1.5/1.0 (factor).
        var s0 = num(p.startScale, 150);
        var s1 = num(p.endScale, 100);
        if (s0 > 10) s0 = s0 / 100;
        if (s1 > 10) s1 = s1 / 100;
        if (s0 <= 0) s0 = 1;
        if (s1 <= 0) s1 = 1;
        if (Math.abs(s0 - s1) < 0.000001) {
            return { ok: false, error: 'startScale y endScale deben ser distintos' };
        }
        var pbFrames = Math.round(num(p.durationFrames, 45));
        if (pbFrames < 1) pbFrames = 1;
        var pbDt = pbFrames / fps;
        var zStart = p0[2] * (s1 / s0);
        pos.setValueAtTime(t0, [p0[0], p0[1], zStart]);
        pos.setValueAtTime(t0 + pbDt, [p0[0], p0[1], p0[2]]);
        var outInf = clampNum(num(p.easeOut, num(p.easing, 80)), 0, 100);
        setInterp(pos, KeyframeInterpolationType.BEZIER);
        if (outInf > 0) {
            applyEase(pos, 1, 0, 20);
            applyEase(pos, 2, outInf, 0);
        }
        return {
            ok: true, type: type, layer: cam.name, cameraCreated: created,
            startTime: t0, durationFrames: pbFrames, endTime: t0 + pbDt,
            startScale: s0, endScale: s1,
            zStart: zStart, zEnd: p0[2], keys: pos.numKeys, easeOut: outInf
        };
    }

    function camera(p) {
        var type = p.type ? String(p.type) : '';
        if (type === 'zoom-in' || type === 'pan-drift' || type === 'pull-back') {
            return cameraMove(p);
        }
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var ly = getLayer(c, p.layer);
        if (!ly) return { ok: false, error: 'capa no encontrada' };
        var opts = ly.property('ADBE Camera Options Group');
        if (!opts) return { ok: false, error: 'la capa no es cámara' };
        if (p.zoom !== undefined) { try { opts.property('ADBE Camera Zoom').setValue(p.zoom); } catch (e) {} }
        if (p.focusDistance !== undefined) { try { opts.property('ADBE Camera Focus Distance').setValue(p.focusDistance); } catch (e) {} }
        if (p.aperture !== undefined) { try { opts.property('ADBE Camera Aperture').setValue(p.aperture); } catch (e) {} }
        if (p.dof !== undefined) { try { opts.property('ADBE Camera Depth of Field').setValue(!!p.dof); } catch (e) {} }
        var zoom = null;
        try { zoom = opts.property('ADBE Camera Zoom').value; } catch (e) {}
        return { ok: true, layer: ly.name, zoom: zoom };
    }

    function light(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var ly = getLayer(c, p.layer);
        if (!ly) return { ok: false, error: 'capa no encontrada' };
        var opts = ly.property('ADBE Light Options Group');
        if (!opts) return { ok: false, error: 'la capa no es luz' };
        if (p.intensity !== undefined) { try { opts.property('ADBE Light Intensity').setValue(p.intensity); } catch (e) {} }
        if (p.color !== undefined) { try { opts.property('ADBE Light Color').setValue(p.color); } catch (e) {} }
        if (p.radius !== undefined) { try { opts.property('ADBE Light Radius').setValue(p.radius); } catch (e) {} }
        var intensity = null;
        try { intensity = opts.property('ADBE Light Intensity').value; } catch (e) {}
        return { ok: true, layer: ly.name, intensity: intensity };
    }

    // ---------------- LOWER THIRD / OVERLAY ----------------
    function lowerThird(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var accentHex = (p.accentColor !== undefined && p.accentColor !== null && p.accentColor !== '') ? p.accentColor : '#8b5cf6';
        var textHex = (p.textColor !== undefined && p.textColor !== null && p.textColor !== '') ? p.textColor : '#FFFFFF';
        var accent = hexToRgb(accentHex);
        if (!accent) return { ok: false, error: 'accentColor inválido: ' + accentHex };
        var textCol = hexToRgb(textHex);
        if (!textCol) return { ok: false, error: 'textColor inválido: ' + textHex };

        var fps = (c.frameRate > 0) ? c.frameRate : 30;
        var t0 = (p.time !== undefined && p.time !== null) ? num(p.time, c.time) : c.time;
        if (t0 < 0) t0 = 0;
        var frames = Math.round(num(p.durationFrames, 30));
        if (frames < 1) frames = 1;
        var dt = frames / fps;
        var barH = 90;
        var maxW = Math.round(c.width * 0.6);
        var barW = Math.round(clampNum(num(p.barWidth, 420), 1, maxW));
        var marginX = Math.round(c.width * 0.08);
        var barY = Math.round(c.height - 250);
        var nameSize = Math.round(clampNum(c.height * 0.039, 20, 64));
        var roleSize = Math.round(clampNum(nameSize * 0.48, 14, 30));
        var nameX = marginX + barW + 26;
        var nameY = barY - 6;
        var roleY = barY + 38;

        // 1) Pleca de acento: escala en X 0 -> 100 desde el borde izquierdo.
        var bar = c.layers.addSolid(accent, 'Accent_Bar', barW, barH, 1);
        var barGroup = transformOf(bar);
        var barAnchor = propSafe(barGroup, 'ADBE Anchor Point');
        if (!barAnchor) return { ok: false, error: 'la pleca no expone Anchor Point' };
        barAnchor.setValue([0, barH / 2]);
        var barPos = propSafe(barGroup, 'ADBE Position');
        var barScale = propSafe(barGroup, 'ADBE Scale');
        if (!barPos || !barScale) return { ok: false, error: 'la pleca no expone Position/Scale' };
        barPos.setValue([marginX, barY]);
        barScale.setValueAtTime(t0, [0, 100]);
        barScale.setValueAtTime(t0 + dt, [100, 100]);
        setInterp(barScale, KeyframeInterpolationType.BEZIER);
        applyEase(barScale, 1, 0, 20);
        applyEase(barScale, 2, 85, 0);

        // 2) Nombre y cargo: LEFT_JUSTIFY y Baseline Lock (Y fija).
        var nameText = (p.name !== undefined && p.name !== null) ? String(p.name) : 'Nombre Apellido';
        var roleText = (p.role !== undefined && p.role !== null) ? String(p.role) : 'Cargo / Rol';
        var nameLayer = c.layers.addText(nameText);
        nameLayer.name = 'LowerThird_Name';
        var roleLayer = c.layers.addText(roleText);
        roleLayer.name = 'LowerThird_Role';
        function setupText(ly, txt, size, x, y) {
            var td = propSafe(propSafe(ly, 'ADBE Text Properties'), 'ADBE Text Document');
            if (!td) return false;
            var doc = td.value;
            doc.text = txt;
            doc.fontSize = size;
            doc.fillColor = textCol;
            doc.justification = ParagraphJustification.LEFT_JUSTIFY;
            td.setValue(doc);
            var tpos = propSafe(transformOf(ly), 'ADBE Position');
            var top = propSafe(transformOf(ly), 'ADBE Opacity');
            if (!tpos || !top) return false;
            tpos.setValue([x, y]);
            tpos.setValueAtTime(t0, [x - 26, y]);
            tpos.setValueAtTime(t0 + dt, [x, y]);
            top.setValueAtTime(t0, 0);
            top.setValueAtTime(t0 + dt, 100);
            setInterp(tpos, KeyframeInterpolationType.BEZIER);
            setInterp(top, KeyframeInterpolationType.BEZIER);
            applyEase(tpos, 1, 0, 20);
            applyEase(tpos, 2, 85, 0);
            applyEase(top, 1, 0, 20);
            applyEase(top, 2, 85, 0);
            return true;
        }
        if (!setupText(nameLayer, nameText, nameSize, nameX, nameY)) {
            return { ok: false, error: 'no se pudo configurar la capa de nombre' };
        }
        if (!setupText(roleLayer, roleText, roleSize, nameX, roleY)) {
            return { ok: false, error: 'no se pudo configurar la capa de cargo' };
        }

        return {
            ok: true, layers: { bar: bar.name, name: nameLayer.name, role: roleLayer.name },
            accentColor: accent, textColor: textCol, barWidth: barW, barHeight: barH,
            baselineY: nameY, roleBaselineY: roleY, baselineLock: true,
            startTime: t0, durationFrames: frames, endTime: t0 + dt
        };
    }

    function overlay(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var type = p.type ? String(p.type) : 'film-grain';
        if (type === 'grid') {
            var gridMode = blendModeFrom(p.blendMode);
            if (gridMode === null) gridMode = (typeof BlendingMode !== 'undefined' && BlendingMode.SCREEN) ? BlendingMode.SCREEN : 5;
            var gridOpacity = clampNum(num(p.opacity, 22), 0, 100);
            var spacing = num(p.spacing, 60);
            var width = num(p.width, 1);
            var colHex = (p.color !== undefined && p.color !== null && p.color !== '') ? p.color : '#0ea5e9';
            var colRgb = hexToRgb(colHex);
            if (!colRgb) colRgb = [0.05, 0.65, 0.95];
            var gridPlate = c.layers.addSolid([0, 0, 0], 'HUD_Cyber_Grid', c.width, c.height, c.pixelAspect || 1, c.duration);
            gridPlate.blendingMode = gridMode;
            var opPr = propSafe(transformOf(gridPlate), 'ADBE Opacity');
            if (opPr) opPr.setValue(gridOpacity);
            var par = propSafe(gridPlate, 'ADBE Effect Parade');
            if (!par) return { ok: false, error: 'la capa no expone Effects' };
            var gridFx = par.addProperty('ADBE Grid');
            if (!gridFx) return { ok: false, error: 'no se pudo aplicar ADBE Grid' };
            try {
                var sizeFrom = txProp(gridFx, ['Size From', 'ADBE Grid-0001']);
                if (sizeFrom) sizeFrom.setValue(3);
                var wh = txProp(gridFx, ['Width & Height', 'ADBE Grid-0003']);
                if (wh) wh.setValue([spacing, spacing]);
                var border = txProp(gridFx, ['Border', 'ADBE Grid-0004']);
                if (border) border.setValue(width);
                var colorProp = txProp(gridFx, ['Color', 'ADBE Grid-0005']);
                if (colorProp) colorProp.setValue(colRgb);
            } catch (eGrid) {}
            return {
                ok: true, layer: gridPlate.name, type: type, blendMode: gridMode,
                opacity: gridOpacity, spacing: spacing, width: width, color: colRgb
            };
        }
        if (type !== 'film-grain') return { ok: false, error: 'type inválido (film-grain|grid): ' + type };
        var mode = blendModeFrom(p.blendMode);
        if (mode === null) return { ok: false, error: 'blendMode inválido: ' + p.blendMode };
        var opacity = clampNum(num(p.opacity, 50), 0, 100);
        var intensity = clampNum(num(p.intensity, 18), 0, 100);
        var fps = num(p.fps, 24);
        if (fps <= 0) fps = 24;

        var plate = c.layers.addSolid([0.5, 0.5, 0.5], 'Film_Grain_Plate', c.width, c.height, c.pixelAspect || 1, c.duration);
        plate.blendingMode = mode;
        var opacityProp = propSafe(transformOf(plate), 'ADBE Opacity');
        if (!opacityProp) return { ok: false, error: 'la capa no expone Opacity' };
        opacityProp.setValue(opacity);

        var parade = propSafe(plate, 'ADBE Effect Parade');
        if (!parade) return { ok: false, error: 'la capa no expone Effects' };
        var fx = parade.addProperty('ADBE Noise');
        if (!fx) return { ok: false, error: 'no se pudo aplicar ADBE Noise' };
        var amount = txProp(fx, ['Amount of Noise', 'Amount', 'ADBE Noise-0001']);
        if (amount) {
            try { amount.setValue(intensity); } catch (e) {}
        }
        var colorNoise = txProp(fx, ['Use Color Noise', 'ADBE Noise-0002']);
        if (colorNoise) {
            try { colorNoise.setValue(0); } catch (e) {}
        }

        // ADBE Noise no siempre expone Random Seed; se busca por nombre y
        // por matchName antes de declarar la expresión como no aplicada.
        var seed = txProp(fx, ['Random Seed', 'ADBE Random Seed', 'ADBE Noise-0004']);
        if (!seed) {
            for (var i = 1; i <= fx.numProperties; i++) {
                var pr = fx.property(i);
                var nm = String(pr.name).toLowerCase();
                if (nm.indexOf('seed') >= 0 || nm.indexOf('semilla') >= 0) { seed = pr; break; }
            }
        }
        var expression = 'posterizeTime(' + fps + '); Math.floor(random(0, 1000));';
        var seedApplied = false;
        if (seed) {
            try {
                seed.expression = expression;
                seedApplied = true;
            } catch (e2) {}
        }
        var res = {
            ok: true, layer: plate.name, type: type, blendMode: mode, opacity: opacity,
            intensity: intensity, fps: fps, randomSeed: expression, expressionApplied: seedApplied
        };
        if (!seedApplied) res.warning = 'ADBE Noise no expone Random Seed en esta versión; expresión no aplicada';
        return res;
    }

    // ---------------- EFFECTS ----------------
    function effect(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var ly = getLayer(c, p.layer);
        if (!ly) return { ok: false, error: 'capa no encontrada' };
        var e = findEffect(p.effect);
        if (!e) return { ok: false, error: 'efecto no encontrado: ' + p.effect };
        var fx = ly.property('ADBE Effect Parade').addProperty(e.matchName);
        var params = [];
        for (var i = 1; i <= fx.numProperties; i++) {
            var pr = fx.property(i);
            var v = null;
            try { v = pr.value; } catch (x) {}
            params.push({ name: pr.name, value: v });
        }
        return { ok: true, applied: e.displayName, matchName: e.matchName, params: params };
    }

    function findFxOnLayer(ly, q) {
        var parade = ly.property('ADBE Effect Parade');
        for (var i = 1; i <= parade.numProperties; i++) {
            var pr = parade.property(i);
            if (String(pr.name).toLowerCase().indexOf(String(q).toLowerCase()) >= 0) return pr;
        }
        return null;
    }

    function effectParam(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var ly = getLayer(c, p.layer);
        if (!ly) return { ok: false, error: 'capa no encontrada' };
        var fx = findFxOnLayer(ly, p.effect);
        if (!fx) return { ok: false, error: 'efecto no aplicado: ' + p.effect };
        var target = null;
        for (var k = 1; k <= fx.numProperties; k++) {
            var q = fx.property(k);
            if (String(q.name).toLowerCase().indexOf(String(p.param).toLowerCase()) >= 0) { target = q; break; }
        }
        if (!target) return { ok: false, error: 'parámetro no encontrado: ' + p.param };
        target.setValue(p.value);
        return { ok: true, effect: fx.name, param: target.name, value: target.value };
    }

    function effectKey(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var ly = getLayer(c, p.layer);
        if (!ly) return { ok: false, error: 'capa no encontrada' };
        var fx = findFxOnLayer(ly, p.effect);
        if (!fx) return { ok: false, error: 'efecto no aplicado: ' + p.effect };
        var target = null;
        for (var k = 1; k <= fx.numProperties; k++) {
            var q = fx.property(k);
            if (String(q.name).toLowerCase().indexOf(String(p.param).toLowerCase()) >= 0) { target = q; break; }
        }
        if (!target) return { ok: false, error: 'parámetro no encontrado: ' + p.param };
        target.setValueAtTime(p.time, p.value);
        return { ok: true, effect: fx.name, param: target.name, time: p.time, keys: target.numKeys };
    }

    // ---------------- TRANSFORM / KEYS / EXPRESSION ----------------
    function transform(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var ly = getLayer(c, p.layer);
        if (!ly) return { ok: false, error: 'capa no encontrada' };
        var prop = transformProp(ly, p.prop) || ly.property(p.prop);
        if (!prop) return { ok: false, error: 'prop inválida: ' + p.prop };
        if (p.time !== undefined) prop.setValueAtTime(p.time, p.value);
        else prop.setValue(p.value);
        return { ok: true, prop: p.prop, value: (function () { try { return prop.value; } catch (e) { return null; } })() };
    }

    function keyframe(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var ly = getLayer(c, p.layer);
        if (!ly) return { ok: false, error: 'capa no encontrada' };
        var prop = transformProp(ly, p.prop) || ly.property(p.prop);
        if (!prop) return { ok: false, error: 'prop inválida: ' + p.prop };
        prop.setValueAtTime(p.time, p.value);
        return { ok: true, prop: p.prop, time: p.time, keys: prop.numKeys };
    }

    function expression(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var ly = getLayer(c, p.layer);
        if (!ly) return { ok: false, error: 'capa no encontrada' };
        var prop = transformProp(ly, p.prop) || ly.property(p.prop);
        if (!prop) return { ok: false, error: 'prop inválida: ' + p.prop };
        prop.expression = p.expression;
        return { ok: true, prop: p.prop, expression: prop.expression };
    }

    // ---------------- MASKS / ROTO ----------------
    function mask(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var ly = getLayer(c, p.layer);
        if (!ly) return { ok: false, error: 'capa no encontrada' };
        var parade = ly.property('ADBE Mask Parade');
        if (!parade) return { ok: false, error: 'la capa no admite máscaras' };
        var m = parade.addProperty('ADBE Mask Atom');
        if (!m) return { ok: false, error: 'no se pudo crear la máscara' };
        if (p.mode) {
            try {
                if (p.mode === 'subtract') m.maskMode = MaskMode.SUBTRACT;
                else if (p.mode === 'intersect') m.maskMode = MaskMode.INTERSECT;
                else if (p.mode === 'none') m.maskMode = MaskMode.NONE;
                else m.maskMode = MaskMode.ADD;
            } catch (e) {}
        }
        if (p.inverted !== undefined) { try { m.inverted = !!p.inverted; } catch (e) {} }
        if (p.feather !== undefined) { try { m.property('ADBE Mask Feather').setValue(p.feather); } catch (e) {} }
        if (p.opacity !== undefined) { try { m.property('ADBE Mask Opacity').setValue(p.opacity); } catch (e) {} }
        if (p.expansion !== undefined) { try { m.property('ADBE Mask Expansion').setValue(p.expansion); } catch (e) {} }
        if (p.vertices) {
            var sh = new Shape();
            sh.vertices = p.vertices;
            if (p.inTangents) sh.inTangents = p.inTangents;
            if (p.outTangents) sh.outTangents = p.outTangents;
            sh.closed = (p.closed === undefined) ? true : !!p.closed;
            m.property('ADBE Mask Shape').setValue(sh);
        }
        return { ok: true, mask: m.name, mode: m.maskMode, hasPath: !!p.vertices };
    }

    function roto(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var ly = getLayer(c, p.layer);
        if (!ly) return { ok: false, error: 'capa no encontrada' };
        var fx = ly.property('ADBE Effect Parade').addProperty('ADBE Samurai');
        if (!fx) return { ok: false, error: 'no se pudo aplicar Roto Brush' };
        return { ok: true, layer: ly.name, effect: fx.name, matchName: 'ADBE Samurai', note: 'Roto Brush aplicado; pinceladas interactivas. Usa mask() para roto por máscara.' };
    }

    // ---------------- TRACKER ----------------
    function tracker(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var ly = getLayer(c, p.layer);
        if (!ly) return { ok: false, error: 'capa no encontrada' };
        var map = {
            camera3d: 'ADBE 3D Tracker',
            warp: 'ADBE SubspaceStabilizer',
            mocha: 'mochaAECC',
            face: 'Pseudo/ADBE Animal Head66'
        };
        var match = p.matchName || map[p.type];
        if (!match) return { ok: false, error: 'tracker inválido (camera3d|warp|mocha|face)' };
        var fx = ly.property('ADBE Effect Parade').addProperty(match);
        if (!fx) return { ok: false, error: 'no se pudo aplicar el tracker' };
        return {
            ok: true, layer: ly.name, effect: fx.name, matchName: match,
            note: 'El efecto de tracking quedó aplicado; el solve/track es interactivo (no por API).'
        };
    }

    // ---------------- MARKERS ----------------
    function marker(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var prop = null;
        if (p.layer) {
            var ly = getLayer(c, p.layer);
            if (!ly) return { ok: false, error: 'capa no encontrada' };
            prop = ly.property('ADBE Marker');
        } else {
            prop = c.markerProperty;
        }
        if (!prop) return { ok: false, error: 'sin propiedad de marcadores' };
        prop.setValueAtTime(p.time, new MarkerValue(p.name || 'Marker'));
        return { ok: true, count: prop.numKeys, time: p.time, name: p.name || 'Marker' };
    }

    // ---------------- IMPORT / ITEMS ----------------
    function importFile(p) {
        var f = new File(p.path);
        if (!f.exists) return { ok: false, error: 'no existe: ' + p.path };
        var io = new ImportOptions(f);
        var item = app.project.importFile(io);
        return { ok: true, name: item.name, id: item.id, type: item.typeName };
    }

    function folder(p) {
        var f = app.project.items.addFolder(p.name || 'Folder');
        return { ok: true, folder: f.name, id: f.id };
    }

    function items(p) {
        var list = [];
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            list.push({ id: it.id, name: it.name, type: it.typeName });
        }
        return { ok: true, count: list.length, items: list };
    }

    // ---------------- RENDER ----------------
    function queueComp(c) {
        var rq = app.project.renderQueue;
        for (var i = 1; i <= rq.numItems; i++) {
            var it = rq.item(i);
            if (it.comp === c) return it;
        }
        return rq.items.add(c);
    }

    function render(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var item = queueComp(c);
        item.render = false;
        return { ok: true, comp: c.name, queued: true, renderTime: c.duration };
    }

    function renderOutput(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var item = queueComp(c);
        var om = item.outputModule(1);
        if (p.path) om.file = new File(p.path);
        if (p.template) { try { om.applyTemplate(p.template); } catch (e) {} }
        if (p.render) {
            item.render = true;
            // queueInAME() encola en Media Encoder (no bloquea el hilo de AE);
            // renderQueue.render() es síncrono y puede exceder el timeout del puente.
            try {
                if (app.project.renderQueue.queueInAME) app.project.renderQueue.queueInAME(true);
                else app.project.renderQueue.render();
            } catch (e) {
                return { ok: false, comp: c.name, error: 'fallo al lanzar render: ' + e.toString() };
            }
        }
        return { ok: true, comp: c.name, queued: true, output: p.path || null, rendered: !!p.render };
    }

    // ---------------- SCRIPTS ----------------
    function scriptFolderPath(p) {
        if (p && p.path) return p.path;
        return 'C:/Program Files/Adobe/Adobe After Effects 2026/Support Files/Scripts/ScriptUI Panels';
    }

    function scripts(p) {
        var folder = new Folder(scriptFolderPath(p));
        if (!folder.exists) return { ok: false, error: 'carpeta no encontrada: ' + folder.fsName };
        var files = folder.getFiles('*.jsx');
        var list = [];
        for (var i = 0; i < files.length; i++) {
            var nm = String(files[i].name);
            try { nm = decodeURIComponent(nm); } catch (e) {}
            list.push({ name: nm, path: files[i].fsName });
        }
        return { ok: true, folder: folder.fsName, count: list.length, items: list };
    }

    function script(p) {
        var path = p.path;
        if (!path && p.name) {
            var folder = new Folder(scriptFolderPath(p));
            var f = new File(folder.fsName + '/' + p.name);
            if (f.exists) path = f.fsName;
        }
        if (!path) return { ok: false, error: 'script no encontrado' };
        var file = new File(path);
        if (!file.exists) return { ok: false, error: 'archivo no existe: ' + path };
        $.evalFile(file);
        return { ok: true, ran: file.name, note: 'Si es panel ScriptUI, se abre su ventana.' };
    }

    function save() {
        app.project.save();
        return { ok: true, saved: app.project.file ? app.project.file.fsName : '(sin ruta)' };
    }

    // ---------------- SET (resolvedor universal) --------------------------
    function splitPropPath(pathText) {
        var raw = String(pathText === undefined || pathText === null ? '' : pathText);
        var parts = [];
        var cur = '';
        for (var i = 0; i < raw.length; i++) {
            var ch = raw.charAt(i);
            if (ch === '/') {
                if (cur !== '') parts.push(cur);
                cur = '';
            } else {
                cur += ch;
            }
        }
        if (cur !== '') parts.push(cur);
        return parts;
    }

    function parsePropSegment(seg) {
        var clean = String(seg).replace(/^\s+|\s+$/g, '');
        var open = clean.indexOf('[');
        if (open < 0) return { name: clean, index: 0 };
        var close = clean.indexOf(']', open);
        if (close < 0) return { name: clean, index: 0 };
        var idx = parseInt(clean.substring(open + 1, close), 10);
        return { name: clean.substring(0, open), index: (isNaN(idx) ? 0 : idx) };
    }

    function childByName(parent, name, occurrence) {
        if (!parent) return null;
        var matches = [];
        var n = 0;
        try { n = parent.numProperties; } catch (e) { n = 0; }
        var i;
        var child = null;
        for (i = 1; i <= n; i++) {
            child = null;
            try { child = parent.property(i); } catch (eC) { child = null; }
            if (!child) continue;
            var nm = '';
            var mn = '';
            try { nm = String(child.name); } catch (eN) { nm = ''; }
            try { mn = String(child.matchName || ''); } catch (eM) { mn = ''; }
            if (nm === name || mn === name) matches.push(child);
        }
        if (matches.length === 0) {
            var low = String(name).toLowerCase();
            for (i = 1; i <= n; i++) {
                var child2 = parent.property(i);
                var nm2 = String(child2.name).toLowerCase();
                var mn2 = String(child2.matchName || '').toLowerCase();
                if (nm2 === low || mn2 === low) matches.push(child2);
            }
        }
        if (matches.length === 0) return null;
        var want = occurrence > 0 ? occurrence : 1;
        if (want > matches.length) return null;
        return matches[want - 1];
    }

    function resolvePropertyPath(ly, pathText) {
        var parts = splitPropPath(pathText);
        if (parts.length === 0) return null;
        var current = ly;
        for (var i = 0; i < parts.length; i++) {
            var seg = parsePropSegment(parts[i]);
            var next = childByName(current, seg.name, seg.index);
            if (!next) {
                try { next = current.property(seg.name); } catch (e) { next = null; }
            }
            if (!next) return null;
            current = next;
        }
        return current;
    }

    function keyIndexAtTime(prop, t) {
        var best = -1;
        var bestDiff = 999999;
        for (var i = 1; i <= prop.numKeys; i++) {
            var d = Math.abs(prop.keyTime(i) - t);
            if (d < bestDiff) { bestDiff = d; best = i; }
        }
        return best;
    }

    // Aplica interpolación/ease a una key ya creada.
    function applyKeyframeOptions(prop, keyIndex, opts, globalEase) {
        if (!prop || keyIndex < 1) return;
        var interp = opts.interp;
        if (interp !== undefined && interp !== null && interp !== '') {
            var it = String(interp).toLowerCase();
            var itype = null;
            if (typeof KeyframeInterpolationType !== 'undefined') {
                if (it === 'linear') itype = KeyframeInterpolationType.LINEAR;
                else if (it === 'hold') itype = KeyframeInterpolationType.HOLD;
                else itype = KeyframeInterpolationType.BEZIER;
            }
            if (itype !== null) {
                try { prop.setInterpolationTypeAtKey(keyIndex, itype, itype); } catch (eI) {}
            }
        }
        var easeCfg = null;
        if (opts.easeIn !== undefined || opts.easeOut !== undefined) easeCfg = opts;
        else if (globalEase !== undefined && globalEase !== null) easeCfg = globalEase;
        if (easeCfg === null) return;
        var inE = 0;
        var outE = 0;
        if (typeof easeCfg === 'number') {
            inE = easeCfg;
            outE = easeCfg;
        } else {
            inE = num(easeCfg.easeIn !== undefined ? easeCfg.easeIn : easeCfg['in'], 33.33);
            outE = num(easeCfg.easeOut !== undefined ? easeCfg.easeOut : easeCfg['out'], 33.33);
        }
        applyEase(prop, keyIndex, inE, outE);
    }

    function applyKeyframeList(prop, list, globalEase) {
        if (!prop || !list || typeof list.length !== 'number') return { ok: true, count: 0 };
        for (var i = 0; i < list.length; i++) {
            var item = list[i];
            if (!item || typeof item.length !== 'number' || item.length < 2) {
                return { ok: false, error: 'keyframe inválido en índice ' + i };
            }
            var kTime = num(item[0], 0);
            try {
                prop.setValueAtTime(kTime, item[1]);
            } catch (eSet) {
                return { ok: false, error: 'setValueAtTime falló en keyframe ' + i + ': ' + String(eSet) };
            }
            var keyIndex = keyIndexAtTime(prop, kTime);
            var opts = (item.length > 2 && item[2]) ? item[2] : {};
            applyKeyframeOptions(prop, keyIndex, opts, globalEase);
        }
        return { ok: true, count: list.length };
    }

    // AE expone las dimensiones separadas como hijos matchName + "_0/1/2"
    // (Position_X, Scale_Y, ...) tras poner prop.dimensionsSeparated = true.
    function separatedDimension(prop, index) {
        if (!prop) return null;
        var base = '';
        try { base = String(prop.matchName || ''); } catch (e0) { base = ''; }
        var child = null;
        if (base !== '') {
            child = propSafe(prop, base + '_' + index);
            if (child) return child;
        }
        var n = 0;
        try { n = prop.numProperties; } catch (e1) { n = 0; }
        for (var i = 1; i <= n; i++) {
            var candidate = prop.property(i);
            var mn = '';
            try { mn = String(candidate.matchName || ''); } catch (e2) { mn = ''; }
            if (base !== '' && mn === base + '_' + index) return candidate;
        }
        if (index < n) return prop.property(index + 1);
        return null;
    }

    function enableDimensionsSeparated(prop) {
        if (!prop) return { ok: false, error: 'propiedad inexistente' };
        var separated = false;
        try { separated = !!prop.dimensionsSeparated; } catch (e0) { separated = false; }
        if (!separated) {
            try {
                prop.dimensionsSeparated = true;
            } catch (e1) {
                return { ok: false, error: 'la propiedad no admite dimensiones separadas: ' + String(e1) };
            }
            try { separated = !!prop.dimensionsSeparated; } catch (e2) { separated = false; }
        }
        if (!separated) return { ok: false, error: 'AE no separó las dimensiones de esta propiedad' };
        return { ok: true };
    }

    // Resuelve una ruta con "/" (matchName o nombre visible) e índices [i]
    // para hermanos repetidos; aplica valor, keyframes o expresión.
    // Soporta dimensiones separadas de X/Y/Z (xKeyframes, yKeyframes, zKeyframes).
    // Continuidad multi-fase: borra SOLO las keys estrictamente posteriores a
    // afterTime (margen 0.0005). Nunca usa setValue ni toca keys <= afterTime.
    function removeKeysAfter(prop, afterTime) {
        if (!prop) return 0;
        var removed = 0;
        var threshold = afterTime + 0.0005;
        var k;
        var n = 0;
        try { n = prop.numKeys; } catch (eN) { n = 0; }
        for (k = n; k >= 1; k--) {
            var kt = -1;
            try { kt = prop.keyTime(k); } catch (eK) { kt = -1; }
            if (kt > threshold) {
                try { prop.removeKey(k); removed++; } catch (eR) {}
            }
        }
        return removed;
    }

    function applySet(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var ly = getLayer(c, p.layer);
        if (!ly) return { ok: false, error: 'capa no encontrada: ' + p.layer };
        var prop = resolvePropertyPath(ly, p.path);
        if (!prop) return { ok: false, error: 'ruta no resuelta: ' + p.path };
        var notes = [];
        var i;

        if (p.clearKeysBetween !== undefined && p.clearKeysBetween !== null) {
            var range = p.clearKeysBetween;
            var t0 = 0;
            var t1 = c.duration;
            if (range && typeof range.length === 'number' && range.length >= 2) {
                t0 = num(range[0], 0);
                t1 = num(range[1], c.duration);
            } else if (range && typeof range === 'object') {
                t0 = num(range.start, 0);
                t1 = num(range.end, c.duration);
            }
            var removed = 0;
            for (i = prop.numKeys; i >= 1; i--) {
                var kt = -1;
                try { kt = prop.keyTime(i); } catch (eK) { kt = -1; }
                if (kt >= t0 && kt <= t1) {
                    try { prop.removeKey(i); removed++; } catch (eR) {}
                }
            }
            notes.push('keysRemoved=' + removed);
        }

        if (p.expression !== undefined) {
            try {
                prop.expression = String(p.expression);
                notes.push('expression');
            } catch (eX) {
                return { ok: false, error: 'no se pudo aplicar la expresión: ' + String(eX) };
            }
        }

        var wantsSeparate = false;
        if (p.dimensions === 'separate' || p.separateDimensions === true || p.separate === true) wantsSeparate = true;
        if (p.xKeyframes || p.yKeyframes || p.zKeyframes) wantsSeparate = true;
        if (p.xValue !== undefined || p.yValue !== undefined || p.zValue !== undefined) wantsSeparate = true;
        if (p.dimensions === 'combined' || p.separateDimensions === false) {
            wantsSeparate = false;
            try {
                if (prop.dimensionsSeparated) {
                    prop.dimensionsSeparated = false;
                    var joined = resolvePropertyPath(ly, p.path);
                    if (joined) prop = joined;
                    notes.push('dimensionsCombined');
                }
            } catch (eJoin) {
                return { ok: false, error: 'no se pudieron combinar las dimensiones: ' + String(eJoin) };
            }
        }

        if (wantsSeparate) {
            var sepRes = enableDimensionsSeparated(prop);
            if (!sepRes.ok) return { ok: false, error: sepRes.error };
            var reProp = resolvePropertyPath(ly, p.path);
            if (reProp) prop = reProp;

            var axisLists = [p.xKeyframes, p.yKeyframes, p.zKeyframes];
            var axisValues = [p.xValue, p.yValue, p.zValue];
            var dimNotes = [];
            var dimCount = 0;
            var axis;
            for (axis = 0; axis < 3; axis++) {
                if (separatedDimension(prop, axis)) dimCount++;
            }
            if (dimCount === 0) return { ok: false, error: 'AE no expuso dimensiones separadas' };

            // Continuidad: limpiar keys futuras en CADA dimensión antes de
            // añadir las nuevas, conservando las keys <= afterTime.
            if (p.afterTime !== undefined && p.afterTime !== null) {
                var afterT = num(p.afterTime, 0);
                var afterRemoved = 0;
                for (axis = 0; axis < dimCount; axis++) {
                    afterRemoved += removeKeysAfter(separatedDimension(prop, axis), afterT);
                }
                dimNotes.push('keysAfterRemoved=' + afterRemoved);
            }

            for (axis = 0; axis < dimCount; axis++) {
                var dimProp = separatedDimension(prop, axis);
                if (!dimProp) return { ok: false, error: 'no se encontró la dimensión ' + axis };
                if (axisLists[axis] && typeof axisLists[axis].length === 'number') {
                    var kres = applyKeyframeList(dimProp, axisLists[axis], p.ease);
                    if (!kres.ok) return { ok: false, error: 'dimensión ' + axis + ': ' + kres.error };
                    dimNotes.push('keys' + axis + '=' + kres.count);
                }
                if (axisValues[axis] !== undefined) {
                    var vres = setValueChecked(dimProp, axisValues[axis]);
                    if (!vres.ok) return { ok: false, error: 'dimensión ' + axis + ': ' + vres.error };
                    dimNotes.push('value' + axis);
                }
            }

            if (p.value !== undefined) {
                var baseVal = p.value;
                var hasArray = false;
                if (baseVal && typeof baseVal.length === 'number') hasArray = true;
                for (axis = 0; axis < dimCount; axis++) {
                    var valProp = separatedDimension(prop, axis);
                    if (!valProp) continue;
                    var oneVal = baseVal;
                    if (hasArray) oneVal = baseVal[axis];
                    if (oneVal === undefined) continue;
                    var sv = setValueChecked(valProp, oneVal);
                    if (!sv.ok) return { ok: false, error: 'value dimensión ' + axis + ': ' + sv.error };
                }
                dimNotes.push('value');
            }

            if (p.keyframes && typeof p.keyframes.length === 'number') {
                for (i = 0; i < p.keyframes.length; i++) {
                    var kItem = p.keyframes[i];
                    if (!kItem || typeof kItem.length !== 'number' || kItem.length < 2) {
                        return { ok: false, error: 'keyframe inválido en índice ' + i };
                    }
                    var kVal = kItem[1];
                    var kTime2 = num(kItem[0], 0);
                    var kOpts = (kItem.length > 2 && kItem[2]) ? kItem[2] : {};
                    var kIsArray = false;
                    if (kVal && typeof kVal.length === 'number') kIsArray = true;
                    for (axis = 0; axis < dimCount; axis++) {
                        var kProp = separatedDimension(prop, axis);
                        if (!kProp) continue;
                        var kOne = kVal;
                        if (kIsArray) kOne = kVal[axis];
                        if (kOne === undefined) continue;
                        try {
                            kProp.setValueAtTime(kTime2, kOne);
                        } catch (eKV) {
                            return { ok: false, error: 'dimensión ' + axis + ' keyframe ' + i + ': ' + String(eKV) };
                        }
                        applyKeyframeOptions(kProp, keyIndexAtTime(kProp, kTime2), kOpts, p.ease);
                    }
                }
                dimNotes.push('keyframes=' + p.keyframes.length);
            }

            var dimOut = [];
            for (axis = 0; axis < dimCount; axis++) {
                var outProp = separatedDimension(prop, axis);
                dimOut.push({
                    matchName: String(outProp && outProp.matchName ? outProp.matchName : ''),
                    value: outProp ? propValue(outProp, null) : null,
                    keys: outProp ? outProp.numKeys : 0
                });
            }
            return {
                ok: true,
                layer: ly.name,
                path: String(p.path),
                property: String(prop.name),
                matchName: String(prop.matchName || ''),
                dimensionsSeparated: true,
                dimensions: dimOut,
                notes: dimNotes
            };
        }

        // Continuidad en propiedades combinadas: limpiar solo lo posterior a
        // afterTime antes de añadir los nuevos keyframes.
        if (p.afterTime !== undefined && p.afterTime !== null) {
            var afterRemovedCombined = removeKeysAfter(prop, num(p.afterTime, 0));
            notes.push('keysAfterRemoved=' + afterRemovedCombined);
        }

        if (p.keyframes && typeof p.keyframes.length === 'number') {
            var listRes = applyKeyframeList(prop, p.keyframes, p.ease);
            if (!listRes.ok) return { ok: false, error: listRes.error };
            notes.push('keyframes=' + listRes.count);
        }

        if (p.value !== undefined) {
            var setRes = setValueChecked(prop, p.value);
            if (!setRes.ok) return { ok: false, error: 'value: ' + setRes.error, got: setRes.got };
            notes.push('value');
        }

        var currentValue = null;
        try { currentValue = prop.value; } catch (eVal) {}
        return {
            ok: true,
            layer: ly.name,
            path: String(p.path),
            property: String(prop.name),
            matchName: String(prop.matchName || ''),
            value: currentValue,
            keys: prop.numKeys,
            notes: notes
        };
    }

    // Wrapper limpio de continuidad multi-fase: mismo applySet, solo con los
    // campos de keyframes/afterTime (sin valores ni expresiones accidentales).
    function ensureKeysAfter(p) {
        var conf = {
            comp: p.comp,
            layer: p.layer,
            path: p.path,
            afterTime: p.afterTime,
            keyframes: p.keyframes,
            xKeyframes: p.xKeyframes,
            yKeyframes: p.yKeyframes,
            zKeyframes: p.zKeyframes,
            ease: p.ease
        };
        return applySet(conf);
    }

    // ---------------- SHAPE GROUP (vector seguro) -------------------------
    function vectorProp(parent, names) {
        if (!parent) return null;
        var i;
        for (i = 0; i < names.length; i++) {
            var pr = propSafe(parent, names[i]);
            if (pr) return pr;
        }
        var n = 0;
        try { n = parent.numProperties; } catch (e) { n = 0; }
        for (i = 1; i <= n; i++) {
            var child = parent.property(i);
            var nm = String(child.name).toLowerCase();
            var mn = String(child.matchName || '').toLowerCase();
            for (var k = 0; k < names.length; k++) {
                var q = String(names[k]).toLowerCase();
                if (nm === q || mn === q) return child;
            }
        }
        return null;
    }

    function vectorGroupCtx(ly, groupName) {
        var root = propSafe(ly, 'ADBE Root Vectors Group');
        if (!root) return null;
        var group = propSafe(root, groupName);
        if (!group) {
            try { group = root.addProperty('ADBE Vector Group'); } catch (e) { group = null; }
            if (!group) return null;
            try { group.name = groupName; } catch (eN) {}
        }
        // Re-resolver SIEMPRE desde la raíz: addProperty invalida hermanos.
        root = propSafe(ly, 'ADBE Root Vectors Group');
        group = root ? propSafe(root, groupName) : null;
        if (!group) return null;
        var contents = propSafe(group, 'ADBE Vectors Group');
        if (!contents) return null;
        return { root: root, group: group, contents: contents };
    }

    function zeroPoints(n) {
        var out = [];
        for (var i = 0; i < n; i++) out.push([0, 0]);
        return out;
    }

    function addPathPrimitive(contents, cfg) {
        var pr = null;
        try { pr = contents.addProperty('ADBE Vector Shape - Group'); } catch (e) { pr = null; }
        if (!pr) return { error: 'no se pudo crear el path' };
        var shapeProp = vectorProp(pr, ['ADBE Vector Shape']);
        if (!shapeProp) return { error: 'el path no expone ADBE Vector Shape' };
        var sh = new Shape();
        var verts = cfg.vertices || [];
        sh.vertices = verts;
        sh.inTangents = cfg.inTangents || zeroPoints(verts.length);
        sh.outTangents = cfg.outTangents || zeroPoints(verts.length);
        sh.closed = (cfg.closed === undefined) ? true : !!cfg.closed;
        var res = setValueChecked(shapeProp, sh);
        if (!res.ok) return { error: res.error };
        return { name: String(pr.name) };
    }

    function setShapeSize(pr, kind, size, position, roundness) {
        var w = 100;
        var h = 100;
        if (typeof size === 'number') {
            w = size;
            h = size;
        } else if (size && typeof size.length === 'number') {
            w = numAt(size, 0, 100);
            h = numAt(size, 1, w);
        }
        var sizeProp = null;
        if (kind === 'rect') sizeProp = vectorProp(pr, ['ADBE Vector Rect Size']);
        else if (kind === 'ellipse') sizeProp = vectorProp(pr, ['ADBE Vector Ellipse Size']);
        else if (kind === 'polystar') sizeProp = vectorProp(pr, ['ADBE Vector Star Outer Radius']);
        if (sizeProp) setValueChecked(sizeProp, (kind === 'polystar') ? w : [w, h]);
        var posProp = null;
        if (kind === 'rect') posProp = vectorProp(pr, ['ADBE Vector Rect Position']);
        else if (kind === 'ellipse') posProp = vectorProp(pr, ['ADBE Vector Ellipse Position']);
        else if (kind === 'polystar') posProp = vectorProp(pr, ['ADBE Vector Star Position']);
        if (posProp) setValueChecked(posProp, position || [0, 0]);
        if (kind === 'rect' && roundness !== undefined) {
            var rp = vectorProp(pr, ['ADBE Vector Rect Roundness']);
            if (rp) setValueChecked(rp, num(roundness, 0));
        }
        return { width: w, height: h };
    }

    function configurePolystar(pr, cfg) {
        var typeProp = vectorProp(pr, ['ADBE Vector Star Type']);
        if (typeProp && cfg.type !== undefined && cfg.type !== null) {
            var tv = String(cfg.type).toLowerCase();
            var numType = 1;
            if (tv === 'polygon') numType = 2;
            setValueChecked(typeProp, numType);
        }
        var points = vectorProp(pr, ['ADBE Vector Star Points']);
        if (points && cfg.points !== undefined) setValueChecked(points, num(cfg.points, 5));
        var inner = vectorProp(pr, ['ADBE Vector Star Inner Radius']);
        if (inner && cfg.innerRadius !== undefined) setValueChecked(inner, num(cfg.innerRadius, 50));
        var rot = vectorProp(pr, ['ADBE Vector Star Rotation']);
        if (rot && cfg.rotation !== undefined) setValueChecked(rot, num(cfg.rotation, 0));
    }

    function ensureBlurBounds(ly) {
        var root = propSafe(ly, 'ADBE Root Vectors Group');
        if (!root) return false;
        if (propSafe(root, 'Blur Bounds')) return true;
        var group = null;
        try { group = root.addProperty('ADBE Vector Group'); } catch (e) { group = null; }
        if (!group) return false;
        try { group.name = 'Blur Bounds'; } catch (eN) {}
        root = propSafe(ly, 'ADBE Root Vectors Group');
        group = root ? propSafe(root, 'Blur Bounds') : null;
        if (!group) return false;
        var contents = propSafe(group, 'ADBE Vectors Group');
        if (!contents) return false;
        var rect = null;
        try { rect = contents.addProperty('ADBE Vector Shape - Rect'); } catch (eR) { rect = null; }
        if (!rect) return false;
        setValueChecked(vectorProp(rect, ['ADBE Vector Rect Size']), [5000, 5000]);
        setValueChecked(vectorProp(rect, ['ADBE Vector Rect Position']), [0, 0]);
        // Fill transparente: cuenta para los bounds sin pintar nada.
        contents = propSafe(propSafe(ly, 'ADBE Root Vectors Group'), 'Blur Bounds');
        contents = contents ? propSafe(contents, 'ADBE Vectors Group') : null;
        if (!contents) return true;
        var fill = null;
        try { fill = contents.addProperty('ADBE Vector Graphic - Fill'); } catch (eF) { fill = null; }
        if (fill) {
            setValueChecked(vectorProp(fill, ['ADBE Vector Fill Opacity']), 0);
            setValueChecked(vectorProp(fill, ['ADBE Vector Fill Color']), [0, 0, 0]);
        }
        return true;
    }

    function applyShapeGroup(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var ly = getLayer(c, p.layer);
        var created = false;
        if (!ly) {
            ly = c.layers.addShape();
            created = true;
            var layerName = '';
            if (typeof p.layer === 'string' && p.layer !== '') layerName = p.layer;
            else if (p.name !== undefined && p.name !== null && p.name !== '') layerName = String(p.name);
            else layerName = 'AG Shape';
            ly.name = layerName;
            var tg = transformOf(ly);
            var tpos = tg ? propSafe(tg, 'ADBE Position') : null;
            if (tpos) setValueChecked(tpos, p.position || [0, 0]);
        }
        var isShape = false;
        try { isShape = (ly instanceof ShapeLayer); } catch (e0) { isShape = false; }
        if (!isShape) return { ok: false, error: 'la capa no es shape' };

        var groupName = '';
        if (p.group !== undefined && p.group !== null && p.group !== '') groupName = String(p.group);
        else if (p.name !== undefined && p.name !== null && p.name !== '') groupName = String(p.name);
        else groupName = 'AG Group';

        var ctx = vectorGroupCtx(ly, groupName);
        if (!ctx) return { ok: false, error: 'no se pudo crear el grupo vectorial' };
        var added = [];

        if (p.primitive) {
            var prim = p.primitive;
            var rawKind = prim.type;
            if (rawKind === undefined || rawKind === null) rawKind = prim.shape;
            if (rawKind === undefined || rawKind === null) rawKind = 'rect';
            var kind = String(rawKind).toLowerCase();
            var match = null;
            if (kind === 'rect' || kind === 'rectangle') {
                kind = 'rect';
                match = 'ADBE Vector Shape - Rect';
            } else if (kind === 'ellipse' || kind === 'oval') {
                kind = 'ellipse';
                match = 'ADBE Vector Shape - Ellipse';
            } else if (kind === 'polystar' || kind === 'star' || kind === 'polygon') {
                kind = 'polystar';
                match = 'ADBE Vector Shape - Star';
            } else if (kind === 'path' || kind === 'shape') {
                kind = 'path';
                match = null;
            } else {
                return { ok: false, error: 'primitive inválido (rect|ellipse|polystar|path): ' + kind };
            }
            if (kind === 'path') {
                ctx = vectorGroupCtx(ly, groupName);
                if (!ctx) return { ok: false, error: 'grupo perdido antes del path' };
                var pathRes = addPathPrimitive(ctx.contents, prim);
                if (pathRes.error) return { ok: false, error: 'path: ' + pathRes.error };
                added.push('path');
            } else {
                ctx = vectorGroupCtx(ly, groupName);
                if (!ctx) return { ok: false, error: 'grupo perdido antes de la primitiva' };
                var pr = null;
                try { pr = ctx.contents.addProperty(match); } catch (eP) { pr = null; }
                if (!pr) return { ok: false, error: 'no se pudo crear la primitiva ' + kind };
                setShapeSize(pr, kind, prim.size, prim.position, prim.roundness);
                if (kind === 'polystar') configurePolystar(pr, prim);
                added.push(kind);
            }
        }

        if (p.fill) {
            ctx = vectorGroupCtx(ly, groupName);
            if (!ctx) return { ok: false, error: 'grupo perdido antes del fill' };
            var f = null;
            try { f = ctx.contents.addProperty('ADBE Vector Graphic - Fill'); } catch (eF) { f = null; }
            if (!f) return { ok: false, error: 'no se pudo crear el fill' };
            var fcolor = p.fill.color;
            if (typeof fcolor === 'string') fcolor = hexToRgb(fcolor);
            if (fcolor) setValueChecked(vectorProp(f, ['ADBE Vector Fill Color']), fcolor);
            if (p.fill.opacity !== undefined) setValueChecked(vectorProp(f, ['ADBE Vector Fill Opacity']), clampNum(num(p.fill.opacity, 100), 0, 100));
            added.push('fill');
        }

        if (p.stroke) {
            ctx = vectorGroupCtx(ly, groupName);
            if (!ctx) return { ok: false, error: 'grupo perdido antes del stroke' };
            var st = null;
            try { st = ctx.contents.addProperty('ADBE Vector Graphic - Stroke'); } catch (eS) { st = null; }
            if (!st) return { ok: false, error: 'no se pudo crear el stroke' };
            var scolor = p.stroke.color;
            if (typeof scolor === 'string') scolor = hexToRgb(scolor);
            if (scolor) setValueChecked(vectorProp(st, ['ADBE Vector Stroke Color']), scolor);
            if (p.stroke.width !== undefined) setValueChecked(vectorProp(st, ['ADBE Vector Stroke Width']), num(p.stroke.width, 2));
            if (p.stroke.opacity !== undefined) setValueChecked(vectorProp(st, ['ADBE Vector Stroke Opacity']), clampNum(num(p.stroke.opacity, 100), 0, 100));
            if (p.stroke.lineCap !== undefined) {
                var cap = String(p.stroke.lineCap).toLowerCase();
                var capNum = 1;
                if (cap === 'round' || cap === 'redondo') capNum = 2;
                else if (cap === 'square' || cap === 'cuadrado' || cap === 'projecting') capNum = 3;
                setValueChecked(vectorProp(st, ['ADBE Vector Stroke Line Cap']), capNum);
            }
            if (p.stroke.lineJoin !== undefined) {
                var join = String(p.stroke.lineJoin).toLowerCase();
                var joinNum = 1;
                if (join === 'round' || join === 'redondo') joinNum = 2;
                else if (join === 'bevel' || join === 'bisel') joinNum = 3;
                setValueChecked(vectorProp(st, ['ADBE Vector Stroke Line Join']), joinNum);
            }
            if (p.stroke.dashes && typeof p.stroke.dashes.length === 'number') {
                for (var di = 0; di < p.stroke.dashes.length; di++) {
                    var dashName = '';
                    if (di % 2 === 0) dashName = 'ADBE Vector Stroke Dash ' + (Math.floor(di / 2) + 1);
                    else dashName = 'ADBE Vector Stroke Gap ' + (Math.floor(di / 2) + 1);
                    var dashProp = vectorProp(st, [dashName]);
                    if (dashProp) setValueChecked(dashProp, num(p.stroke.dashes[di], 0));
                }
            }
            added.push('stroke');
        }

        if (p.trimPaths) {
            ctx = vectorGroupCtx(ly, groupName);
            if (!ctx) return { ok: false, error: 'grupo perdido antes de trimPaths' };
            var tr = null;
            try { tr = ctx.contents.addProperty('ADBE Vector Filter - Trim'); } catch (eT) { tr = null; }
            if (!tr) return { ok: false, error: 'no se pudo crear trimPaths' };
            if (p.trimPaths.start !== undefined) setValueChecked(vectorProp(tr, ['ADBE Vector Trim Start']), num(p.trimPaths.start, 0));
            if (p.trimPaths.end !== undefined) setValueChecked(vectorProp(tr, ['ADBE Vector Trim End']), num(p.trimPaths.end, 100));
            if (p.trimPaths.offset !== undefined) setValueChecked(vectorProp(tr, ['ADBE Vector Trim Offset']), num(p.trimPaths.offset, 0));
            added.push('trimPaths');
        }

        if (p.repeater) {
            ctx = vectorGroupCtx(ly, groupName);
            if (!ctx) return { ok: false, error: 'grupo perdido antes de repeater' };
            var rp = null;
            try { rp = ctx.contents.addProperty('ADBE Vector Filter - Repeater'); } catch (eRp) { rp = null; }
            if (!rp) return { ok: false, error: 'no se pudo crear repeater' };
            if (p.repeater.copies !== undefined) setValueChecked(vectorProp(rp, ['ADBE Vector Repeater Copies']), num(p.repeater.copies, 3));
            if (p.repeater.offset !== undefined) setValueChecked(vectorProp(rp, ['ADBE Vector Repeater Offset']), num(p.repeater.offset, 0));
            var rt = vectorProp(rp, ['ADBE Vector Repeater Transform']);
            if (rt) {
                if (p.repeater.position !== undefined) setValueChecked(vectorProp(rt, ['ADBE Vector Repeater Position']), p.repeater.position);
                if (p.repeater.scale !== undefined) setValueChecked(vectorProp(rt, ['ADBE Vector Repeater Scale']), p.repeater.scale);
                if (p.repeater.rotation !== undefined) setValueChecked(vectorProp(rt, ['ADBE Vector Repeater Rotation']), num(p.repeater.rotation, 0));
                if (p.repeater.anchor !== undefined) setValueChecked(vectorProp(rt, ['ADBE Vector Repeater Anchor']), p.repeater.anchor);
                if (p.repeater.opacity !== undefined) setValueChecked(vectorProp(rt, ['ADBE Vector Repeater Opacity']), num(p.repeater.opacity, 100));
            }
            added.push('repeater');
        }

        if (p.mergePaths) {
            ctx = vectorGroupCtx(ly, groupName);
            if (!ctx) return { ok: false, error: 'grupo perdido antes de mergePaths' };
            var mg = null;
            try { mg = ctx.contents.addProperty('ADBE Vector Filter - Merge'); } catch (eMg) { mg = null; }
            if (!mg) return { ok: false, error: 'no se pudo crear mergePaths' };
            if (p.mergePaths.mode !== undefined) {
                var mm = String(p.mergePaths.mode).toLowerCase();
                var modeNum = 1;
                if (mm === 'add' || mm === 'sumar') modeNum = 2;
                else if (mm === 'subtract' || mm === 'restar') modeNum = 3;
                else if (mm === 'intersect' || mm === 'interseccion') modeNum = 4;
                else if (mm === 'exclude' || mm === 'excluir') modeNum = 5;
                setValueChecked(vectorProp(mg, ['ADBE Vector Merge Mode']), modeNum);
            }
            added.push('mergePaths');
        }

        if (p.roundCorners) {
            ctx = vectorGroupCtx(ly, groupName);
            if (!ctx) return { ok: false, error: 'grupo perdido antes de roundCorners' };
            var rc = null;
            try { rc = ctx.contents.addProperty('ADBE Vector Filter - RC'); } catch (eRc) { rc = null; }
            if (!rc) return { ok: false, error: 'no se pudo crear roundCorners' };
            if (p.roundCorners.radius !== undefined) setValueChecked(vectorProp(rc, ['ADBE Vector Round Corners Radius']), num(p.roundCorners.radius, 10));
            added.push('roundCorners');
        }

        if (p.groupTransform) {
            ctx = vectorGroupCtx(ly, groupName);
            if (!ctx) return { ok: false, error: 'grupo perdido antes de groupTransform' };
            var vt = propSafe(ctx.group, 'ADBE Vector Transform Group');
            if (!vt) return { ok: false, error: 'el grupo no expone ADBE Vector Transform Group' };
            var gt = p.groupTransform;
            if (gt.anchor !== undefined) setValueChecked(vectorProp(vt, ['ADBE Vector Anchor']), gt.anchor);
            if (gt.position !== undefined) setValueChecked(vectorProp(vt, ['ADBE Vector Position']), gt.position);
            if (gt.scale !== undefined) setValueChecked(vectorProp(vt, ['ADBE Vector Scale']), gt.scale);
            if (gt.rotation !== undefined) setValueChecked(vectorProp(vt, ['ADBE Vector Rotation']), num(gt.rotation, 0));
            if (gt.opacity !== undefined) setValueChecked(vectorProp(vt, ['ADBE Vector Group Opacity']), clampNum(num(gt.opacity, 100), 0, 100));
            added.push('groupTransform');
        }

        var blurBounds = false;
        if (p.expandBlurBounds === true) {
            blurBounds = ensureBlurBounds(ly);
            if (blurBounds) added.push('blurBounds');
        }

        return {
            ok: true,
            layer: ly.name,
            group: groupName,
            layerCreated: created,
            primitive: p.primitive ? String(rawKind) : null,
            added: added,
            blurBounds: blurBounds
        };
    }

    // ---------------- HALO -------------------------------------------------
    function halo(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var ly = getLayer(c, p.layer);
        if (!ly) return { ok: false, error: 'capa no encontrada: ' + p.layer };
        var dup = null;
        try { dup = ly.duplicate(); } catch (e) { dup = null; }
        if (!dup) return { ok: false, error: 'no se pudo duplicar la capa' };
        try { dup.moveAfter(ly); } catch (eMove) {}
        dup.name = String(ly.name) + ' Halo';
        var isShape = false;
        try { isShape = (dup instanceof ShapeLayer); } catch (e2) { isShape = false; }
        var blurBounds = false;
        if (isShape) blurBounds = ensureBlurBounds(dup);
        var parade = propSafe(dup, 'ADBE Effect Parade');
        if (!parade) return { ok: false, error: 'la capa no expone Effects' };
        var fx = null;
        try { fx = parade.addProperty('ADBE Gaussian Blur 2'); } catch (e3) { fx = null; }
        if (!fx) return { ok: false, error: 'no se pudo aplicar ADBE Gaussian Blur 2' };
        var blurVal = clampNum(num(p.blur, 45), 0, 1000);
        var blurProp = vectorProp(fx, ['ADBE Gaussian Blur 2-0001', 'Blurriness', 'Blur']);
        if (blurProp) setValueChecked(blurProp, blurVal);
        var edgeProp = vectorProp(fx, ['ADBE Gaussian Blur 2-0002', 'Repeat Edge Pixels']);
        if (edgeProp) setValueChecked(edgeProp, true);
        var opacity = clampNum(num(p.opacity, 60), 0, 100);
        var wanted = (p.blendingMode === undefined || p.blendingMode === null || p.blendingMode === '') ? 'screen' : p.blendingMode;
        var mode = blendModeFrom(wanted);
        if (mode === null && typeof BlendingMode !== 'undefined') mode = BlendingMode.SCREEN;
        if (mode !== null) {
            try { dup.blendingMode = mode; } catch (eB) {}
        }
        var opProp = propSafe(transformOf(dup), 'ADBE Opacity');
        if (opProp) setValueChecked(opProp, opacity);
        return {
            ok: true,
            layer: dup.name,
            source: ly.name,
            effect: 'ADBE Gaussian Blur 2',
            blur: blurVal,
            opacity: opacity,
            blendingMode: mode,
            blurBounds: blurBounds
        };
    }

    // ---------------- CHECK (verificador mecánico/espacial) ---------------
    function fmtBounds(wb) {
        return 'L ' + Math.round(wb.left) + ' T ' + Math.round(wb.top) + ' R ' + Math.round(wb.right) + ' B ' + Math.round(wb.bottom);
    }

    function pushIssue(state, severity, compName, layerName, code, message) {
        if (state.issues.length >= state.maxIssues) return;
        state.issues.push({ severity: severity, comp: compName, layer: layerName, code: code, message: message });
    }

    function checkExpressionProps(prop, compName, layerName, state) {
        if (!prop || state.issues.length >= state.maxIssues || state.propsChecked >= state.maxProps) return;
        state.propsChecked++;
        var type = null;
        try { type = prop.propertyType; } catch (eT) { type = null; }
        var isProp = false;
        if (typeof PropertyType !== 'undefined') isProp = (type === PropertyType.PROPERTY);
        else isProp = (type === 1 || type === 6153);

        if (isProp) {
            var exprText = '';
            try { exprText = String(prop.expression || ''); } catch (eE) { exprText = ''; }
            if (exprText !== '') {
                state.counts.expressions++;
                var enabled = true;
                try { enabled = prop.expressionEnabled; } catch (eN) { enabled = true; }
                var err = '';
                try { err = String(prop.expressionError || ''); } catch (eErr) { err = ''; }
                var pname = '';
                try { pname = String(prop.name); } catch (eP) { pname = '(sin nombre)'; }
                if (err !== '') {
                    pushIssue(state, 'error', compName, layerName, 'expressionError', 'La expresión de "' + pname + '" falla: ' + err);
                } else if (!enabled) {
                    pushIssue(state, 'warning', compName, layerName, 'expressionDisabled', 'La expresión de "' + pname + '" está desactivada.');
                }
            }
            return;
        }

        var n = 0;
        try { n = prop.numProperties; } catch (eN2) { n = 0; }
        for (var i = 1; i <= n; i++) {
            var child = null;
            try { child = prop.property(i); } catch (eC) { child = null; }
            if (child) checkExpressionProps(child, compName, layerName, state);
            if (state.issues.length >= state.maxIssues || state.propsChecked >= state.maxProps) return;
        }
    }

    function effectsOf(ly) {
        var list = [];
        var parade = propSafe(ly, 'ADBE Effect Parade');
        if (!parade) return list;
        var n = 0;
        try { n = parade.numProperties; } catch (e) { n = 0; }
        for (var i = 1; i <= n; i++) {
            var fx = parade.property(i);
            list.push({ name: String(fx.name), matchName: String(fx.matchName || '') });
        }
        return list;
    }

    function isBlurEffect(fx) {
        var m = String(fx.matchName || '').toLowerCase();
        var n = String(fx.name || '').toLowerCase();
        if (m === 'adbe gaussian blur 2' || m.indexOf('gaussian blur') >= 0) return true;
        if (n.indexOf('blur') >= 0 || n.indexOf('desenfoque') >= 0) return true;
        return false;
    }

    function keyframesAllLinear(prop) {
        if (typeof KeyframeInterpolationType === 'undefined') return false;
        var n = 0;
        try { n = prop.numKeys; } catch (e) { n = 0; }
        if (n < 2) return false;
        var linear = 0;
        for (var i = 2; i <= n; i++) {
            var inT = null;
            var outT = null;
            try {
                inT = prop.keyInInterpolationType(i);
                outT = prop.keyOutInterpolationType(i);
            } catch (e2) {
                return false;
            }
            if (inT === KeyframeInterpolationType.LINEAR && outT === KeyframeInterpolationType.LINEAR) linear++;
        }
        return linear === (n - 1);
    }

    function boundsOverlap(a, b) {
        if (!a || !b) return false;
        if (a.right <= b.left || b.right <= a.left) return false;
        if (a.bottom <= b.top || b.bottom <= a.top) return false;
        return true;
    }

    function layerPropertyGroups(ly) {
        var groups = [];
        var names = ['ADBE Transform Group', 'ADBE Effect Parade', 'ADBE Text Properties', 'ADBE Mask Parade', 'ADBE Root Vectors Group', 'ADBE Layer Styles', 'ADBE Audio Group'];
        for (var i = 0; i < names.length; i++) {
            var g = propSafe(ly, names[i]);
            if (g) groups.push(g);
        }
        return groups;
    }

    function layerIsNull(ly) {
        var isNull = false;
        try { if (ly.nullLayer === true) isNull = true; } catch (eN) { isNull = false; }
        if (!isNull) {
            try {
                if (typeof NullLayer !== 'undefined' && ly instanceof NullLayer) isNull = true;
            } catch (eN2) { isNull = false; }
        }
        return isNull;
    }

    function layerHasVideo(ly) {
        try {
            if (typeof ly.hasVideo === 'boolean') return ly.hasVideo;
        } catch (e) {}
        return true;
    }

    // Opacidad constante en 0: sin keys y valor 0, o todas las keys en 0.
    // Las expresiones quedan fuera para no dar falsos positivos.
    function opacityAlwaysZero(prop) {
        if (!prop) return false;
        var expr = '';
        try { expr = String(prop.expression || ''); } catch (eEx) { expr = ''; }
        if (expr !== '') return false;
        var n = 0;
        try { n = prop.numKeys; } catch (eN) { n = 0; }
        if (n === 0) {
            var v = null;
            try { v = prop.value; } catch (eV) { v = null; }
            if (v === null) return false;
            return (Number(v) === 0) ? true : false;
        }
        for (var i = 1; i <= n; i++) {
            var keyVal = null;
            var got = false;
            try { keyVal = prop.keyValue(i); got = true; } catch (eK) { got = false; }
            if (!got) {
                try { keyVal = prop.valueAtTime(prop.keyTime(i), false); got = true; } catch (eVT) { got = false; }
            }
            if (!got) return false;
            if (Number(keyVal) !== 0) return false;
        }
        return true;
    }

    function checkComp(c, options, state) {
        var key = 'c' + c.id;
        if (state.visited[key]) return;
        state.visited[key] = true;
        state.counts.comps++;
        var t = timeOfComp(c, { time: options.time });
        var texts = [];
        var visuals = [];
        var usedAsParent = {};
        var pi;
        for (pi = 1; pi <= c.numLayers; pi++) {
            var parentLayer = null;
            try { parentLayer = c.layer(pi).parent; } catch (ePar) { parentLayer = null; }
            if (parentLayer) {
                try { usedAsParent[parentLayer.index] = true; } catch (ePIdx) {}
            }
        }
        var i;
        for (i = 1; i <= c.numLayers; i++) {
            var ly = c.layer(i);
            state.counts.layers++;
            var info = layerInfo(ly);
            var isText = (info.kind === 'text');
            var isShape = (info.kind === 'shape');
            if (isText) state.counts.textLayers++;
            if (isShape) state.counts.shapeLayers++;

            var groups = layerPropertyGroups(ly);
            var gi;
            for (gi = 0; gi < groups.length; gi++) {
                checkExpressionProps(groups[gi], c.name, ly.name, state);
            }

            var fxList = effectsOf(ly);
            var hasBlur = false;
            var j;
            for (j = 0; j < fxList.length; j++) {
                var fnm = String(fxList[j].name).toLowerCase();
                if (fxList[j].matchName === 'ADBE Glo2' || fnm.indexOf('glow') >= 0 || fnm.indexOf('brillo') >= 0) {
                    pushIssue(state, 'warning', c.name, ly.name, 'glo2ColorShift', 'ADBE Glo2 ("' + fxList[j].name + '") desplaza el color; usa halo() para un glow fiel.');
                }
                if (isBlurEffect(fxList[j])) hasBlur = true;
            }

            if (isShape && hasBlur) {
                var root = propSafe(ly, 'ADBE Root Vectors Group');
                if (root && !propSafe(root, 'Blur Bounds')) {
                    pushIssue(state, 'warning', c.name, ly.name, 'shapeBlurClipped', 'Shape Layer con blur sin grupo "Blur Bounds": el desenfoque se recorta al cuadrado de la capa. Usa shapeGroup con expandBlurBounds:true.');
                }
            }

            var hasTm = false;
            var tmLayer = null;
            try {
                if (typeof ly.hasTrackMatte === 'boolean') hasTm = ly.hasTrackMatte;
                else if (typeof TrackMatteType !== 'undefined') hasTm = (ly.trackMatteType !== TrackMatteType.NO_TRACK_MATTE);
                else hasTm = !!(ly.trackMatteType && ly.trackMatteType !== 0);
            } catch (eTm) { hasTm = false; }
            try { tmLayer = ly.trackMatteLayer; } catch (eTml) { tmLayer = null; }
            if (hasTm && !tmLayer && ly.index === 1) {
                pushIssue(state, 'warning', c.name, ly.name, 'orphanTrackMatte', 'Track matte sin capa superior (es la primera capa de la comp).');
            }

            var src = null;
            try { src = ly.source; } catch (eSrc) { src = null; }
            if (src && src.footageMissing) {
                pushIssue(state, 'error', c.name, ly.name, 'missingFootage', 'Footage faltante: ' + String(src.name));
            }

            var g = transformOf(ly);
            var posProp2 = g ? propSafe(g, 'ADBE Position') : null;
            var scaleProp2 = g ? propSafe(g, 'ADBE Scale') : null;
            if (posProp2 && keyframesAllLinear(posProp2)) {
                pushIssue(state, 'warning', c.name, ly.name, 'linearKeysLeftover', 'Keyframes lineales en Position (posible olvido).');
            }
            if (scaleProp2 && keyframesAllLinear(scaleProp2)) {
                pushIssue(state, 'warning', c.name, ly.name, 'linearKeysLeftover', 'Keyframes lineales en Scale (posible olvido).');
            }

            var active = !!ly.enabled;
            if (t < ly.inPoint || t > ly.outPoint) active = false;

            // Capa activa con opacidad 0 constante (se ignora en Nulls/audio).
            if (active && !layerIsNull(ly) && layerHasVideo(ly)) {
                var gOp = transformOf(ly);
                var opProp = gOp ? propSafe(gOp, 'ADBE Opacity') : null;
                if (opacityAlwaysZero(opProp)) {
                    pushIssue(state, 'warning', c.name, ly.name, 'alwaysZeroOpacity', 'La capa está activa pero su Opacity es 0 constante; no se verá en el render.');
                }
            }

            // Capas visuales activas no-fondo que podrían tapar un texto.
            if (active && !isText && (info.kind === 'shape' || info.kind === 'av')) {
                var isNullLayer = layerIsNull(ly);
                var isGuide = false;
                try { isGuide = !!ly.guideLayer; } catch (eGu) { isGuide = false; }
                var isAdjustment = false;
                try { isAdjustment = !!ly.adjustmentLayer; } catch (eAd) { isAdjustment = false; }
                var isParentLayer = (usedAsParent[ly.index] === true);
                if (!isNullLayer && !isGuide && !isAdjustment && !isParentLayer && layerHasVideo(ly)) {
                    var vwb = worldBoundsOf(ly, t);
                    if (vwb) {
                        var vw = vwb.right - vwb.left;
                        var vh = vwb.bottom - vwb.top;
                        var lw = vw;
                        var lh = vh;
                        try { if (typeof ly.width === 'number' && ly.width > 0 && ly.width < lw) lw = ly.width; } catch (eW) {}
                        try { if (typeof ly.height === 'number' && ly.height > 0 && ly.height < lh) lh = ly.height; } catch (eH) {}
                        if (lw < c.width * 0.9 || lh < c.height * 0.9) {
                            visuals.push({ layer: ly.name, index: ly.index, bounds: vwb });
                        }
                    }
                }
            }

            if (isText && active) {
                var wb = worldBoundsOf(ly, t);
                if (wb) {
                    var safe80 = { left: c.width * 0.10, top: c.height * 0.10, right: c.width * 0.90, bottom: c.height * 0.90 };
                    var safe90 = { left: c.width * 0.05, top: c.height * 0.05, right: c.width * 0.95, bottom: c.height * 0.95 };
                    if (wb.left < 0 || wb.top < 0 || wb.right > c.width || wb.bottom > c.height) {
                        pushIssue(state, 'error', c.name, ly.name, 'textOutOfFrame', 'El texto sale del encuadre (' + fmtBounds(wb) + ').');
                    } else if (wb.left < safe80.left || wb.top < safe80.top || wb.right > safe80.right || wb.bottom > safe80.bottom) {
                        pushIssue(state, 'warning', c.name, ly.name, 'textOutside80', 'El texto sale del área segura del 80% (' + fmtBounds(wb) + ').');
                    } else if (wb.left < safe90.left || wb.top < safe90.top || wb.right > safe90.right || wb.bottom > safe90.bottom) {
                        pushIssue(state, 'warning', c.name, ly.name, 'textOutside90', 'El texto sale del área segura del 90% (' + fmtBounds(wb) + ').');
                    }
                    texts.push({ layer: ly.name, index: ly.index, bounds: wb });
                }
            }

            if (options.includePrecomps && src) {
                var isPre = false;
                try { isPre = (src instanceof CompItem); } catch (ePre) { isPre = false; }
                if (isPre) checkComp(src, options, state);
            }
        }

        var a;
        var b;
        for (a = 0; a < texts.length; a++) {
            for (b = a + 1; b < texts.length; b++) {
                if (boundsOverlap(texts[a].bounds, texts[b].bounds)) {
                    pushIssue(state, 'warning', c.name, texts[a].layer, 'textOverlap', '"' + texts[a].layer + '" y "' + texts[b].layer + '" se solapan en t=' + t + '.');
                }
            }
        }

        // Una capa visual por encima (índice menor) que solapa el texto lo tapa.
        for (a = 0; a < visuals.length; a++) {
            for (b = 0; b < texts.length; b++) {
                if (visuals[a].index < texts[b].index && boundsOverlap(visuals[a].bounds, texts[b].bounds)) {
                    pushIssue(state, 'warning', c.name, visuals[a].layer, 'layerCoversText', '"' + visuals[a].layer + '" tapa el texto "' + texts[b].layer + '" en t=' + t + '.');
                }
            }
        }
    }

    // Solo lectura: escanea expresiones, blur/clip, Glo2, safe areas, solapes,
    // track mattes/footage y keyframes lineales.
    function check(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var state = {
            visited: {},
            issues: [],
            maxIssues: Math.round(clampNum(num(p.maxIssues, 200), 1, 2000)),
            maxProps: Math.round(clampNum(num(p.maxProperties, 20000), 100, 200000)),
            propsChecked: 0,
            counts: { comps: 0, layers: 0, textLayers: 0, shapeLayers: 0, expressions: 0, issues: 0 }
        };
        var options = {
            includePrecomps: (p.includePrecomps === true || p.recursive === true),
            time: p.time
        };
        checkComp(c, options, state);
        state.counts.issues = state.issues.length;
        var hasError = false;
        for (var i = 0; i < state.issues.length; i++) {
            if (state.issues[i].severity === 'error') {
                hasError = true;
                break;
            }
        }
        return { ok: !hasError, scanned: true, comp: c.name, counts: state.counts, issues: state.issues };
    }

    // ---------------- BATCH (transacción declarativa) ---------------------
    function batch(p) {
        var list = p.steps;
        if (!list || typeof list.length !== 'number' || list.length === 0) {
            return { ok: false, error: 'batch requiere steps[]' };
        }
        var completed = [];
        for (var i = 0; i < list.length; i++) {
            var step = list[i] || {};
            var verb = step.verb;
            var sp = step.params || {};
            if (sp.comp === undefined && p.comp !== undefined) sp.comp = p.comp;
            var res = null;
            if (verb === 'batch') res = batch(sp);
            else res = runVerb(verb, sp);
            if (!res || res.ok !== true) {
                return {
                    ok: false,
                    failedStep: i,
                    verb: String(verb),
                    error: (res && res.error) ? res.error : 'el paso falló',
                    stepResult: res,
                    completed: completed
                };
            }
            completed.push({ index: i, verb: String(verb), result: res });
        }
        return { ok: true, steps: completed.length, completed: completed };
    }

    // ---------------- CONTACT SHEET (AE) ----------------------------------
    // Escribe un PNG temporal por timestamp; el servidor MCP los compone en un
    // único JPEG con los timestamps quemados y limpia estos PNG intermedios.
    function contactSheet(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var times = [];
        var i;
        if (p.times && typeof p.times.length === 'number' && p.times.length > 0) {
            var requested = p.times.length > 64 ? 64 : p.times.length;
            for (i = 0; i < requested; i++) times.push(clampNum(num(p.times[i], 0), 0, c.duration));
        } else {
            var frames = Math.round(clampNum(num(p.frames, 8), 1, 32));
            var stepLen = c.duration / frames;
            for (i = 0; i < frames; i++) times.push(clampNum(stepLen * i, 0, c.duration));
        }
        var stamp = new Date().getTime();
        var paths = [];
        var pathTimes = [];
        for (i = 0; i < times.length; i++) {
            var nm = 'antigravity_ae_sheet_' + stamp + '_' + i + '.png';
            var f = new File(Folder.temp.fsName + '/' + nm);
            try {
                c.saveFrameToPng(times[i], f);
                paths.push(f.fsName);
                pathTimes.push(times[i]);
            } catch (ePng) {}
        }
        // saveFrameToPng escribe en diferido: espera acotada a que existan.
        var tries = 0;
        while (tries < 30) {
            var pending = 0;
            for (i = 0; i < paths.length; i++) {
                var waitFile = new File(paths[i]);
                if (!waitFile.exists || waitFile.length <= 0) pending++;
            }
            if (pending === 0) break;
            if (typeof $.sleep === 'function') $.sleep(100);
            tries++;
        }
        // Solo los PNG listos: times y paths quedan alineados 1:1 aunque el
        // host haya saltado un frame, para que cada timestamp caiga en su tile.
        var ready = [];
        var readyTimes = [];
        var notReady = [];
        for (i = 0; i < paths.length; i++) {
            var chk = new File(paths[i]);
            if (chk.exists && chk.length > 0) {
                ready.push(paths[i]);
                readyTimes.push(pathTimes[i]);
            } else {
                notReady.push(paths[i]);
            }
        }
        if (ready.length === 0) {
            return { ok: false, error: 'no se generó ningún PNG del contact sheet', times: readyTimes, comp: c.name };
        }
        return { ok: true, comp: c.name, times: readyTimes, requestedTimes: times, paths: ready, missing: notReady, waitedMs: tries * 100 };
    }

    // ---------------- Z-STACK (orden determinista de capas) ----------------
    // order se interpreta de arriba hacia abajo: order[0] queda en el índice 1.
    // Se recorre al revés con moveToBeginning para no invertir el resultado.
    // bottom se interpreta de arriba hacia abajo dentro del fondo, moviendo en
    // orden directo con moveToEnd. Las capas opcionales ausentes se reportan.
    function zStack(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var order = [];
        if (typeof p.order === 'string' && p.order !== '') order = [p.order];
        else if (p.order && typeof p.order.length === 'number') order = p.order;
        var bottom = [];
        if (typeof p.bottom === 'string' && p.bottom !== '') bottom = [p.bottom];
        else if (p.bottom && typeof p.bottom.length === 'number') bottom = p.bottom;
        var ordered = [];
        var bottomPlaced = [];
        var missing = [];
        var errors = [];
        var i;

        // Resolver las referencias ANTES de mover: un índice (p.ej. order:[2,3])
        // cambia al mover la primera capa, y moveríamos la capa equivocada.
        var orderLayers = [];
        for (i = 0; i < order.length; i++) {
            var topLy = getLayer(c, order[i]);
            if (!topLy) missing.push(order[i]);
            else orderLayers.push(topLy);
        }
        for (i = orderLayers.length - 1; i >= 0; i--) {
            var topEntry = orderLayers[i];
            try {
                topEntry.moveToBeginning();
                ordered.unshift(topEntry.name);
            } catch (eTop) {
                errors.push('order[' + i + ']: ' + eTop.toString());
            }
        }

        var bottomLayers = [];
        for (i = 0; i < bottom.length; i++) {
            var botLy = getLayer(c, bottom[i]);
            if (!botLy) missing.push(bottom[i]);
            else bottomLayers.push(botLy);
        }
        for (i = 0; i < bottomLayers.length; i++) {
            var botEntry = bottomLayers[i];
            try {
                botEntry.moveToEnd();
                bottomPlaced.push(botEntry.name);
            } catch (eBot) {
                errors.push('bottom[' + i + ']: ' + eBot.toString());
            }
        }

        var stack = [];
        for (i = 1; i <= c.numLayers; i++) stack.push(c.layer(i).name);
        return { ok: true, comp: c.name, ordered: ordered, bottom: bottomPlaced, missing: missing, errors: errors, stack: stack };
    }

    // ---------------- POSE (solo lectura, valueAtTime) --------------------
    // Devuelve transformaciones evaluadas en time sin mover el playhead ni
    // escribir propiedades: el Elefante puede heredar coordenadas entre fases.
    function pose(p) {
        var c = getComp(p.comp);
        if (!c) return { ok: false, error: 'comp no encontrado' };
        var t = timeOfComp(c, p);
        var targets = [];
        var missing = [];
        var i;
        var requestedLayers = p.layers;
        if (typeof requestedLayers === 'string') requestedLayers = [requestedLayers];
        if (requestedLayers && typeof requestedLayers.length === 'number') {
            for (i = 0; i < requestedLayers.length; i++) {
                var one = getLayer(c, requestedLayers[i]);
                if (one) targets.push(one);
                else missing.push(requestedLayers[i]);
            }
        } else {
            for (i = 1; i <= c.numLayers; i++) targets.push(c.layer(i));
        }

        var out = [];
        for (i = 0; i < targets.length; i++) {
            var ly = targets[i];
            var g = transformOf(ly);
            var rotProp = g ? txProp(g, ['ADBE Rotate Z', 'ADBE Rotate X', 'ADBE Rotate Y']) : null;
            out.push({
                name: ly.name,
                index: ly.index,
                parent: ly.parent ? ly.parent.name : null,
                enabled: !!ly.enabled,
                inPoint: ly.inPoint,
                outPoint: ly.outPoint,
                position: valueAtTimeOf(g ? propSafe(g, 'ADBE Position') : null, t, null),
                scale: valueAtTimeOf(g ? propSafe(g, 'ADBE Scale') : null, t, null),
                rotation: valueAtTimeOf(rotProp, t, 0),
                opacity: valueAtTimeOf(g ? propSafe(g, 'ADBE Opacity') : null, t, null)
            });
        }
        return { ok: true, comp: c.name, time: t, layers: out, missing: missing };
    }

    // Mapa único de verbos: dispatch y batch comparten la misma tabla, así que
    // un verbo nuevo se enruta en un solo lugar. lowerThird, overlay y
    // cameraMove siguen disponibles como alias retrocompatibles.
    function runVerb(verb, p) {
        if (verb === 'project') return project();
        if (verb === 'catalog') return catalog(p);
        if (verb === 'comp') return comp(p);
        if (verb === 'layer') return layer(p);
        if (verb === 'settings') return settings(p);
        if (verb === 'shape') return shape(p);
        if (verb === 'fill') return fill(p);
        if (verb === 'text') return text(p);
        if (verb === 'textStyle') return textStyle(p);
        if (verb === 'textAnimator' || verb === 'text-animator') return textAnimator(p);
        if (verb === 'camera') return camera(p);
        if (verb === 'cameraMove' || verb === 'camera-move') return cameraMove(p);
        if (verb === 'lowerThird' || verb === 'lower-third') return lowerThird(p);
        if (verb === 'overlay') return overlay(p);
        if (verb === 'light') return light(p);
        if (verb === 'effect') return effect(p);
        if (verb === 'effectParam') return effectParam(p);
        if (verb === 'effectKey') return effectKey(p);
        if (verb === 'transform') return transform(p);
        if (verb === 'keyframe') return keyframe(p);
        if (verb === 'expression') return expression(p);
        if (verb === 'mask') return mask(p);
        if (verb === 'roto') return roto(p);
        if (verb === 'tracker') return tracker(p);
        if (verb === 'marker') return marker(p);
        if (verb === 'import') return importFile(p);
        if (verb === 'folder') return folder(p);
        if (verb === 'items') return items();
        if (verb === 'render') return render(p);
        if (verb === 'renderOutput') return renderOutput(p);
        if (verb === 'renderFrame') return renderFrame(p);
        if (verb === 'selection') return selection();
        if (verb === 'scripts') return scripts(p);
        if (verb === 'script') return script(p);
        if (verb === 'save') return save();
        if (verb === 'measure') return measure(p);
        if (verb === 'alignAnchor') return alignAnchor(p);
        if (verb === 'shapeGroup') return applyShapeGroup(p);
        if (verb === 'set') return applySet(p);
        if (verb === 'ensureKeysAfter') return ensureKeysAfter(p);
        if (verb === 'halo') return halo(p);
        if (verb === 'check') return check(p);
        if (verb === 'contactSheet') return contactSheet(p);
        if (verb === 'zStack') return zStack(p);
        if (verb === 'pose') return pose(p);
        return null;
    }

    function isReadOnlyVerb(verb) {
        if (verb === 'project') return true;
        if (verb === 'catalog') return true;
        if (verb === 'items') return true;
        if (verb === 'selection') return true;
        if (verb === 'renderFrame') return true;
        if (verb === 'scripts') return true;
        if (verb === 'measure') return true;
        if (verb === 'check') return true;
        if (verb === 'contactSheet') return true;
        if (verb === 'pose') return true;
        return false;
    }

    function dispatch(params) {
        var out = { ok: false };
        try {
            var verb = params.verb;
            var p = params.params || {};
            if (verb === 'batch') {
                var label = 'batch';
                if (p.undoName !== undefined && p.undoName !== null && p.undoName !== '') label = String(p.undoName);
                out = withUndo(label, function () { return batch(p); });
            } else if (isReadOnlyVerb(verb)) {
                out = runVerb(verb, p);
            } else {
                out = withUndo(String(verb), function () { return runVerb(verb, p); });
            }
            if (out === null || out === undefined) {
                out = { ok: false, error: 'verbo desconocido: ' + verb };
            }
        } catch (e) {
            out = { ok: false, error: e.toString() };
        }
        return j(out);
    }

    return { dispatch: dispatch };
})();
