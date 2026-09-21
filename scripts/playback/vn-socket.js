import { MODULE_ID, PLAYER_MODES, SETTINGS, SOCKET_NAME } from "../utils/constants.js";
import { wait } from "../utils/foundry-helpers.js";

export class VNSocket {
    static registerHandlers(handlers) {
        this.handlers = handlers ?? {};
        if (!this._socketMessageHandler) {
            if (typeof game.socket?.on !== "function") throw new Error("Foundry module socket is unavailable.");
            const socketMessageHandler = payload => this._onMessage(payload);
            game.socket.on(SOCKET_NAME, socketMessageHandler);
            this._socketMessageHandler = socketMessageHandler;
        }
        if (!this._userConnectedHookId) {
            this._userConnectedHookId = Hooks.on("userConnected", (user, connected) => this._onUserConnected(user, connected));
        }
    }

    static emit(type, data = {}) {
        const senderId = game.user?.id;
        if (!senderId || typeof game.socket?.emit !== "function") {
            console.warn(`${MODULE_ID} | Socket emit skipped because the Foundry socket or current user is unavailable.`, { type });
            return false;
        }
        game.socket.emit(SOCKET_NAME, {
            type,
            timestamp: Date.now(),
            senderId,
            data
        });
        return true;
    }

    static _onMessage(payload) {
        if (!payload || typeof payload !== "object") return;
        const senderId = payload.senderId;
        if (!senderId || senderId === game.user?.id) return;
        const { type, data = {} } = payload;
        if (typeof type !== "string" || !data || typeof data !== "object") return;
        if (!this._isTargeted(data)) return;
        switch (type) {
            case "open":
            case "start":
            case "advance":
            case "close":
            case "voteState": {
                if (!this._isTrustedGmCommand(type, data, senderId)) {
                    console.warn(`${MODULE_ID} | Ignored untrusted socket command: ${type}`, payload);
                    return;
                }
                if (type === "open" && data.sceneId) this.activeLeaders.set(data.sceneId, senderId);
                this._dispatchTrustedCommand(type, data, senderId);
                if (type === "close" && data.sceneId) this.activeLeaders.delete(data.sceneId);
                break;
            }
            case "ready":
                if (!game.user?.isGM) return;
                this._recordReady(data, senderId);
                this.handlers.ready?.(data, senderId);
                break;
            case "vote":
                if (!game.user?.isGM) return;
                this.handlers.vote?.(data, senderId);
                break;
            default:
                console.warn(`${MODULE_ID} | Unknown socket payload`, payload);
        }
    }

    static _dispatchTrustedCommand(type, data, senderId) {
        const handler = this.handlers[type];
        if (typeof handler !== "function") return;
        Promise.resolve(handler(data, senderId)).catch(error => {
            console.error(`${MODULE_ID} | Socket handler failed: ${type}`, error);
        });
    }

    static _isTrustedGmCommand(type, data, senderId) {
        const sender = game.users?.get?.(senderId);
        if (!sender?.isGM) return false;
        const sceneId = data?.sceneId || data?.scene?.id || "";
        if (!sceneId) return false;
        const currentLeaderId = this.activeLeaders.get(sceneId);
        if (type === "open") {
            if (!currentLeaderId || currentLeaderId === senderId) return true;
            const currentLeader = game.users?.get?.(currentLeaderId);
            return currentLeader?.active !== true;
        }
        return Boolean(currentLeaderId && currentLeaderId === senderId);
    }

    static _isTargeted(data) {
        const targetIds = Array.isArray(data?.targetIds) ? data.targetIds : [];
        if (!targetIds.length) return true;
        return targetIds.includes(game.user.id);
    }

    static _targetIdsForScene(sceneId) {
        const targets = this.activeTargets.get(sceneId);
        return targets && targets.size ? [...targets] : [];
    }

