/**
 * Studio Bridge — allowlist de acciones del panel CEP.
 * ES5 puro: lo carga Adobe CEP y los tests lo evalúan con `vm`.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.StudioBridgeActions = api;
    }
}(typeof self !== 'undefined' ? self : this, function () {
    var ACTIONS = {
        evalScript: true,
        evalCustom: true,
        toolkit: true,
        toolkit_ae: true,
        getProjectSnapshot: true,
        getTimelineInfo: true,
        getSummary: true
    };

    var MACROS = {
        cutAtPlayhead: true,
        addMarker: true,
        applySmartZoom: true,
        create3DCameraWithZoom: true,
        applyFlashTransitions: true
    };

    function has(collection, name) {
        return typeof name === 'string' && Object.prototype.hasOwnProperty.call(collection, name);
    }

    function isAllowedAction(name) {
        return has(ACTIONS, name);
    }

    function isAllowedMacro(name) {
        return has(MACROS, name);
    }

    return {
        ACTIONS: ACTIONS,
        MACROS: MACROS,
        isAllowedAction: isAllowedAction,
        isAllowedMacro: isAllowedMacro
    };
}));
