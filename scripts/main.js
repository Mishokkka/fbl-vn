import { VNEditorApp } from "./apps/vn-editor-app.js";
import { VNPlayerApp } from "./apps/vn-player-app.js";
import { VNSceneStore } from "./data/scene-store.js";
import { VNSocket } from "./playback/vn-socket.js";
import { validateScene } from "./data/schema.js";
import { MODULE_ID } from "./utils/constants.js";
let api = null;
let bootstrapped = false;
let settingsRegistered = false;
let menuRegistered = false;
let socketRegistered = false;
function renderApp(app) {
    return app.render(true);
}
function hasSetting(key) {
    var _a, _b, _c;
    return Boolean((_c = (_b = (_a = game.settings) === null || _a === void 0 ? void 0 : _a.settings) === null || _b === void 0 ? void 0 : _b.has) === null || _c === void 0 ? void 0 : _c.call(_b, `${MODULE_ID}.${key}`));
}
function hasMenu(key) {
    var _a, _b, _c;
    return Boolean((_c = (_b = (_a = game.settings) === null || _a === void 0 ? void 0 : _a.menus) === null || _b === void 0 ? void 0 : _b.has) === null || _c === void 0 ? void 0 : _c.call(_b, `${MODULE_ID}.${key}`));
}
function registerSettingsOnce() {
    if (settingsRegistered) return;
    VNSceneStore.registerSettings();
    settingsRegistered = true;
}
function registerMenuOnce() {
    if (menuRegistered || hasMenu("editor")) {
        menuRegistered = true;
        return;
    }
    try {
        game.settings.registerMenu(MODULE_ID, "editor", {
            name: "Редактор VN-катсцен",
            label: "Открыть редактор VN-катсцен",
            hint: "Создание, проверка и синхронное воспроизведение полноэкранных катсцен в стиле визуальных новелл.",
            icon: "fa-solid fa-film",
            type: VNEditorApp,
            restricted: true
        });
        menuRegistered = true;
    }
    catch (error) {
        console.warn(`${MODULE_ID} | Settings menu registration failed. Macro API is still available.`, error);
    }
}
function registerSocketOnce() {
    if (socketRegistered)
        return;
    if (typeof game.socket?.on !== "function" || typeof game.socket?.emit !== "function") {
        throw new Error("Foundry module socket is unavailable during VN initialization.");
    }
    VNSocket.registerHandlers({
        open: payload => VNPlayerApp.openScene(payload),
        start: payload => VNPlayerApp.startScene(payload.sceneId),
        advance: payload => VNPlayerApp.advanceScene(payload.sceneId, payload.frameId, payload.textIndex, { choiceId: payload.choiceId || "" }),
        close: payload => VNPlayerApp.closeScene(payload.sceneId),
        vote: (payload, senderId) => VNPlayerApp.recordVote(payload, senderId),
        voteState: payload => VNPlayerApp.updateVoteState(payload),
        userConnected: (user, connected) => VNPlayerApp.handleUserConnection(user, connected),
        getSyncState: sceneId => VNPlayerApp.getSyncState(sceneId),
        ready: () => { }
    });
    socketRegistered = true;
}

function requireGmAction(actionName) {
    if (game.user && game.user.isGM)
        return true;
    if (ui.notifications && ui.notifications.warn)
        ui.notifications.warn(`VN: ${actionName} доступно только ГМу.`);
    return false;
}


function sceneHasBlockingErrors(scene) {
    const errors = validateScene(scene).filter(issue => issue.severity === "error");
    if (!errors.length) return false;
    ui.notifications?.error?.(`VN: катсцена содержит ${errors.length} ошибок и не может быть запущена.`);
    console.warn(`${MODULE_ID} | Blocked invalid cutscene launch.`, errors);
    return true;
}