    static _participantIdsForScene(sceneId) {
        const participants = this.activeParticipants.get(sceneId);
        if (participants && participants.size) return [...participants];
        const targetIds = this._targetIdsForScene(sceneId);
        return targetIds.length ? [game.user.id, ...targetIds] : [game.user.id];
    }

    static _withSceneTargets(sceneId, data = {}) {
        const targetIds = this._targetIdsForScene(sceneId);
        const leaderId = this.activeLeaders.get(sceneId) || game.user?.id || null;
        const payload = Object.assign({}, data, { leaderId });
        return targetIds.length ? Object.assign(payload, { targetIds }) : payload;
    }

    static signalReady(sceneId, leaderId = null) {
        const data = { sceneId, userId: game.user.id };
        if (leaderId && leaderId !== game.user.id) data.targetIds = [leaderId];
        this.emit("ready", data);
    }

    static _recordReady(data, senderId) {
        const sceneId = data?.sceneId;
        if (!sceneId || !this.ready.has(sceneId)) return;
        const userId = senderId;
        const targets = this.readyTargets.get(sceneId);
        if (targets && targets.size && !targets.has(userId)) return;
        this.ready.get(sceneId).add(userId);
    }

    static clearReady(sceneId, targetIds = []) {
        this.ready.set(sceneId, new Set());
        this.readyTargets.set(sceneId, new Set(targetIds));
    }

    static getReadyCount(sceneId) {
        return this.ready.get(sceneId)?.size ?? 0;
    }

    static getTargetUserIds() {
        return game.users
            .filter(user => user.active && !user.isGM && user.id !== game.user.id)
            .map(user => user.id);
    }

    static async openForPlayers(scene, { mode = null } = {}) {
        if (!game.user.isGM) {
            ui.notifications?.warn("VN: запуск катсцен доступен только ГМу.");
            return;
        }
        if (!Object.values(PLAYER_MODES).includes(mode)) mode = Object.values(PLAYER_MODES).includes(scene?.defaultMode) ? scene.defaultMode : PLAYER_MODES.INDIVIDUAL;
        if (!scene?.id) {
            ui.notifications?.warn("VN: нельзя запустить катсцену без ID.");
            return;
        }
        if (this._launchInProgress) {
            ui.notifications?.warn("VN: предыдущий запуск катсцены ещё выполняется.");
            return;
        }
        this._launchInProgress = true;
        try {
            for (const existingSceneId of [...this.activeSessions.keys()]) {
                this.close(existingSceneId);
            }
            const targetIds = this.getTargetUserIds();
            const participantIds = [game.user.id, ...targetIds];
            this.activeTargets.set(scene.id, new Set(targetIds));
            this.activeParticipants.set(scene.id, new Set(participantIds));
            this.activeLeaders.set(scene.id, game.user.id);
            this.activeSessions.set(scene.id, { scene, mode, leaderId: game.user.id, targetIds: [...targetIds], participantIds: [...participantIds], started: false });
            this.clearReady(scene.id, targetIds);
            this.emit("open", {
                scene,
                sceneId: scene.id,
                mode,
                leaderId: game.user.id,
                targetIds,
                participantIds
            });
            const localApp = await Promise.resolve(this.handlers.open?.({ scene, sceneId: scene.id, mode, leaderId: game.user.id, targetIds, participantIds, local: true }, game.user.id));
            const localPreload = localApp?.preload?.();
            const configuredWait = Number(game.settings.get(MODULE_ID, SETTINGS.PRELOAD_WAIT_MS) ?? 10000);
            const maxWait = Number.isFinite(configuredWait) ? Math.max(0, configuredWait) : 10000;
            const started = Date.now();
            while (targetIds.length && Date.now() - started < maxWait) {
                const ready = this.ready.get(scene.id) ?? new Set();
                const connectedTargets = targetIds.filter(id => game.users?.get?.(id)?.active);
                if (connectedTargets.every(id => ready.has(id))) break;
                await wait(250);
            }
            if (localPreload) await localPreload;
            const readyCount = this.getReadyCount(scene.id);
            ui.notifications?.info(`VN: предзагрузка завершена у ${readyCount}/${targetIds.length} клиентов. Запускаю катсцену.`);
            const session = this.activeSessions.get(scene.id);
            if (!session) return;
            session.started = true;
            this.emit("start", this._withSceneTargets(scene.id, { sceneId: scene.id }));
            await Promise.resolve(this.handlers.start?.({ sceneId: scene.id, leaderId: game.user.id }, game.user.id));
        }
        catch (error) {
            console.error(`${MODULE_ID} | Failed to launch cutscene.`, error);
            if (scene?.id) this.close(scene.id);
            ui.notifications?.error?.("VN: запуск катсцены завершился ошибкой. Подробности записаны в консоль.");
            throw error;
        }
        finally {
            this._launchInProgress = false;
        }
    }

