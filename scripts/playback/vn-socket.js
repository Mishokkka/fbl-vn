import { MODULE_ID, PLAYER_MODES, SETTINGS, SOCKET_NAME } from "../utils/constants.js";
import { wait } from "../utils/foundry-helpers.js";

export class VNSocket {
    static registerHandlers(handlers) {
        this.handlers = handlers ?? {};
        game.socket.on(SOCKET_NAME, payload => this._onMessage(payload));
    }

    static emit(type, data = {}) {
        game.socket.emit(SOCKET_NAME, {
            type,
            senderId: game.user.id,
            timestamp: Date.now(),
            data
        });
    }

    static _onMessage(payload) {
        if (!payload || payload.senderId === game.user.id) return;
        const { type, data = {}, senderId } = payload;
        if (!this._isTargeted(data)) return;
        switch (type) {
            case "open":
            case "start":
            case "advance":
            case "close":
            case "voteState": {
                if (!this._isTrustedGmSender(senderId)) {
                    console.warn(`${MODULE_ID} | Ignored untrusted socket command: ${type}`, payload);
                    return;
                }
                this._dispatchTrustedCommand(type, data, senderId);
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
        switch (type) {
            case "open":
                this.handlers.open?.(data, senderId);
                break;
            case "start":
                this.handlers.start?.(data, senderId);
                break;
            case "advance":
                this.handlers.advance?.(data, senderId);
                break;
            case "close":
                this.handlers.close?.(data, senderId);
                break;
            case "voteState":
                this.handlers.voteState?.(data, senderId);
                break;
        }
    }

    static _isTrustedGmSender(senderId) {
        const sender = game.users?.get?.(senderId);
        return Boolean(sender?.isGM);
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
        return targetIds.length ? Object.assign({}, data, { targetIds }) : data;
    }

    static signalReady(sceneId) {
        this.emit("ready", { sceneId, userId: game.user.id });
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
            .filter(user => user.active && user.id !== game.user.id)
            .map(user => user.id);
    }

    static async openForPlayers(scene, { mode = null } = {}) {
        if (!Object.values(PLAYER_MODES).includes(mode)) mode = Object.values(PLAYER_MODES).includes(scene?.defaultMode) ? scene.defaultMode : PLAYER_MODES.INDIVIDUAL;
        if (!game.user.isGM) {
            ui.notifications?.warn("VN: запуск катсцен доступен только ГМу.");
            return;
        }
        const targetIds = this.getTargetUserIds();
        const participantIds = mode === PLAYER_MODES.VOTE ? [game.user.id, ...targetIds] : [game.user.id, ...targetIds];
        this.activeTargets.set(scene.id, new Set(targetIds));
        this.activeParticipants.set(scene.id, new Set(participantIds));
        this.clearReady(scene.id, targetIds);
        this.emit("open", {
            scene,
            sceneId: scene.id,
            mode,
            leaderId: game.user.id,
            targetIds,
            participantIds
        });
        this.handlers.open?.({ scene, sceneId: scene.id, mode, leaderId: game.user.id, targetIds, participantIds, local: true }, game.user.id);
        const maxWait = Number(game.settings.get(MODULE_ID, SETTINGS.PRELOAD_WAIT_MS) ?? 10000);
        const started = Date.now();
        while (targetIds.length && Date.now() - started < maxWait) {
            const ready = this.ready.get(scene.id) ?? new Set();
            if (targetIds.every(id => ready.has(id))) break;
            await wait(250);
        }
        const readyCount = this.getReadyCount(scene.id);
        ui.notifications?.info(`VN: предзагрузка завершена у ${readyCount}/${targetIds.length} клиентов. Запускаю катсцену.`);
        this.emit("start", this._withSceneTargets(scene.id, { sceneId: scene.id }));
        this.handlers.start?.({ sceneId: scene.id }, game.user.id);
    }

    static advance(sceneId, frameId, textIndex = 0, options = {}) {
        const data = { sceneId, frameId, textIndex };
        if (options && options.choiceId) data.choiceId = options.choiceId;
        this.emit("advance", this._withSceneTargets(sceneId, data));
    }

    static submitVote(sceneId, vote, leaderId = null) {
        const data = Object.assign({ sceneId }, vote || {});
        if (leaderId) data.targetIds = [leaderId];
        if (game.user?.isGM) {
            this.handlers.vote?.(data, game.user.id);
            return;
        }
        this.emit("vote", data);
    }

    static broadcastVoteState(sceneId, state = {}) {
        const data = this._withSceneTargets(sceneId, Object.assign({ sceneId }, state));
        this.emit("voteState", data);
        this.handlers.voteState?.(Object.assign({ sceneId }, state), game.user.id);
    }

    static close(sceneId) {
        const data = this._withSceneTargets(sceneId, { sceneId });
        this.emit("close", data);
        this.handlers.close?.({ sceneId }, game.user.id);
        this.activeTargets.delete(sceneId);
        this.activeParticipants.delete(sceneId);
        this.ready.delete(sceneId);
        this.readyTargets.delete(sceneId);
    }
}

VNSocket.handlers = {};
VNSocket.ready = new Map();
VNSocket.readyTargets = new Map();
VNSocket.activeTargets = new Map();
VNSocket.activeParticipants = new Map();