function installApi() {
    var _a, _b;
    api = {
        __runtime: true,
        openEditor: (options = {}) => {
            if (!requireGmAction("редактор"))
                return null;
            return renderApp(new VNEditorApp(options));
        },
        play: async (sceneId, options = {}) => {
            var _a;
            if (!requireGmAction("запуск катсцены"))
                return null;
            const scene = VNSceneStore.getScene(sceneId);
            if (!scene) {
                ui.notifications?.warn(`VN: катсцена не найдена: ${sceneId}`);
                return null;
            }
            if (sceneHasBlockingErrors(scene)) return null;
            return VNSocket.openForPlayers(scene, options);
        },
        preview: async (sceneId) => {
            var _a;
            if (!requireGmAction("предпросмотр"))
                return null;
            const scene = VNSceneStore.getScene(sceneId);
            if (!scene) {
                ui.notifications?.warn(`VN: катсцена не найдена: ${sceneId}`);
                return null;
            }
            if (sceneHasBlockingErrors(scene)) return null;
            const app = await VNPlayerApp.openScene({ scene, mode: scene.defaultMode, leaderId: game.user.id, networked: false });
            if (!app) return null;
            await app.preload();
            await app.start();
            return app;
        },
        getScenes: () => game.user?.isGM ? VNSceneStore.scenes : [],
        getScene: sceneId => game.user?.isGM ? VNSceneStore.getScene(sceneId) : null,
        store: game.user?.isGM ? VNSceneStore : null,
        diagnostics: () => {
            var _a, _b, _c, _d, _e, _f, _g, _h;
            return ({
                moduleId: MODULE_ID,
                runtime: true,
                bootstrapped,
                settingsRegistered,
                menuRegistered,
                socketRegistered,
                active: (_d = (_c = (_b = (_a = game.modules) === null || _a === void 0 ? void 0 : _a.get) === null || _b === void 0 ? void 0 : _b.call(_a, MODULE_ID)) === null || _c === void 0 ? void 0 : _c.active) !== null && _d !== void 0 ? _d : null,
                version: (_h = (_g = (_f = (_e = game.modules) === null || _e === void 0 ? void 0 : _e.get) === null || _f === void 0 ? void 0 : _f.call(_e, MODULE_ID)) === null || _g === void 0 ? void 0 : _g.version) !== null && _h !== void 0 ? _h : null,
                scenes: game.user?.isGM ? VNSceneStore.scenes.length : null
            });
        }
    };
    game.fblVN = api;
    globalThis.fblVN = api;
    const module = (_b = (_a = game.modules) === null || _a === void 0 ? void 0 : _a.get) === null || _b === void 0 ? void 0 : _b.call(_a, MODULE_ID);
    if (module)
        module.api = api;
    return api;
}
export async function bootstrapFblVN() {
    var _a;
    if (bootstrapped)
        return installApi();
    registerSettingsOnce();
    registerMenuOnce();
    installApi();
    const readySetup = async () => {
        await VNSceneStore.initializeStorage();
        registerSocketOnce();
    };
    if (game.ready)
        await readySetup();
    else
        Hooks.once("ready", () => {
            void readySetup().catch(error => {
                console.error(`${MODULE_ID} | Ready initialization failed.`, error);
                ui.notifications?.error?.("VN: инициализация модуля завершилась ошибкой. Подробности записаны в консоль.");
            });
        });
    bootstrapped = true;
    if ((_a = game.user) === null || _a === void 0 ? void 0 : _a.isGM)
        console.log(`${MODULE_ID} | Runtime ready. Macro: game.fblVN.openEditor()`);
    return api;
}
export function getFblVNApi() {
    if (!api)
        installApi();
    return api;
}
if (globalThis.game) {
    const runBootstrap = () => {
        void bootstrapFblVN().catch(error => console.error(`${MODULE_ID} | Bootstrap failed.`, error));
    };
    if (game.ready)
        runBootstrap();
    else if (globalThis.Hooks?.events?.init)
        runBootstrap();
}
