// =============================================================================
// ANTIGRAVITY TOOLKIT — verbos genéricos para agentes (expuestos por MCP)
// Archivo separado: se carga con $.evalFile desde bridge.jsx o desde el panel.
// Compatible con ExtendScript (sin regex \u, sin ES5).
// =============================================================================
$.global.AntigravityToolkit = (function () {
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

    // --- Tiempo, ticks y rutas (QE de Premiere) ----------------------------
    var TPS = 254016000000;

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

    function pad2(n) {
        n = Math.floor(n);
        if (n < 10) return '0' + n;
        return String(n);
    }

    function tcFallback(seconds, fps) {
        var whole = Math.round(fps);
        if (whole < 1) whole = 25;
        var totalFrames = Math.round(seconds * whole);
        var frames = totalFrames % whole;
        var totalSeconds = Math.floor(totalFrames / whole);
        var s = totalSeconds % 60;
        var m = Math.floor(totalSeconds / 60) % 60;
        var h = Math.floor(totalSeconds / 3600);
        return pad2(h) + ':' + pad2(m) + ':' + pad2(s) + ':' + pad2(frames);
    }

    // Los llamados de QE necesitan timecode; seq.timebase es ticks por frame.
    function secToTimecode(seq, seconds) {
        var sec = Number(seconds);
        if (isNaN(sec) || sec < 0) sec = 0;
        var fps = 25;
        try {
            var st = seq.getSettings();
            fps = Number(st.videoFrameRate);
        } catch (e) {}
        if (!fps || isNaN(fps) || fps <= 0) fps = 25;
        try {
            var tb = Number(seq.timebase);
            if (tb && !isNaN(tb) && tb > 0) fps = TPS / tb;
        } catch (e2) {}
        try {
            if (typeof Time !== 'undefined' && Time.getFormatted) {
                return Time.getFormatted(Math.round(sec * TPS), seq.timebase);
            }
        } catch (e3) {}
        return tcFallback(sec, fps);
    }

    // QE exportFramePNG lanza "Unknown error exception" con "/" en Windows.
    function nativePath(p) {
        var s = String(p);
        var osName = '';
        try { osName = String($.os); } catch (e) {}
        if (osName.indexOf('Windows') >= 0) s = s.split('/').join('\\');
        return s;
    }

    function getSequence(ref) {
        if (ref !== undefined && ref !== null && ref !== '') {
            var seqs = app.project.sequences;
            var i;
            for (i = 0; i < seqs.numSequences; i++) {
                if (seqs[i].name === ref) return seqs[i];
            }
            var asNumber = Number(ref);
            if (!isNaN(asNumber) && asNumber >= 0 && asNumber < seqs.numSequences) return seqs[asNumber];
            return null;
        }
        return app.project.activeSequence;
    }

    function activateSequence(seq) {
        if (!seq) return;
        try {
            if (app.project.activeSequence !== seq && seq.open) seq.open();
        } catch (e) {}
    }

    function findComponent(clip, names) {
        if (!clip) return null;
        var comps = clip.components;
        if (!comps) return null;
        for (var i = 0; i < comps.numItems; i++) {
            var c = comps[i];
            var dn = String(c.displayName);
            var mn = String(c.matchName || '');
            for (var k = 0; k < names.length; k++) {
                if (dn === names[k] || mn === names[k]) return c;
            }
        }
        return null;
    }

    function findComponentProperty(component, names) {
        if (!component) return null;
        var props = component.properties;
        if (!props) return null;
        for (var i = 0; i < props.numItems; i++) {
            var pr = props[i];
            var dn = String(pr.displayName);
            var mn = String(pr.matchName || '');
            for (var k = 0; k < names.length; k++) {
                if (dn === names[k] || mn === names[k]) return pr;
            }
        }
        return null;
    }

    function readProp(prop) {
        if (!prop) return null;
        try { return prop.getValue(); } catch (e) { return null; }
    }

    function writeProp(prop, value, time, out, key) {
        if (!prop) {
            out[key] = 'propiedad ausente';
            return false;
        }
        try {
            if (time === null) {
                prop.setValue(value);
            } else {
                try { prop.setTimeVarying(true); } catch (eTV) {}
                prop.setValueAtTime(time, value, true);
            }
            out[key] = value;
            return true;
        } catch (e) {
            out[key] = 'error: ' + String(e);
            return false;
        }
    }

    // Nivel de Premiere: Level = 10 ^ ((dB - 15) / 20).
    function gainDbToAmp(db) { return Math.pow(10, (Number(db) - 15) / 20); }
    function ampToGainDb(amp) { return 20 * Math.log(Number(amp)) / Math.LN10 + 15; }

    function motionState(clip) {
        var motion = findComponent(clip, ['Motion', 'AE.ADBE Motion']);
        var opacityComp = findComponent(clip, ['Opacity', 'ADBE Opacity']);
        return {
            motion: motion,
            opacityComp: opacityComp,
            position: findComponentProperty(motion, ['Position', 'ADBE Position']),
            scale: findComponentProperty(motion, ['Scale', 'ADBE Scale']),
            rotation: findComponentProperty(motion, ['Rotation', 'ADBE Rotation']),
            anchorPoint: findComponentProperty(motion, ['Anchor Point', 'ADBE Anchor Point']),
            opacity: findComponentProperty(opacityComp, ['Opacity', 'ADBE Opacity'])
        };
    }

    function motionValues(st) {
        return {
            position: readProp(st.position),
            scale: readProp(st.scale),
            rotation: readProp(st.rotation),
            anchorPoint: readProp(st.anchorPoint),
            opacity: readProp(st.opacity)
        };
    }

    function applyMotionToClip(clip, spec, time) {
        var st = motionState(clip);
        if (!st.motion) return { ok: false, error: 'el clip no expone Motion' };
        var written = {};
        if (spec.position !== undefined) writeProp(st.position, spec.position, time, written, 'position');
        if (spec.scale !== undefined) writeProp(st.scale, spec.scale, time, written, 'scale');
        if (spec.rotation !== undefined) writeProp(st.rotation, spec.rotation, time, written, 'rotation');
        if (spec.anchorPoint !== undefined) writeProp(st.anchorPoint, spec.anchorPoint, time, written, 'anchorPoint');
        if (spec.opacity !== undefined) writeProp(st.opacity, spec.opacity, time, written, 'opacity');
        return { ok: true, written: written, values: motionValues(st) };
    }

    function volumeLevelProp(clip) {
        var volComp = findComponent(clip, ['Volume', 'ADBE Audio Volume']);
        return findComponentProperty(volComp, ['Level', 'ADBE Audio Volume Level']);
    }

    function applyVolumeToClip(clip, spec, time) {
        var level = volumeLevelProp(clip);
        if (!level) return { ok: false, error: 'el clip no expone Volume/Level' };
        var previous = readProp(level);
        var written = {};
        var target = gainDbToAmp(num(spec.gainDb, 0));
        writeProp(level, target, time, written, 'level');
        return { ok: true, gainDb: num(spec.gainDb, 0), level: target, previousLevel: previous, written: written };
    }

    function findClipAt(track, at) {
        if (!track || !track.clips) return null;
        var clips = track.clips;
        var best = null;
        var bestDiff = 1;
        for (var i = 0; i < clips.numItems; i++) {
            var c = clips[i];
            var start = 0;
            try { start = Number(c.start.seconds); } catch (e) { start = 0; }
            var d = Math.abs(start - at);
            if (d < bestDiff) {
                bestDiff = d;
                best = c;
            }
        }
        if (bestDiff > 0.25) return null;
        return best;
    }

    function clearSequence(seq) {
        var trackSets = [seq.videoTracks, seq.audioTracks];
        for (var k = 0; k < trackSets.length; k++) {
            var tracks = trackSets[k];
            for (var t = 0; t < tracks.numTracks; t++) {
                var trackObj = tracks[t];
                for (var c = trackObj.clips.numItems - 1; c >= 0; c--) {
                    try { trackObj.clips[c].remove(); } catch (e) {}
                }
            }
        }
    }

    function applyAudioCrossfades(seq, frames) {
        var applied = 0;
        try {
            app.enableQE();
            var qs = qe.project.getActiveSequence();
            if (!qs) return 0;
            var tr = null;
            try {
                if (qe.project.getAudioTransitionByName) tr = qe.project.getAudioTransitionByName('Constant Power');
            } catch (eT) { tr = null; }
            if (!tr) return 0;
            for (var t = 0; t < seq.audioTracks.numTracks; t++) {
                var qTrack = null;
                try { qTrack = qs.getAudioTrackAt(t); } catch (eQ) { qTrack = null; }
                if (!qTrack) continue;
                var clipCount = seq.audioTracks[t].clips.numItems;
                for (var i = 1; i < clipCount; i++) {
                    var qItem = null;
                    try { qItem = qTrack.getItemAt(i); } catch (eI) { qItem = null; }
                    if (!qItem) continue;
                    try {
                        qItem.addTransition(tr);
                        applied++;
                    } catch (eAdd) {}
                }
            }
        } catch (eAll) {}
        // La duración exacta del crossfade la fija QE con su valor por defecto.
        return applied;
    }

    function findItem(name) {
        var found = null;
        function walk(item) {
            for (var i = 0; i < item.children.numItems; i++) {
                var c = item.children[i];
                if (c.type === ProjectItemType.BIN) walk(c);
                else if (c.name === name) found = c;
            }
        }
        walk(app.project.rootItem);
        return found;
    }

    function track(kind, index) {
        var seq = app.project.activeSequence;
        var tracks = (kind === 'audio') ? seq.audioTracks : seq.videoTracks;
        return tracks[index || 0];
    }

    function listClips(t) {
        var a = [];
        if (!t || !t.clips) return a;
        for (var i = 0; i < t.clips.numItems; i++) {
            var c = t.clips[i];
            a.push({ name: c.name, start: Number(c.start.seconds.toFixed(3)), end: Number(c.end.seconds.toFixed(3)) });
        }
        return a;
    }

    function catalog(kind) {
        app.enableQE();
        if (kind === 'videoEffects') return qe.project.getVideoEffectList();
        if (kind === 'videoTransitions') return qe.project.getVideoTransitionList();
        if (kind === 'audioEffects') return qe.project.getAudioEffectList();
        if (kind === 'audioTransitions') return qe.project.getAudioTransitionList();
        return null;
    }

    function projectModel() {
        var seq = app.project.activeSequence;
        var out = { project: app.project.name, active: seq ? seq.name : null, sequences: [], tracks: [] };
        for (var i = 0; i < app.project.sequences.numSequences; i++) out.sequences.push(app.project.sequences[i].name);
        if (seq) {
            var st = seq.getSettings();
            out.settings = { width: st.videoFrameWidth, height: st.videoFrameHeight, fps: st.videoFrameRate };
            out.tracks.push({ kind: 'video', clips: listClips(seq.videoTracks[0]) });
            out.tracks.push({ kind: 'audio', clips: listClips(seq.audioTracks[0]) });
        }
        return out;
    }

    function insert(itemName, timeSec, kind) {
        var it = findItem(itemName);
        if (!it) return { ok: false, error: 'item no encontrado: ' + itemName };
        track(kind, 0).insertClip(it, timeSec);
        return { ok: true, inserted: itemName, at: timeSec };
    }

    function overwrite(itemName, timeSec, kind) {
        var it = findItem(itemName);
        if (!it) return { ok: false, error: 'item no encontrado: ' + itemName };
        track(kind, 0).overwriteClip(it, timeSec);
        return { ok: true, overwrote: itemName, at: timeSec };
    }

    function razor(timecode, kind) {
        app.enableQE();
        var qs = qe.project.getActiveSequence();
        var t = (kind === 'audio') ? qs.getAudioTrackAt(0) : qs.getVideoTrackAt(0);
        t.razor(timecode);
        return { ok: true, razor: timecode };
    }

    function removeClip(index, kind) {
        app.enableQE();
        var qs = qe.project.getActiveSequence();
        var t = (kind === 'audio') ? qs.getAudioTrackAt(0) : qs.getVideoTrackAt(0);
        var it = t.getItemAt(index);
        if (!it) return { ok: false, error: 'índice inválido' };
        it.remove();
        return { ok: true, removedIndex: index, note: 'deja hueco (sin ripple)' };
    }

    function subclip(itemName, inSec, outSec, name) {
        var it = findItem(itemName);
        if (!it) return { ok: false, error: 'item no encontrado: ' + itemName };
        var sub = it.createSubClip(name || (itemName + ' sub'), inSec, outSec, true, false, true);
        return { ok: true, name: sub.name, inSec: inSec, outSec: outSec };
    }

    function applyTransition(index, name, kind) {
        app.enableQE();
        var qs = qe.project.getActiveSequence();
        var t = (kind === 'audio') ? qs.getAudioTrackAt(0) : qs.getVideoTrackAt(0);
        var it = t.getItemAt(index);
        if (!it) return { ok: false, error: 'índice inválido' };
        var tr = qe.project.getVideoTransitionByName(name);
        if (!tr) return { ok: false, error: 'transición no encontrada: ' + name };
        it.addTransition(tr);
        return { ok: true, applied: name, index: index };
    }

    function applyEffect(index, name) {
        return { ok: false, supported: false, reason: 'Premiere no expone aplicar efectos por API/QE; requiere UI automation', effect: name };
    }

    function marker(timeSec, name) {
        var seq = app.project.activeSequence;
        var m = seq.markers.createMarker(timeSec);
        if (name) m.name = name;
        return { ok: true, markers: seq.markers.numMarkers };
    }

    function clearMarkers() {
        var seq = app.project.activeSequence;
        var n = seq.markers.numMarkers;
        for (var i = n - 1; i >= 0; i--) {
            try { seq.markers.deleteMarker(seq.markers[i]); } catch (e) {}
        }
        return { ok: true, left: seq.markers.numMarkers };
    }

    // Guardado sin el diálogo modal "Project Modified": saveAs con ruta nativa.
    function saveSafe(p) {
        var mode = (p.mode === undefined || p.mode === null || p.mode === '') ? 'save' : String(p.mode).toLowerCase();
        var targetPath = '';
        if (mode === 'as') {
            if (!p.path) return { ok: false, error: 'saveSafe mode:as requiere path' };
            targetPath = nativePath(p.path);
        } else if (mode === 'version') {
            var currentPath = '';
            try { currentPath = String(app.project.path); } catch (e0) { currentPath = ''; }
            if (!currentPath) return { ok: false, error: 'el proyecto no tiene ruta; usa mode:as con path' };
            var current = new File(currentPath);
            var dir = current.parent ? current.parent.fsName : '';
            var fileBase = String(current.name);
            var dot = fileBase.lastIndexOf('.');
            var stem = fileBase;
            var ext = '.prproj';
            if (dot > 0) {
                stem = fileBase.substring(0, dot);
                ext = fileBase.substring(dot);
            }
            var n = 1;
            while (n < 1000) {
                var pad = '00' + n;
                pad = pad.substring(pad.length - 3);
                targetPath = nativePath(dir + '/' + stem + '_v' + pad + ext);
                if (!(new File(targetPath)).exists) break;
                n++;
            }
        } else {
            if (p.path) {
                targetPath = nativePath(p.path);
            } else {
                try { targetPath = nativePath(app.project.path); } catch (e1) { targetPath = ''; }
            }
            if (!targetPath) return { ok: false, error: 'proyecto sin ruta; pasa path o usa mode:as' };
        }
        try {
            app.project.saveAs(targetPath);
        } catch (e) {
            return { ok: false, mode: mode, error: 'saveAs falló: ' + String(e), path: targetPath };
        }
        return { ok: true, mode: mode, saved: targetPath };
    }

    // Ojos en Premiere: QE exportFramePNG escribe un PNG en Folder.temp.
    function renderFrame(p) {
        var seq = getSequence(p.sequence);
        if (!seq) return { ok: false, error: 'secuencia no encontrada' };
        activateSequence(seq);
        var t = 0;
        if (p.time !== undefined && p.time !== null && p.time !== '') {
            t = Math.max(0, num(p.time, 0));
        } else {
            try { t = Number(seq.getPlayerPosition().seconds); } catch (e0) { t = 0; }
        }
        var tc = secToTimecode(seq, t);
        app.enableQE();
        var qs = qe.project.getActiveSequence();
        if (!qs) return { ok: false, error: 'QE no expone la secuencia activa' };
        var stamp = new Date().getTime();
        var base = nativePath(Folder.temp.fsName + '/antigravity_pr_frame_' + stamp + '_' + Math.floor(Math.random() * 100000));
        try {
            qs.exportFramePNG(tc, base);
        } catch (e) {
            return { ok: false, error: 'exportFramePNG falló: ' + String(e), timecode: tc };
        }
        return { ok: true, sequence: seq.name, time: t, timecode: tc, path: base + '.png', temp: true };
    }

    function contactSheet(p) {
        var seq = getSequence(p.sequence);
        if (!seq) return { ok: false, error: 'secuencia no encontrada' };
        activateSequence(seq);
        var duration = 0;
        try { duration = Number(seq.end.seconds); } catch (eD) { duration = 0; }
        var times = [];
        var i;
        if (p.times && typeof p.times.length === 'number' && p.times.length > 0) {
            for (i = 0; i < p.times.length; i++) times.push(Math.max(0, num(p.times[i], 0)));
        } else {
            var frames = Math.round(clampNum(num(p.frames, 8), 1, 32));
            if (duration <= 0) duration = 5;
            var step = duration / frames;
            for (i = 0; i < frames; i++) times.push(clampNum(step * i, 0, duration));
        }
        app.enableQE();
        var qs = qe.project.getActiveSequence();
        if (!qs) return { ok: false, error: 'QE no expone la secuencia activa' };
        var stamp = new Date().getTime();
        var paths = [];
        var files = [];
        for (i = 0; i < times.length; i++) {
            var tc = secToTimecode(seq, times[i]);
            var base = nativePath(Folder.temp.fsName + '/antigravity_pr_sheet_' + stamp + '_' + i);
            try {
                qs.exportFramePNG(tc, base);
                paths.push(base + '.png');
                files.push(new File(base + '.png'));
            } catch (ePng) {}
        }
        var tries = 0;
        while (tries < 30) {
            var pending = 0;
            for (i = 0; i < files.length; i++) {
                if (!files[i].exists) pending++;
            }
            if (pending === 0) break;
            if (typeof $.sleep === 'function') $.sleep(100);
            tries++;
        }
        var ready = [];
        var notReady = [];
        for (i = 0; i < paths.length; i++) {
            var checkFile = new File(paths[i]);
            if (checkFile.exists) ready.push(paths[i]);
            else notReady.push(paths[i]);
        }
        if (ready.length === 0) {
            return { ok: false, error: 'no se generó ningún PNG del contact sheet', times: times, sequence: seq.name };
        }
        return { ok: true, sequence: seq.name, times: times, paths: ready, missing: notReady, waitedMs: tries * 100 };
    }

    function clipMotion(p) {
        var seq = getSequence(p.sequence);
        if (!seq) return { ok: false, error: 'secuencia no encontrada' };
        activateSequence(seq);
        var trackIndex = Math.round(num(p.trackIndex, 1));
        var clipIndex = Math.round(num(p.clipIndex, 0));
        var vtrack = seq.videoTracks[trackIndex - 1];
        if (!vtrack) return { ok: false, error: 'pista de video inexistente: ' + trackIndex };
        var clip = vtrack.clips[clipIndex];
        if (!clip) return { ok: false, error: 'clip inexistente en índice ' + clipIndex };
        var st = motionState(clip);
        if (!st.motion) return { ok: false, error: 'el clip no expone Motion' };
        var time = null;
        if (p.time !== undefined && p.time !== null && p.time !== '') time = num(p.time, 0);
        var wants = (p.position !== undefined || p.scale !== undefined || p.rotation !== undefined || p.anchorPoint !== undefined || p.opacity !== undefined);
        if (!wants) {
            return {
                ok: true,
                mode: 'read',
                sequence: seq.name,
                trackIndex: trackIndex,
                clipIndex: clipIndex,
                clip: clip.name,
                motion: motionValues(st),
                time: time
            };
        }
        var applied = applyMotionToClip(clip, p, time);
        if (!applied.ok) return applied;
        return {
            ok: true,
            mode: 'write',
            sequence: seq.name,
            trackIndex: trackIndex,
            clipIndex: clipIndex,
            clip: clip.name,
            written: applied.written,
            motion: applied.values,
            time: time
        };
    }

    function clipVolume(p) {
        var seq = getSequence(p.sequence);
        if (!seq) return { ok: false, error: 'secuencia no encontrada' };
        activateSequence(seq);
        var trackIndex = Math.round(num(p.trackIndex, 1));
        var clipIndex = Math.round(num(p.clipIndex, 0));
        var atrack = seq.audioTracks[trackIndex - 1];
        if (!atrack) return { ok: false, error: 'pista de audio inexistente: ' + trackIndex };
        var clip = atrack.clips[clipIndex];
        if (!clip) return { ok: false, error: 'clip inexistente en índice ' + clipIndex };
        var level = volumeLevelProp(clip);
        if (!level) return { ok: false, error: 'el clip no expone Volume/Level' };
        var time = null;
        if (p.time !== undefined && p.time !== null && p.time !== '') time = num(p.time, 0);
        var current = readProp(level);
        if (p.gainDb === undefined || p.gainDb === null || p.gainDb === '') {
            var currentDb = null;
            if (current !== null) currentDb = ampToGainDb(current);
            return {
                ok: true,
                mode: 'read',
                sequence: seq.name,
                trackIndex: trackIndex,
                clipIndex: clipIndex,
                clip: clip.name,
                level: current,
                gainDb: currentDb,
                time: time
            };
        }
        var applied = applyVolumeToClip(clip, p, time);
        if (!applied.ok) return applied;
        return {
            ok: true,
            mode: 'write',
            sequence: seq.name,
            trackIndex: trackIndex,
            clipIndex: clipIndex,
            clip: clip.name,
            gainDb: applied.gainDb,
            level: applied.level,
            previousLevel: applied.previousLevel,
            written: applied.written,
            time: time
        };
    }

    function assemble(p) {
        var specs = p.clips;
        if (!specs || typeof specs.length !== 'number' || specs.length === 0) {
            return { ok: false, error: 'assemble requiere clips[]' };
        }
        var name = (p.name !== undefined && p.name !== null && p.name !== '') ? String(p.name) : ('AG Assemble ' + new Date().getTime());
        var template = null;
        if (p.cloneOf !== undefined && p.cloneOf !== null && p.cloneOf !== '') {
            template = getSequence(p.cloneOf);
            if (!template) return { ok: false, error: 'secuencia base no encontrada: ' + p.cloneOf };
        } else {
            template = app.project.activeSequence;
        }
        var seq = null;
        if (template) {
            seq = template.clone();
        } else {
            try { seq = app.project.createNewSequence(name, ''); } catch (eCreate) { seq = null; }
            if (!seq) return { ok: false, error: 'no hay secuencia para clonar; abre una o pasa cloneOf' };
        }
        try { seq.name = name; } catch (eName) {}
        if (p.bin !== undefined && p.bin !== null && p.bin !== '') {
            var binItem = findItem(p.bin);
            if (binItem) {
                try { seq.moveBin(binItem); } catch (eBin) {}
            }
        }
        if (p.replace === true) clearSequence(seq);
        var fps = 25;
        try {
            var st = seq.getSettings();
            fps = Number(st.videoFrameRate);
        } catch (eSet) {}
        if (!fps || isNaN(fps) || fps <= 0) fps = 25;
        var margin = 0.25 / fps;
        var placed = [];
        var i;
        for (i = 0; i < specs.length; i++) {
            var spec = specs[i] || {};
            var item = findItem(spec.item);
            if (!item) {
                return { ok: false, error: 'clip ' + i + ': item no encontrado: ' + spec.item, placed: placed, sequence: seq.name };
            }
            var inSec = num(spec.inSec, 0);
            var outSec = num(spec.outSec, inSec + 1);
            if (outSec <= inSec) {
                return { ok: false, error: 'clip ' + i + ': outSec debe ser mayor que inSec', placed: placed, sequence: seq.name };
            }
            var at = Math.max(0, num(spec.timelineSec, 0));
            try {
                item.setInPoint(inSec + margin, 4);
                item.setOutPoint(outSec + margin, 4);
            } catch (eIO) {
                return { ok: false, error: 'clip ' + i + ': no se pudieron fijar in/out: ' + String(eIO), placed: placed, sequence: seq.name };
            }
            var audioOnly = (spec.audioTrack !== undefined && spec.videoTrack === undefined);
            var trackIndex = 0;
            var targetTrack = null;
            if (audioOnly) {
                trackIndex = Math.round(num(spec.audioTrack, 1));
                targetTrack = seq.audioTracks[trackIndex - 1];
            } else {
                trackIndex = Math.round(num(spec.videoTrack, 1));
                targetTrack = seq.videoTracks[trackIndex - 1];
            }
            if (!targetTrack) {
                return { ok: false, error: 'clip ' + i + ': pista inexistente ' + trackIndex, placed: placed, sequence: seq.name };
            }
            try {
                targetTrack.overwriteClip(item, at);
            } catch (eIns) {
                return { ok: false, error: 'clip ' + i + ': overwriteClip falló: ' + String(eIns), placed: placed, sequence: seq.name };
            }
            var placedClip = findClipAt(targetTrack, at);
            if (spec.gainDb !== undefined) {
                var audioTrackIndex = Math.round(num(spec.audioTrack, 1));
                var audioClip = audioOnly ? placedClip : findClipAt(seq.audioTracks[audioTrackIndex - 1], at);
                if (audioClip) applyVolumeToClip(audioClip, spec, null);
            }
            if (!audioOnly && placedClip && (spec.scale !== undefined || spec.position !== undefined)) {
                applyMotionToClip(placedClip, spec, null);
            }
            placed.push({
                index: i,
                name: item.name,
                track: audioOnly ? 'audio' : 'video',
                trackIndex: trackIndex,
                timelineSec: at,
                inSec: inSec,
                outSec: outSec
            });
        }
        var crossfades = 0;
        if (p.xfadeAudioFrames !== undefined && p.xfadeAudioFrames !== null) {
            var xf = Math.round(num(p.xfadeAudioFrames, 0));
            if (xf > 0) crossfades = applyAudioCrossfades(seq, xf);
        }
        activateSequence(seq);
        return {
            ok: true,
            sequence: seq.name,
            created: true,
            replaced: p.replace === true,
            clips: placed,
            audioCrossfades: crossfades
        };
    }

    // ---------------- MEDIA / BINS / EXPORT / SPEED / SRT -----------------
    function getTrackItem(seq, kind, trackIndex, clipIndex) {
        var tracks = kind === 'audio' ? seq.audioTracks : seq.videoTracks;
        var track = tracks[trackIndex - 1];
        if (!track) return null;
        return track.clips[clipIndex] || null;
    }

    function findChildBin(parent, name) {
        if (!parent || !parent.children) return null;
        for (var i = 0; i < parent.children.numItems; i++) {
            var child = parent.children[i];
            if (child.type === ProjectItemType.BIN && String(child.name) === String(name)) return child;
        }
        return null;
    }

    function findBin(pathText) {
        var raw = String(pathText === undefined || pathText === null ? '' : pathText);
        var parts = raw.split('/');
        var current = app.project.rootItem;
        for (var i = 0; i < parts.length; i++) {
            var name = parts[i];
            if (name === '') continue;
            var child = findChildBin(current, name);
            if (!child) return null;
            current = child;
        }
        return current;
    }

    function binItemNames(bin) {
        var names = [];
        if (!bin || !bin.children) return names;
        for (var i = 0; i < bin.children.numItems; i++) names.push(String(bin.children[i].name));
        return names;
    }

    function diffNames(before, after) {
        var out = [];
        for (var i = 0; i < after.length; i++) {
            var found = false;
            for (var k = 0; k < before.length; k++) {
                if (before[k] === after[i]) {
                    found = true;
                    break;
                }
            }
            if (!found) out.push(after[i]);
        }
        return out;
    }

    function importMedia(p) {
        var rawPaths = [];
        if (p.paths && typeof p.paths.length === 'number') {
            for (var i = 0; i < p.paths.length; i++) rawPaths.push(String(p.paths[i]));
        } else if (p.path) {
            rawPaths.push(String(p.path));
        }
        if (rawPaths.length === 0) return { ok: false, error: 'import requiere path o paths[]' };

        var targetBin = app.project.rootItem;
        if (p.bin) {
            targetBin = findBin(p.bin);
            if (!targetBin) return { ok: false, error: 'bin no encontrado: ' + p.bin };
        }

        var valid = [];
        var missing = [];
        for (var v = 0; v < rawPaths.length; v++) {
            var file = new File(nativePath(rawPaths[v]));
            if (file.exists) valid.push(file.fsName);
            else missing.push(rawPaths[v]);
        }
        if (valid.length === 0) return { ok: false, error: 'ningún archivo existe', missing: missing };

        var before = binItemNames(targetBin);
        var importedOk = false;
        try {
            importedOk = app.project.importFiles(valid, p.suppressUI !== false, targetBin, p.numberedStills === true);
        } catch (eImp) {
            return { ok: false, error: 'importFiles falló: ' + String(eImp), missing: missing };
        }
        var after = binItemNames(targetBin);
        var imported = diffNames(before, after);
        var ok = false;
        if (importedOk === true || imported.length > 0) ok = true;
        return {
            ok: ok,
            imported: imported,
            count: imported.length,
            missing: missing,
            bin: String(targetBin.name)
        };
    }

    function createBinTree(parent, nodes, created, prefix) {
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            var name = '';
            var children = null;
            if (typeof node === 'string') name = node;
            else if (node) {
                name = String(node.name || '');
                children = node.children || null;
            }
            if (name === '') continue;
            var full = name;
            if (prefix !== '') full = prefix + '/' + name;
            var bin = findChildBin(parent, name);
            if (!bin) {
                try { bin = parent.createBin(name); } catch (eBin) { bin = null; }
                if (!bin) return { ok: false, error: 'no se pudo crear el bin: ' + full };
                created.push(full);
            }
            if (children && typeof children.length === 'number' && children.length > 0) {
                var sub = createBinTree(bin, children, created, full);
                if (!sub.ok) return sub;
            }
        }
        return { ok: true };
    }

    function createBins(p) {
        var parent = app.project.rootItem;
        var prefix = '';
        if (p.parent) {
            parent = findBin(p.parent);
            if (!parent) return { ok: false, error: 'bin padre no encontrado: ' + p.parent };
            prefix = String(p.parent);
        }
        var created = [];
        if (p.tree && typeof p.tree.length === 'number') {
            var treeRes = createBinTree(parent, p.tree, created, prefix);
            if (!treeRes.ok) return treeRes;
        } else {
            var raw = '';
            if (p.path) raw = String(p.path);
            else if (p.name) raw = String(p.name);
            else return { ok: false, error: 'bin requiere name, path o tree' };
            var parts = raw.split('/');
            var current = parent;
            var currentPath = prefix;
            for (var i = 0; i < parts.length; i++) {
                var part = parts[i];
                if (part === '') continue;
                currentPath = currentPath === '' ? part : currentPath + '/' + part;
                var existing = findChildBin(current, part);
                if (existing) {
                    current = existing;
                    continue;
                }
                var bin = null;
                try { bin = current.createBin(part); } catch (eNew) { bin = null; }
                if (!bin) return { ok: false, error: 'no se pudo crear el bin: ' + currentPath };
                created.push(currentPath);
                current = bin;
            }
        }
        return { ok: true, created: created, count: created.length, parent: prefix };
    }

    function exportSequence(p) {
        var seq = getSequence(p.sequence);
        if (!seq) return { ok: false, error: 'secuencia no encontrada' };
        var mode = (p.mode === undefined || p.mode === null || p.mode === '') ? 'ame' : String(p.mode).toLowerCase();
        if (mode !== 'direct' && mode !== 'ame') return { ok: false, error: 'mode inválido (direct|ame)' };
        if (!p.path) return { ok: false, error: 'export requiere path de salida' };
        var outputPath = nativePath(String(p.path));
        var presetPath = '';
        if (p.preset) presetPath = nativePath(String(p.preset));
        var workArea = 0;
        if (p.workArea !== undefined && p.workArea !== null) workArea = Math.round(num(p.workArea, 0));
        if (workArea < 0 || workArea > 2) return { ok: false, error: 'workArea inválido (0|1|2)' };

        if (mode === 'direct') {
            if (presetPath !== '') {
                try {
                    var direct = seq.exportAsMediaDirect(outputPath, presetPath, workArea);
                    return {
                        ok: direct === true,
                        mode: mode,
                        sequence: seq.name,
                        path: outputPath,
                        preset: presetPath,
                        workArea: workArea,
                        via: 'exportAsMediaDirect'
                    };
                } catch (eDirect) {}
            }
            var rq = app.project.renderQueue;
            var item = null;
            try { item = rq.items.add(seq); } catch (eAdd) { return { ok: false, error: 'no se pudo encolar: ' + String(eAdd) }; }
            try {
                var om = item.outputModules[0];
                if (om) {
                    om.file = new File(outputPath);
                    if (presetPath !== '') om.applyTemplate(presetPath);
                }
            } catch (eOm) {}
            try {
                rq.render();
            } catch (eRender) {
                return { ok: false, error: 'render falló: ' + String(eRender), path: outputPath };
            }
            return {
                ok: true,
                mode: mode,
                sequence: seq.name,
                path: outputPath,
                preset: presetPath === '' ? null : presetPath,
                workArea: workArea,
                via: 'renderQueue'
            };
        }

        var batchAvailable = false;
        if (app.encoder && app.encoder.startBatch) batchAvailable = true;
        if (app.encoder && app.encoder.encodeSequence && presetPath !== '') {
            var jobId = 0;
            try {
                jobId = app.encoder.encodeSequence(seq, outputPath, presetPath, workArea, p.removeFromQueue === true);
            } catch (eAme) {
                return { ok: false, error: 'encodeSequence falló: ' + String(eAme), path: outputPath };
            }
            if (jobId) {
                var batchStarted = false;
                if (batchAvailable) {
                    try { app.encoder.startBatch(); batchStarted = true; } catch (eBatch) {}
                }
                return {
                    ok: true,
                    mode: mode,
                    sequence: seq.name,
                    path: outputPath,
                    preset: presetPath,
                    workArea: workArea,
                    jobId: String(jobId),
                    via: 'encodeSequence',
                    batchStarted: batchStarted
                };
            }
        }

        var rq2 = app.project.renderQueue;
        var item2 = null;
        try { item2 = rq2.items.add(seq); } catch (eAdd2) { return { ok: false, error: 'no se pudo encolar: ' + String(eAdd2) }; }
        try {
            var om2 = item2.outputModules[0];
            if (om2) om2.file = new File(outputPath);
        } catch (eOm2) {}
        try {
            var removeAfter = p.removeFromQueue !== false;
            if (typeof rq2.queueInAME !== 'function') throw new Error('queueInAME no disponible');
            rq2.queueInAME(removeAfter);
        } catch (eAme2) {
            return {
                ok: false,
                error: 'no se pudo enviar a AME (define preset para encodeSequence): ' + String(eAme2),
                path: outputPath
            };
        }
        return {
            ok: true,
            mode: mode,
            sequence: seq.name,
            path: outputPath,
            preset: null,
            workArea: workArea,
            via: 'queueInAME'
        };
    }

    function clipSpeed(p) {
        var seq = getSequence(p.sequence);
        if (!seq) return { ok: false, error: 'secuencia no encontrada' };
        var kind = p.kind === 'audio' ? 'audio' : 'video';
        var trackIndex = Math.round(num(p.trackIndex, 1));
        var clipIndex = Math.round(num(p.clipIndex, 0));
        if (trackIndex < 1) trackIndex = 1;
        if (clipIndex < 0) clipIndex = 0;
        var trackItem = getTrackItem(seq, kind, trackIndex, clipIndex);
        if (!trackItem) return { ok: false, error: 'clip inexistente (pista ' + trackIndex + ', índice ' + clipIndex + ')' };
        var currentSpeed = null;
        try { currentSpeed = trackItem.getSpeed(); } catch (eSpeed) { currentSpeed = null; }

        if (p.speed === undefined || p.speed === null || p.speed === '') {
            return {
                ok: true,
                mode: 'read',
                sequence: seq.name,
                kind: kind,
                trackIndex: trackIndex,
                clipIndex: clipIndex,
                clip: String(trackItem.name),
                speed: currentSpeed
            };
        }

        var speed = num(p.speed, 1);
        if (isNaN(speed) || speed <= 0) return { ok: false, error: 'speed debe ser un número > 0' };

        app.enableQE();
        var qs = qe.project.getActiveSequence();
        if (!qs) return { ok: false, error: 'QE no expone la secuencia activa' };
        var qTrack = null;
        try {
            qTrack = kind === 'audio' ? qs.getAudioTrackAt(trackIndex - 1) : qs.getVideoTrackAt(trackIndex - 1);
        } catch (eTrack) {
            qTrack = null;
        }
        if (!qTrack) return { ok: false, error: 'QE no expone la pista ' + trackIndex };
        var qClip = null;
        try { qClip = qTrack.getItemAt(clipIndex); } catch (eClip) { qClip = null; }
        if (!qClip) return { ok: false, error: 'QE no expone el clip ' + clipIndex };

        var baseTicks = 0;
        try { baseTicks = Number(qClip.duration); } catch (eDur) { baseTicks = 0; }
        if (!baseTicks || isNaN(baseTicks)) {
            try {
                var startSec = Number(trackItem.start.seconds);
                var endSec = Number(trackItem.end.seconds);
                if (endSec > startSec) baseTicks = Math.round((endSec - startSec) * TPS);
            } catch (eSec) {}
        }
        if (!baseTicks || isNaN(baseTicks)) return { ok: false, error: 'no se pudo leer la duración del clip' };

        var targetTicks = String(Math.round(baseTicks / speed));
        var reverse = p.reverse === true;
        var maintainPitch = p.maintainPitch !== false;
        var ripple = p.ripple === true;
        var applied = false;
        try {
            applied = qClip.setSpeed(speed, targetTicks, reverse, maintainPitch, ripple);
        } catch (eSet) {
            return {
                ok: false,
                error: 'setSpeed falló: ' + String(eSet),
                hint: 'Firma QE esperada: setSpeed(speed:number, durationTicks:string, reverse:boolean, maintainPitch:boolean, ripple:boolean)',
                tried: { speed: speed, durationTicks: targetTicks }
            };
        }
        var afterSpeed = null;
        try { afterSpeed = trackItem.getSpeed(); } catch (eAfter) { afterSpeed = null; }
        if (applied === false) {
            return {
                ok: false,
                error: 'QE rechazó setSpeed',
                speed: speed,
                previousSpeed: currentSpeed,
                afterSpeed: afterSpeed
            };
        }
        return {
            ok: true,
            mode: 'write',
            sequence: seq.name,
            kind: kind,
            trackIndex: trackIndex,
            clipIndex: clipIndex,
            clip: String(trackItem.name),
            previousSpeed: currentSpeed,
            speed: afterSpeed,
            requestedSpeed: speed
        };
    }

    function captionFormatValue(name) {
        var raw = (name === undefined || name === null || name === '') ? 'subtitle' : String(name).toLowerCase();
        if (typeof Sequence === 'undefined') return null;
        if (raw === 'subtitle' || raw === 'subtitulo' || raw === 'subtítulos') return Sequence.CAPTION_FORMAT_SUBTITLE;
        if (raw === '608' || raw === 'cea608' || raw === 'cea-608') return Sequence.CAPTION_FORMAT_608;
        if (raw === '708' || raw === 'cea708' || raw === 'cea-708') return Sequence.CAPTION_FORMAT_708;
        if (raw === 'teletext') return Sequence.CAPTION_FORMAT_TELETEXT;
        if (raw === 'op42' || raw === 'op-42') return Sequence.CAPTION_FORMAT_OP42;
        if (raw === 'op47' || raw === 'op-47') return Sequence.CAPTION_FORMAT_OP47;
        if (raw === 'ebu' || raw === 'open-ebu') return Sequence.CAPTION_FORMAT_OPEN_EBU;
        return null;
    }

    function findImportedFile(fileName) {
        var wanted = String(fileName).toLowerCase();
        var found = null;
        function walk(bin) {
            if (found) return;
            for (var i = 0; i < bin.children.numItems; i++) {
                var child = bin.children[i];
                if (child.type === ProjectItemType.BIN) {
                    walk(child);
                    if (found) return;
                    continue;
                }
                if (String(child.name).toLowerCase() === wanted) {
                    found = child;
                    return;
                }
                try {
                    var mediaPath = String(child.getMediaPath());
                    if (mediaPath !== '' && mediaPath.toLowerCase().indexOf(wanted) >= 0) {
                        found = child;
                        return;
                    }
                } catch (ePath) {}
            }
        }
        walk(app.project.rootItem);
        return found;
    }

    function importSrt(p) {
        if (!p.path) return { ok: false, error: 'importSrt requiere path' };
        var srt = new File(nativePath(String(p.path)));
        if (!srt.exists) return { ok: false, error: 'SRT no existe: ' + p.path };
        var seq = getSequence(p.sequence);
        if (!seq) return { ok: false, error: 'secuencia no encontrada' };
        var fmt = captionFormatValue(p.format);
        if (fmt === null) return { ok: false, error: 'format de subtítulo inválido' };
        var targetBin = app.project.rootItem;
        if (p.bin) {
            targetBin = findBin(p.bin);
            if (!targetBin) return { ok: false, error: 'bin no encontrado: ' + p.bin };
        }
        try {
            app.project.importFiles([srt.fsName], true, targetBin, false);
        } catch (eImp) {
            return { ok: false, error: 'importFiles falló para el SRT: ' + String(eImp) };
        }
        var item = findImportedFile(srt.name);
        if (!item) return { ok: false, error: 'SRT importado pero no encontrado como ProjectItem' };
        var startAt = num(p.startAt, 0);
        var created = false;
        try {
            created = seq.createCaptionTrack(item, startAt, fmt);
        } catch (eCap) {
            return { ok: false, error: 'createCaptionTrack falló: ' + String(eCap), item: String(item.name) };
        }
        var ok = true;
        if (created === false) ok = false;
        return {
            ok: ok,
            sequence: seq.name,
            item: String(item.name),
            captionFormat: fmt,
            startAt: startAt,
            trackCreated: created === true
        };
    }

    function dispatch(params) {
        var out = { ok: false };
        try {
            var verb = params.verb;
            var p = params.params || {};
            if (verb === 'catalog') out = { ok: true, items: catalog(p.kind) };
            else if (verb === 'project') out = { ok: true, data: projectModel() };
            else if (verb === 'insert') out = insert(p.item, p.time, p.track);
            else if (verb === 'overwrite') out = overwrite(p.item, p.time, p.track);
            else if (verb === 'razor') out = razor(p.timecode, p.track);
            else if (verb === 'removeClip') out = removeClip(p.index, p.track);
            else if (verb === 'subclip') out = subclip(p.item, p.inSec, p.outSec, p.name);
            else if (verb === 'applyTransition') out = applyTransition(p.index, p.name, p.track);
            else if (verb === 'applyEffect') out = applyEffect(p.index, p.name, p.track);
            else if (verb === 'marker') out = marker(p.time, p.name);
            else if (verb === 'clearMarkers') out = clearMarkers();
            else if (verb === 'renderFrame') out = renderFrame(p);
            else if (verb === 'contactSheet') out = contactSheet(p);
            else if (verb === 'clipMotion') out = clipMotion(p);
            else if (verb === 'clipVolume') out = clipVolume(p);
            else if (verb === 'clipSpeed') out = clipSpeed(p);
            else if (verb === 'assemble') out = assemble(p);
            else if (verb === 'import') out = importMedia(p);
            else if (verb === 'bin') out = createBins(p);
            else if (verb === 'export') out = exportSequence(p);
            else if (verb === 'importSrt') out = importSrt(p);
            else if (verb === 'save' || verb === 'saveSafe') out = saveSafe(p);
            else out = { ok: false, error: 'verbo desconocido: ' + verb };
        } catch (e) {
            out = { ok: false, error: e.toString() };
        }
        return j(out);
    }

    return { dispatch: dispatch };
})();