    static advance(sceneId, frameId, textIndex = 0, options = {}) {
        const data = { sceneId, frameId, textIndex };
        if (options && options.choiceId) data.choiceId = options.choiceId;
        if (options?.reenter === true) data.reenter = true;
        this.emit("advance", this._withSceneTargets(sceneId, data));
    }

    static submitVote(sceneId, vote, leaderId = null) {
        const data = Object.assign({ sceneId }, vote || {});
        if (leaderId) data.targetIds = [leaderId];
        if (game.user?.isGM && (!leaderId || leaderId === game.user.id)) {
            Promise.resolve(this.handlers.vote?.(data, game.user.id)).catch(error => {
                console.error(`${MODULE_ID} | Local vote handler failed.`, error);
            });
            return;
        }
        this.emit("vote", data);
    }

    static broadcastVoteState(sceneId, state = {}) {
        const data = this._withSceneTargets(sceneId, Object.assign({ sceneId }, state));
        this.emit("voteState", data);
        Promise.resolve(this.handlers.voteState?.(Object.assign({ sceneId }, state), game.user.id)).catch(error => {
            console.error(`${MODULE_ID} | Local vote-state handler failed.`, error);
        });
    }

    static close(sceneId) {
        const data = this._withSceneTargets(sceneId, { sceneId });
        this.emit("close", data);
        Promise.resolve(this.handlers.close?.({ sceneId, leaderId: game.user.id }, game.user.id)).catch(error => {
            console.error(`${MODULE_ID} | Local close handler failed.`, error);
        });
        this.activeTargets.delete(sceneId);
        this.activeParticipants.delete(sceneId);
        this.activeLeaders.delete(sceneId);
        this.activeSessions.delete(sceneId);
        this.ready.delete(sceneId);
        this.readyTargets.delete(sceneId);
    }

    static _onUserConnected(user, connected) {
        Promise.resolve(this.handlers.userConnected?.(user, connected)).catch(error => {
            console.error(`${MODULE_ID} | userConnected handler failed.`, error);
        });
        if (!connected || !game.user?.isGM || !user || user.isGM) return;
        for (const [sceneId, session] of this.activeSessions.entries()) {
            if (session.leaderId !== game.user.id || !session.targetIds.includes(user.id)) continue;
            const resumeState = this.handlers.getSyncState?.(sceneId) || null;
            this.emit("open", {
                scene: session.scene,
                sceneId,
                mode: session.mode,
                leaderId: session.leaderId,
                targetIds: [user.id],
                participantIds: session.participantIds,
                resumeState: session.started ? resumeState : null
            });
        }
    }
}

VNSocket.handlers = {};
VNSocket.ready = new Map();
VNSocket.readyTargets = new Map();
VNSocket.activeTargets = new Map();
VNSocket.activeParticipants = new Map();
VNSocket.activeLeaders = new Map();
VNSocket.activeSessions = new Map();
VNSocket._socketMessageHandler = null;
VNSocket._userConnectedHookId = null;
VNSocket._launchInProgress = false;
