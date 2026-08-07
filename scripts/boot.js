(() => {
    const MODULE_ID = "fbl-vn-cutscenes";
    const state = {
        loaded: false,
        loading: null,
        error: null,
        module: null
    };
    function moduleUrl(path) {
        var _a, _b, _c, _d;
        const current = (_b = (_a = document.currentScript) === null || _a === void 0 ? void 0 : _a.src) !== null && _b !== void 0 ? _b : `${(_d = (_c = globalThis.location) === null || _c === void 0 ? void 0 : _c.origin) !== null && _d !== void 0 ? _d : ""}/modules/${MODULE_ID}/scripts/boot.js`;
        return new URL(path, current).href;
    }
    function reportError(error) {
        var _a, _b;
        state.error = error;
        console.error(`${MODULE_ID} | Failed to load runtime`, error);
        try {
            (_b = (_a = ui === null || ui === void 0 ? void 0 : ui.notifications) === null || _a === void 0 ? void 0 : _a.error) === null || _b === void 0 ? void 0 : _b.call(_a, `VN: модуль не загрузил runtime. Смотри консоль.`);
        }
        catch (_error) {
            // UI may not exist yet during early boot.
        }
    }
    async function loadRuntime() {
        if (state.loaded && state.module)
            return state.module;
        if (!state.loading) {
            state.loading = import(moduleUrl("./main.js"))
                .then(async (module) => {
                state.module = module;
                if (typeof module.bootstrapFblVN === "function")
                    await module.bootstrapFblVN();
                state.loaded = true;
                state.error = null;
                return module;
            })
                .catch(error => {
                reportError(error);
                throw error;
            });
        }
        return state.loading;
    }
    function installStub() {
        const existing = game === null || game === void 0 ? void 0 : game.fblVN;
        if (existing === null || existing === void 0 ? void 0 : existing.__runtime)
            return;
        const stub = {
            __stub: true,
            openEditor: async (...args) => {
                const module = await loadRuntime();
                return module.getFblVNApi().openEditor(...args);
            },
            play: async (...args) => {
                const module = await loadRuntime();
                return module.getFblVNApi().play(...args);
            },
            preview: async (...args) => {
                const module = await loadRuntime();
                return module.getFblVNApi().preview(...args);
            },
            getScenes: (...args) => {
                if (!state.loaded || !state.module)
                    return [];
                return state.module.getFblVNApi().getScenes(...args);
            },
            getScene: (...args) => {
                if (!state.loaded || !state.module)
                    return null;
                return state.module.getFblVNApi().getScene(...args);
            },
            diagnostics: () => {
                var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p;
                return ({
                    moduleId: MODULE_ID,
                    bootScript: (_b = (_a = document.currentScript) === null || _a === void 0 ? void 0 : _a.src) !== null && _b !== void 0 ? _b : null,
                    loaded: state.loaded,
                    loading: Boolean(state.loading),
                    error: state.error ? String((_f = (_d = (_c = state.error) === null || _c === void 0 ? void 0 : _c.stack) !== null && _d !== void 0 ? _d : (_e = state.error) === null || _e === void 0 ? void 0 : _e.message) !== null && _f !== void 0 ? _f : state.error) : null,
                    runtimeUrl: moduleUrl("./main.js"),
                    moduleActive: (_k = (_j = (_h = (_g = game === null || game === void 0 ? void 0 : game.modules) === null || _g === void 0 ? void 0 : _g.get) === null || _h === void 0 ? void 0 : _h.call(_g, MODULE_ID)) === null || _j === void 0 ? void 0 : _j.active) !== null && _k !== void 0 ? _k : null,
                    moduleVersion: (_p = (_o = (_m = (_l = game === null || game === void 0 ? void 0 : game.modules) === null || _l === void 0 ? void 0 : _l.get) === null || _m === void 0 ? void 0 : _m.call(_l, MODULE_ID)) === null || _o === void 0 ? void 0 : _o.version) !== null && _p !== void 0 ? _p : null
                });
            }
        };
        game.fblVN = stub;
        globalThis.fblVN = stub;
    }
    function boot() {
        installStub();
        loadRuntime().catch(() => { });
    }
    if (globalThis.game)
        installStub();
    Hooks.once("init", boot);
    Hooks.once("ready", () => {
        installStub();
        loadRuntime().catch(() => { });
    });
    console.log(`${MODULE_ID} | Boot script registered. Macro: game.fblVN.openEditor()`);
})();
