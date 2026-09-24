import { applyChoiceCounterEffect, applyFrameCounterEffect, getInitialCounterState, getFrameTextBlocks, getTextBlock, isChoiceAvailable, resolveFrameNextRouting } from "../data/schema.js";
import { VNPreloadController, VNPreloader } from "../playback/vn-preloader.js";
import { VNAudioController } from "../playback/vn-audio.js";
import { VNSocket } from "../playback/vn-socket.js";
import { AUDIO_ACTIONS, MODULE_ID, PLAYER_MODES, SETTINGS, TEXT_PRESENTATIONS, VIGNETTE_MODES } from "../utils/constants.js";
import { notifyWarn } from "../utils/foundry-helpers.js";
import { richTextFromPlainText, richTextToPlainText, sanitizeRichTextHtml, splitTextGraphemes } from "../utils/rich-text.js";

const ApplicationV2 = foundry.applications.api.ApplicationV2;
const HandlebarsApplicationMixin = foundry.applications.api.HandlebarsApplicationMixin;

function createVisualState() {
    return {
        background: "",
        portrait: "",
        portraitPosition: "left"
    };
}

function uniqueIds(ids) {
    return [...new Set((Array.isArray(ids) ? ids : []).filter(id => typeof id === "string" && id))];
}

function getNumberSetting(key, fallback = 1) {
    try {
        const value = game.settings?.get?.(MODULE_ID, key);
        if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.min(1, value));
    }
    catch (_error) {
        return fallback;
    }
    return fallback;
}

export class VNPlayerApp extends HandlebarsApplicationMixin(ApplicationV2) {
    constructor(options = {}) {
        super(options);
        this.scene = options.scene;
        this._buildPlaybackIndex();
        this.mode = options.mode !== undefined ? options.mode : PLAYER_MODES.INDIVIDUAL;
        this.leaderId = options.leaderId !== undefined ? options.leaderId : null;
        this.networked = options.networked === true;
        this.framePreview = options.framePreview === true;
        const suppliedParticipantIds = Array.isArray(options.participantIds) ? options.participantIds : null;
        this.participantIds = uniqueIds(suppliedParticipantIds ?? [game.user.id]);
        this.loading = true;
        this.started = false;
        this._starting = false;
        this._resuming = false;
        this.preloadDone = 0;
        this.preloadTotal = 0;
        this.currentFrameId = null;
        this.currentTextIndex = 0;
        this.visualState = createVisualState();
        this.audio = new VNAudioController();
        this.counterState = getInitialCounterState(this.scene);
        this._typingRaf = null;
        this._typingText = "";
        this._typingKey = "";
        this._typingNode = null;
        this._typingComplete = true;
        this._keyboardElement = null;
        this._onKeyboardKeydown = event => {
            if (event.repeat || this._isKeyboardControlTarget(event.target)) return;
            if (event.key === "Escape" && this._canCloseLocally()) {
                event.preventDefault();
                void this.requestClose();
                return;
            }
            if ((event.key === " " || event.key === "Enter") && this.started) {
                event.preventDefault();
                void this.next();
            }
        };
        this._onWindowResize = () => this._applyFullscreenPosition();
        this._resizeBound = false;
        this._preloadPromise = null;
        this._preloader = new VNPreloadController(this.scene);
        this._backgroundPreloadPromise = null;
        this._disposed = false;
        this._preloadProgressRaf = null;
        this._pendingPreloadProgress = null;
        this._pendingRemoteFrames = VNPlayerApp.pendingAdvances.get(this.scene.id) || [];
        this._playbackQueue = Promise.resolve();
        this._volumePanelOpen = false;
        this._contentHidden = false;
        this._volumeSaveTimer = null;
        this._pendingVolumeSettings = new Map();
        this._localVolumeValues = new Map();
        this._localVote = null;
        this._voteState = this._emptyVoteState();
        this._leaderVoteStep = "";
        this._leaderVotes = new Map();
        this._participantConnectionState = new Map();
        this._resolvingVote = false;
        this._interactionBusy = false;
        this._finishing = false;
        VNPlayerApp.pendingAdvances.delete(this.scene.id);
        VNPlayerApp.active.set(this.scene.id, this);
    }

    _buildPlaybackIndex() {
        const frames = this.scene && Array.isArray(this.scene.frames) ? this.scene.frames : [];
        this._frameById = new Map(frames.map(frame => [frame.id, frame]));
        this._nextSequentialById = new Map();
        this._choiceByIdByFrame = new Map();
        const previousByBranch = new Map();
        for (const frame of frames) {
            const branchId = frame.branchId || "";
            const previous = previousByBranch.get(branchId);
            if (previous) this._nextSequentialById.set(previous.id, frame.id);
            previousByBranch.set(branchId, frame);
            this._choiceByIdByFrame.set(frame.id, new Map((Array.isArray(frame.choices) ? frame.choices : []).map(choice => [choice.id, choice])));
        }
    }

    _getFrame(frameId = null) {
        if (frameId) return this._frameById.get(frameId) || null;
        return this._frameById.get(this.scene?.startFrame) || (this.scene?.frames?.[0] ?? null);
    }

    _getNextFrameId(frame) {
        if (!frame || frame.isFinal === true) return null;
        const routing = resolveFrameNextRouting(frame, this.counterState);
        if (routing.enabled) {
            if (routing.frameId && this._frameById.has(routing.frameId)) return routing.frameId;
            return this._nextSequentialById.get(frame.id) || null;
        }
        if (frame.next && this._frameById.has(frame.next)) return frame.next;
        return this._nextSequentialById.get(frame.id) || null;
    }

    _getChoice(frameId, choiceId) {
        return this._choiceByIdByFrame.get(frameId)?.get(choiceId) || null;
    }

    _isLeader() {
        return Boolean(this.leaderId && game.user?.id === this.leaderId);
    }

    _isKeyboardControlTarget(target) {
        return Boolean(target?.closest?.("button, input, select, textarea, a, [contenteditable='true'], [role='button'], .fbl-vn-volume-panel, .fbl-vn-volume-widget"));
    }

    _isGmVoteOverride() {
        return Boolean(this.mode === PLAYER_MODES.VOTE && this._isLeader() && game.user?.isGM);
    }

    _voteParticipantIds() {
        return this.participantIds.filter(id => {
            if (id === game.user?.id) return game.user?.isGM !== true;
            const user = game.users?.get?.(id);
            return user ? user.isGM !== true : true;
        });
    }

    _activeParticipantIds() {
        const ids = this.mode === PLAYER_MODES.VOTE ? this._voteParticipantIds() : this.participantIds;
        return ids.filter(id => {
            if (this._participantConnectionState?.has(id)) return this._participantConnectionState.get(id) === true;
            if (id === game.user?.id) return game.user?.active !== false;
            const user = game.users?.get?.(id);
            return Boolean(user?.active);
        });
    }

    _prefersReducedMotion() {
        const disabled = (() => {
            try { return game.settings?.get?.(MODULE_ID, SETTINGS.DISABLE_TRANSITIONS) === true; }
            catch (_error) { return false; }
        })();
        return disabled || Boolean(globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
    }

    _instantTextEnabled() {
        try { return game.settings?.get?.(MODULE_ID, SETTINGS.INSTANT_TEXT) === true; }
        catch (_error) { return false; }
    }

    static async openScene(payload) {
        if (!payload || !payload.scene) return;
        const scene = payload.scene;
        VNPlayerApp.clearRejoinOffer(scene.id);
        for (const app of [...VNPlayerApp.active.values()]) {
            await app.close({ force: true });
        }
        const app = new VNPlayerApp({
            scene,
            mode: payload.mode !== undefined ? payload.mode : PLAYER_MODES.INDIVIDUAL,
            leaderId: payload.leaderId !== undefined ? payload.leaderId : null,
            participantIds: payload.participantIds || [],
            networked: payload.networked === true || Array.isArray(payload.targetIds)
        });
        await app.render(true);
        if (payload.resumeState) {
            await app.preload({
                frameId: payload.resumeState.currentFrameId || "",
                extraPaths: [
                    payload.resumeState.visualState?.background || "",
                    payload.resumeState.visualState?.portrait || ""
                ]
            });
            await app.resume(payload.resumeState);
        }
        else {
            void app.preload().catch(error => {
                console.error(`${MODULE_ID} | Cutscene preload failed.`, error);
                notifyWarn("VN: предзагрузка катсцены завершилась ошибкой. Подробности записаны в консоль.");
            });
        }
        return app;
    }

    static async previewFrame(scene, frameId, options = {}) {
        if (!scene || !frameId) return null;
        for (const app of [...VNPlayerApp.active.values()]) {
            await app.close({ force: true });
        }
        const app = new VNPlayerApp({
            scene,
            mode: PLAYER_MODES.INDIVIDUAL,
            leaderId: game.user.id,
            networked: false,
            framePreview: true
        });
        await app.render(true);
        await app.preload({ frameId });
        await app.startFramePreview(frameId, { branchId: options.branchId || "" });
        return app;
    }

    static startScene(sceneId) {
        const app = VNPlayerApp.active.get(sceneId);
        if (!app) {
            VNPlayerApp.pendingStarts.add(sceneId);
            return;
        }
        return app.start();
    }

    static advanceScene(sceneId, frameId, textIndex = 0, options = {}) {
        const app = VNPlayerApp.active.get(sceneId);
        if (!app) {
            const queued = VNPlayerApp.pendingAdvances.get(sceneId) || [];
            queued.push({ frameId, textIndex, options });
            VNPlayerApp.pendingAdvances.set(sceneId, queued);
            return;
        }
        if (app.loading || !app.started || app._starting || app._resuming) {
            app._pendingRemoteFrames.push({ frameId, textIndex, options });
            return;
        }
        return app._enqueuePlaybackOperation(() => app._applyRemoteAdvance(frameId, textIndex, options));
    }

    static closeScene(sceneId) {
        VNPlayerApp.clearRejoinOffer(sceneId);
        VNPlayerApp.pendingStarts.delete(sceneId);
        VNPlayerApp.pendingAdvances.delete(sceneId);
        const app = VNPlayerApp.active.get(sceneId);
        if (app) return app.close({ force: true });
    }

    static offerRejoin(scene, leaderId) {
        if (!scene?.id || game.user?.isGM) return;
        VNPlayerApp.rejoinOffers.set(scene.id, {
            sceneId: scene.id,
            sceneTitle: String(scene.title || ""),
            leaderId: leaderId || null
        });
        VNPlayerApp._renderRejoinControl();
    }

    static clearRejoinOffer(sceneId) {
        if (sceneId) VNPlayerApp.rejoinOffers.delete(sceneId);
        else VNPlayerApp.rejoinOffers.clear();
        VNPlayerApp._renderRejoinControl();
    }

    static _renderRejoinControl() {
        const doc = globalThis.document;
        if (!doc?.body || typeof doc.querySelector !== "function" || typeof doc.createElement !== "function") return;
        let button = doc.querySelector("[data-fbl-vn-rejoin]");
        const offer = [...VNPlayerApp.rejoinOffers.values()].at(-1) || null;
        if (!offer) {
            button?.remove?.();
            return;
        }

        if (!button) {
            button = doc.createElement("button");
            button.type = "button";
            button.className = "fbl-vn-rejoin";
            button.dataset.fblVnRejoin = "true";
            button.addEventListener("click", () => {
                const sceneId = button.dataset.sceneId || "";
                if (sceneId) VNPlayerApp.requestRejoin(sceneId);
            });
            doc.body.append(button);
        }

        button.dataset.sceneId = offer.sceneId;
        button.disabled = false;
        button.textContent = offer.sceneTitle ? `Вернуться в катсцену: ${offer.sceneTitle}` : "Вернуться в катсцену";
    }

    static requestRejoin(sceneId) {
        const offer = VNPlayerApp.rejoinOffers.get(sceneId);
        if (!offer) return false;
        const button = globalThis.document?.querySelector?.("[data-fbl-vn-rejoin]");
        if (button && button.dataset.sceneId === sceneId) {
            button.disabled = true;
            button.textContent = "Возвращаю в катсцену…";
            globalThis.setTimeout?.(() => {
                if (!VNPlayerApp.rejoinOffers.has(sceneId)) return;
                VNPlayerApp._renderRejoinControl();
            }, 1500);
        }
        return VNSocket.rejoin(sceneId, offer.leaderId);
    }

    static recordVote(payload, senderId) {
        const sceneId = payload?.sceneId;
        const app = sceneId ? VNPlayerApp.active.get(sceneId) : null;
        if (!app) return;
        return app._recordVoteAsLeader(payload, senderId);
    }

    static updateVoteState(payload) {
        const sceneId = payload?.sceneId;
        const app = sceneId ? VNPlayerApp.active.get(sceneId) : null;
        if (!app) return;
        return app._applyVoteState(payload);
    }

    static getSyncState(sceneId) {
        const app = VNPlayerApp.active.get(sceneId);
        if (!app || !app._isLeader() || !app.started) return null;
        return {
            currentFrameId: app.currentFrameId,
            currentTextIndex: app.currentTextIndex,
            counterState: Object.assign({}, app.counterState),
            visualState: Object.assign({}, app.visualState),
            voteState: app.mode === PLAYER_MODES.VOTE ? app._buildVoteStateFromLeaderVotes() : null
        };
    }

    static handleUserConnection(user, connected) {
        for (const app of VNPlayerApp.active.values()) app._onParticipantConnectionChange(user, connected);
    }

    static handleParticipantLeave(sceneId, userId) {
        const app = VNPlayerApp.active.get(sceneId);
        if (!app) return;
        return app._onParticipantLeave(userId);
    }

    static handleParticipantRejoin(sceneId, userId) {
        const app = VNPlayerApp.active.get(sceneId);
        if (!app) return;
        return app._onParticipantRejoin(userId);
    }

    async preload(options = {}) {
        if (this._preloadPromise) return this._preloadPromise;
        this._preloadPromise = this._preloadInner(options.frameId || "", options.extraPaths || []);
        return this._preloadPromise;
    }

    async _preloadInner(startFrameId = "", extraPaths = []) {
        const startFrame = this._getFrame(startFrameId);
        const paths = [...new Set([
            ...VNPreloader.collectStartupWindowPaths(this.scene, startFrame?.id || "", { depth: 2, maxFrames: 12 }),
            ...(Array.isArray(extraPaths) ? extraPaths : [])
        ].filter(Boolean))];
        this.preloadTotal = paths.length;
        this.preloadDone = 0;
        this._pendingPreloadProgress = { done: 0, total: this.preloadTotal };
        this._flushPreloadProgressUpdate();
        const results = await this._preloader.ensurePaths(paths, {
            concurrency: 6,
            onProgress: progress => {
                this.preloadDone = progress.done;
                this.preloadTotal = progress.total;
                this._schedulePreloadProgressUpdate(progress);
            }
        });
        this._flushPreloadProgressUpdate();
        if (this._disposed) return results;

        const criticalResults = startFrame ? await this._ensureFrameAssets(startFrame, 0) : [];
        if (this._disposed) return results;
        const failed = [
            ...(Array.isArray(results) ? results : []),
            ...(Array.isArray(criticalResults) ? criticalResults : [])
        ].filter(result => result?.ok === false);
        if (failed.length && game.user?.isGM) notifyWarn(`VN: не удалось подготовить ассеты: ${failed.length}. Катсцена будет запущена, но часть ресурсов может появиться с задержкой.`);

        this.loading = false;
        await this.render();
        if (this._disposed) return results;
        this._backgroundPreloadPromise = this._preloader.startBackgroundImages();
        VNSocket.signalReady(this.scene.id, this.leaderId);
        if (VNPlayerApp.pendingStarts.has(this.scene.id)) {
            VNPlayerApp.pendingStarts.delete(this.scene.id);
            await this.start();
        }
        return results;
    }

    async _ensureCriticalPaths(paths) {
        if (this._disposed || !this._preloader) return [];
        const uniquePaths = [...new Set((Array.isArray(paths) ? paths : []).filter(Boolean))];
        if (!uniquePaths.length) return [];
        const results = await this._preloader.ensurePaths(uniquePaths, { concurrency: 6 });
        if (this._disposed) return results;
        const failedPaths = results.filter(result => result?.ok === false && result.path).map(result => result.path);
        if (!failedPaths.length) return results;
        const retries = await this._preloader.ensurePaths(failedPaths, { concurrency: 6 });
        const retryByPath = new Map(retries.map(result => [result.path, result]));
        return results.map(result => retryByPath.get(result.path) || result);
    }

    _ensureFrameAssets(frame, textIndex = 0) {
        if (!frame) return Promise.resolve([]);
        return this._ensureCriticalPaths(VNPreloader.collectFrameEntryPaths(frame, textIndex));
    }

    _ensureTextBlockAssets(frame, textIndex = 0) {
        const block = getTextBlock(frame, textIndex);
        return this._ensureCriticalPaths(block?.voice ? [block.voice] : []);
    }

    _warmUpcomingAssets(frame) {
        if (!frame?.id || this._disposed || !this._preloader) return;
        void this._preloader.warmWindow(frame.id, { depth: 2, maxFrames: 12, concurrency: 2 }).catch(error => {
            console.warn(`${MODULE_ID} | Nearby asset preload failed.`, error);
        });
    }

    _schedulePreloadProgressUpdate(progress) {
        if (this._disposed) return;
        this._pendingPreloadProgress = progress;
        if (this._preloadProgressRaf !== null) return;
        this._preloadProgressRaf = requestAnimationFrame(() => {
            this._preloadProgressRaf = null;
            this._flushPreloadProgressUpdate();
        });
    }

    _flushPreloadProgressUpdate() {
        const progress = this._pendingPreloadProgress;
        this._pendingPreloadProgress = null;
        if (!progress || !this.element) return;
        const value = this.element.querySelector("[data-preload-progress]");
        const label = this.element.querySelector("[data-preload-label]");
        if (value) {
            value.max = Math.max(1, Number(progress.total || 0));
            value.value = Number(progress.done || 0);
        }
        if (label) label.textContent = `${Number(progress.done || 0)} / ${Number(progress.total || 0)}`;
    }

    _previewCounterKey(frameId, counterState) {
        const entries = Object.entries(counterState && typeof counterState === "object" ? counterState : {})
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([id, value]) => [id, Number(value || 0)]);
        return `${frameId || ""}|${JSON.stringify(entries)}`;
    }

    _previewNextId(frame, counterState) {
        const routing = resolveFrameNextRouting(frame, counterState);
        if (routing.enabled) {
            if (routing.frameId && this._frameById.has(routing.frameId)) return routing.frameId;
            return this._nextSequentialById.get(frame.id) || "";
        }
        if (frame.next && this._frameById.has(frame.next)) return frame.next;
        return this._nextSequentialById.get(frame.id) || "";
    }

    _findBranchPreviewPath(targetFrameId, branchId = "") {
        const target = this._getFrame(targetFrameId);
        if (!target) return null;
        const currentBranchId = branchId || target.branchId || "";
        if ((target.branchId || "") !== currentBranchId) return null;

        const branchFrames = (Array.isArray(this.scene?.frames) ? this.scene.frames : [])
            .filter(frame => (frame.branchId || "") === currentBranchId);
        const targetIndex = branchFrames.findIndex(frame => frame.id === target.id);
        if (targetIndex < 0) return null;

        let counterState = getInitialCounterState(this.scene);
        const steps = [];
        for (let index = 0; index < targetIndex; index += 1) {
            const frame = branchFrames[index];
            counterState = applyFrameCounterEffect(frame, counterState);
            steps.push({ frameId: frame.id, choiceId: "" });
        }
        return { steps, counterState, branchId: currentBranchId, source: "branch" };
    }

    _findPreviewPath(targetFrameId) {
        const target = this._getFrame(targetFrameId);
        const start = this._getFrame();
        if (!target || !start) return null;
        const initial = getInitialCounterState(this.scene);
        if (start.id === target.id) return { steps: [], counterState: initial };

        const queue = [{ frameId: start.id, counterState: initial, steps: [] }];
        const seen = new Set();
        const maxStates = Math.max(200, (this.scene?.frames?.length || 0) * 40);
        let processed = 0;
        let cursor = 0;

        while (cursor < queue.length && processed < maxStates) {
            const state = queue[cursor++];
            processed += 1;
            const key = this._previewCounterKey(state.frameId, state.counterState);
            if (seen.has(key)) continue;
            seen.add(key);

            const frame = this._getFrame(state.frameId);
            if (!frame) continue;
            if (frame.id === target.id) {
                return { steps: state.steps, counterState: state.counterState };
            }

            let enteredCounters = applyFrameCounterEffect(frame, state.counterState);
            if (frame.isFinal === true) continue;

            if (frame.type === "choice") {
                const choices = Array.isArray(frame.choices) ? frame.choices : [];
                for (const choice of choices) {
                    if (!isChoiceAvailable(choice, enteredCounters)) continue;
                    const nextCounters = applyChoiceCounterEffect(choice, enteredCounters);
                    const nextId = choice.next
                        ? (this._frameById.has(choice.next) ? choice.next : "")
                        : this._previewNextId(frame, nextCounters);
                    if (!nextId || !this._frameById.has(nextId)) continue;
                    const steps = state.steps.concat([{ frameId: frame.id, choiceId: choice.id || "" }]);
                    if (nextId === target.id) return { steps, counterState: nextCounters };
                    queue.push({ frameId: nextId, counterState: nextCounters, steps });
                }
                continue;
            }

            const nextId = this._previewNextId(frame, enteredCounters);
            if (!nextId || !this._frameById.has(nextId)) continue;
            const steps = state.steps.concat([{ frameId: frame.id, choiceId: "" }]);
            if (nextId === target.id) return { steps, counterState: enteredCounters };
            queue.push({ frameId: nextId, counterState: enteredCounters, steps });
        }
        return null;
    }

    _applyPreviewCueState(bank, cues, kind) {
        for (const cue of Array.isArray(cues) ? cues : []) {
            const channel = String(cue.channel || "").trim();
            if (cue.action === AUDIO_ACTIONS.STOP_ALL) {
                bank.clear();
                continue;
            }
            if (!channel) continue;
            if (cue.action === AUDIO_ACTIONS.STOP) {
                bank.delete(channel);
                continue;
            }
            if (cue.action !== AUDIO_ACTIONS.PLAY || !cue.src) continue;
            if (kind === "sfx" && cue.loop !== true) {
                bank.delete(channel);
                continue;
            }
            bank.set(channel, {
                channel,
                src: cue.src,
                loop: cue.loop === true
            });
        }
    }

    async _warmFramePreview(previewPath) {
        this.visualState = createVisualState();
        const music = new Map();
        const sfx = new Map();

        for (const step of previewPath?.steps || []) {
            const frame = this._getFrame(step.frameId);
            if (!frame) continue;
            this._applyVisualState(frame);
            this._applyPreviewCueState(music, frame.musicCues, "music");
            this._applyPreviewCueState(sfx, frame.sfxCues, "sfx");
        }

        this.counterState = previewPath?.counterState && typeof previewPath.counterState === "object"
            ? Object.assign({}, previewPath.counterState)
            : getInitialCounterState(this.scene);

        for (const cue of music.values()) {
            await this.audio.playChannel("music", cue.channel, cue.src, cue.loop);
        }
        for (const cue of sfx.values()) {
            await this.audio.playChannel("sfx", cue.channel, cue.src, true);
        }
    }

    async startFramePreview(frameId, options = {}) {
        if (this.loading || this._disposed) return;
        const frame = this._getFrame(frameId);
        if (!frame) return;
        this.started = true;
        this.audio.pauseExternalAudio();

        const requestedBranchId = options.branchId || frame.branchId || "";
        const branchPreview = this._findBranchPreviewPath(frame.id, requestedBranchId);
        const previewPath = branchPreview || this._findPreviewPath(frame.id);
        if (previewPath) {
            await this._warmFramePreview(previewPath);
        }
        else {
            this.counterState = getInitialCounterState(this.scene);
            this.visualState = createVisualState();
            console.warn(`${MODULE_ID} | Could not reconstruct preview state for frame ${frame.id}. Previewing the frame without inherited state.`);
        }
        await this._goToFrameNow(frame.id, { force: true });
    }

    async start() {
        if (this.started || this._starting) return;
        if (this.loading) {
            VNPlayerApp.pendingStarts.add(this.scene.id);
            return;
        }
        this._starting = true;
        try {
            this.started = true;
            this.counterState = getInitialCounterState(this.scene);
            this.audio.pauseExternalAudio();
            this.visualState = createVisualState();
            const frames = Array.isArray(this.scene.frames) ? this.scene.frames : [];
            const firstId = this.scene.startFrame || (frames[0] ? frames[0].id : null);
            await this.goToFrame(firstId, { force: true });
            await this._flushPendingRemoteFrames();
        }
        finally {
            this._starting = false;
        }
    }

    async resume(state = {}) {
        if (this.loading || this._disposed || this._resuming) return;
        this._resuming = true;
        try {
            this.started = true;
            this.audio.pauseExternalAudio();
            this.counterState = state.counterState && typeof state.counterState === "object" ? Object.assign({}, state.counterState) : getInitialCounterState(this.scene);
            this.visualState = Object.assign(createVisualState(), state.visualState && typeof state.visualState === "object" ? state.visualState : {});
            const frame = this._getFrame(state.currentFrameId);
            if (!frame) {
                this.started = false;
                return await this.start();
            }
            const blocks = getFrameTextBlocks(frame);
            const requestedIndex = Math.max(0, Math.min(Math.max(0, blocks.length - 1), Number(state.currentTextIndex || 0)));
            await this._ensureFrameAssets(frame, requestedIndex);
            if (this._disposed) return;
            this.currentFrameId = frame.id;
            this._contentHidden = false;
            this.currentTextIndex = requestedIndex;
            this._resetVoteForStep(frame.id, this.currentTextIndex);
            await this.audio.applyFrame(frame);
            await this._playCurrentVoice(frame);
            await this.render();
            if (this.mode === PLAYER_MODES.VOTE && state.voteState) this._applyVoteState(state.voteState);
            this._warmUpcomingAssets(frame);
            await this._flushPendingRemoteFrames();
        }
        finally {
            this._resuming = false;
        }
    }

    async _flushPendingRemoteFrames() {
        while (this._pendingRemoteFrames.length && !this._disposed) {
            const item = this._pendingRemoteFrames.shift();
            if (typeof item === "string") {
                await this._enqueuePlaybackOperation(() => this._goToFrameNow(item, { remote: true }));
            }
            else if (item) {
                await this._enqueuePlaybackOperation(() => this._applyRemoteAdvance(item.frameId, item.textIndex, item.options || {}));
            }
        }
    }

    _enqueuePlaybackOperation(operation) {
        const previous = this._playbackQueue && typeof this._playbackQueue.then === "function"
            ? this._playbackQueue
            : Promise.resolve();
        const run = previous
            .catch(() => {})
            .then(async () => {
                if (this._disposed) return;
                return operation();
            });
        this._playbackQueue = run.catch(error => {
            console.error(`${MODULE_ID} | Playback operation failed.`, error);
        });
        return run;
    }

    async _applyRemoteAdvance(frameId, textIndex = 0, options = {}) {
        if (options?.choiceId) this._applyChoiceEffectById(options.choiceId);
        if (this.currentFrameId === frameId && options?.reenter !== true) {
            return this._goToTextBlockNow(Number(textIndex || 0), { remote: true });
        }
        return this._goToFrameNow(frameId, { remote: true, textIndex });
    }

    _canCloseLocally() {
        return this._isLeader() || this.mode === PLAYER_MODES.INDIVIDUAL || this.mode === PLAYER_MODES.VOTE;
    }

    async requestClose() {
        if (this.mode === PLAYER_MODES.VOTE && this.networked && !this._isLeader()) {
            VNPlayerApp.offerRejoin(this.scene, this.leaderId);
            VNSocket.leave(this.scene.id, this.leaderId);
            return this.close({ force: true });
        }
        return this.finish();
    }

    async _prepareContext(options) {
        const context = await super._prepareContext(options);
        const frame = this._getFrame(this.currentFrameId);
        const blocks = getFrameTextBlocks(frame);
        const currentBlock = getTextBlock(frame, this.currentTextIndex);
        const isVoteMode = this.mode === PLAYER_MODES.VOTE;
        const activeParticipants = this._activeParticipantIds();
        const isVoteOverride = isVoteMode && this._isGmVoteOverride();
        const isParticipant = !isVoteMode || activeParticipants.includes(game.user.id) || isVoteOverride;
        const canAdvance = this.started && isParticipant && (this.mode !== PLAYER_MODES.GM || this._isLeader());
        const portraitPosition = ["left", "center", "right"].includes(this.visualState.portraitPosition) ? this.visualState.portraitPosition : "left";
        const transition = frame && ["none", "fade", "dark"].includes(frame.transition) ? frame.transition : "none";
        const isChoice = Boolean(frame && frame.type === "choice");
        const isFinal = Boolean(frame && frame.isFinal === true);
        const isLastTextBlock = this.currentTextIndex >= Math.max(0, blocks.length - 1);
        const localVote = isVoteOverride ? null : this._getLocalVoteForCurrentStep();
        const voteState = this._getVoteStateForCurrentStep();
        const voteTotal = isVoteMode && Number.isFinite(Number(voteState.total))
            ? Number(voteState.total)
            : activeParticipants.length;
        const choices = frame && Array.isArray(frame.choices) ? frame.choices : [];
        const choiceCounts = voteState && voteState.choices ? voteState.choices : {};
        const currentVolumeLevels = this._volumeLevels();
        const currentText = currentBlock ? currentBlock.text : "";
        const currentRichText = sanitizeRichTextHtml(
            currentBlock?.richText || richTextFromPlainText(currentText),
            { fallbackText: currentText }
        );
        const isCenteredText = Boolean(frame && frame.textPresentation === TEXT_PRESENTATIONS.CENTER);
        const vignetteMode = frame && Object.values(VIGNETTE_MODES).includes(frame.vignetteMode) ? frame.vignetteMode : VIGNETTE_MODES.NONE;
        const resolvedVignetteMode = vignetteMode === VIGNETTE_MODES.AUTO
            ? (isCenteredText ? VIGNETTE_MODES.TEXT : VIGNETTE_MODES.SCREEN)
            : vignetteMode;
        const frameCharacters = [];
        const primaryName = frame && frame.speaker ? String(frame.speaker) : "";
        const primaryPortrait = this.visualState.portrait || "";
        const primaryShowName = Boolean(primaryName) && frame?.showSpeakerName !== false && !isCenteredText;
        if (primaryPortrait || primaryShowName) {
            frameCharacters.push({
                id: "primary",
                name: primaryName,
                portraitSrc: primaryPortrait,
                portraitAlt: primaryName,
                portraitClass: `portrait-${portraitPosition}`,
                hasPortrait: Boolean(primaryPortrait),
                showName: primaryShowName
            });
        }
        for (const character of frame && Array.isArray(frame.additionalCharacters) ? frame.additionalCharacters : []) {
            if (!character || typeof character !== "object") continue;
            const position = ["left", "center", "right"].includes(character.portraitPosition) ? character.portraitPosition : "right";
            const name = String(character.name || "");
            const portrait = String(character.portrait || "");
            const showName = Boolean(name) && character.showName !== false && !isCenteredText;
            if (!portrait && !showName) continue;
            frameCharacters.push({
                id: String(character.id || ""),
                name,
                portraitSrc: portrait,
                portraitAlt: name,
                portraitClass: `portrait-${position}`,
                hasPortrait: Boolean(portrait),
                showName
            });
        }
        return Object.assign(context, {
            scene: this.scene,
            frame,
            mode: this.mode,
            loading: this.loading,
            started: this.started,
            preloadDone: this.preloadDone,
            preloadTotal: this.preloadTotal,
            canAdvance,
            isChoice,
            isFinal,
            showChoices: isChoice && isLastTextBlock && !isFinal,
            isGmMode: this.mode === PLAYER_MODES.GM,
            isVoteMode,
            isVoteOverride,
            isLeader: this._isLeader(),
            canClose: this._canCloseLocally(),
            portraitClass: `portrait-${portraitPosition}`,
            portraitSrc: this.visualState.portrait,
            portraitAlt: frame && frame.speaker ? frame.speaker : "",
            backgroundSrc: this.visualState.background || "",
            transitionClass: `transition-${transition}`,
            hasPortrait: frameCharacters.some(character => character.hasPortrait),
            hasSpeaker: frameCharacters.some(character => character.showName),
            frameCharacters,
            isCenteredText,
            showScreenVignette: resolvedVignetteMode === VIGNETTE_MODES.SCREEN,
            showTextVignette: resolvedVignetteMode === VIGNETTE_MODES.TEXT,
            contentHidden: this._contentHidden,
            choices: choices.map(choice => {
                const available = isChoiceAvailable(choice, this.counterState);
                return Object.assign({}, choice, {
                    voteCount: Number(choiceCounts[choice.id] || 0),
                    selected: Boolean(localVote && localVote.action === "choice" && localVote.choiceId === choice.id),
                    available,
                    unavailable: !available
                });
            }),
            currentText,
            currentRichText,
            currentTextIndex: this.currentTextIndex + 1,
            textBlockCount: blocks.length,
            voteTotal,
            voteCount: voteState ? voteState.voters.length : 0,
            localHasVoted: Boolean(localVote),
            volumePanelOpen: this._volumePanelOpen,
            volumeLevels: currentVolumeLevels,
            reducedMotion: this._prefersReducedMotion()
        });
    }

    async _onRender(context, options) {
        await super._onRender(context, options);
        this._applyFullscreenPosition();
        this._bindResize();
        this._applyBackgroundStyle(context.backgroundSrc || "");
        this._bindKeyboard();
        this._bindClickAdvance();
        this._bindVolumeControls();
        this._setContentHidden(this._contentHidden);
        if (context.started && context.frame) this._typeText(context.currentRichText, context.currentText);
    }

    _applyFullscreenPosition() {
        const root = this.element;
        if (!root) return;
        root.style.width = `${window.innerWidth}px`;
        root.style.height = `${window.innerHeight}px`;
        root.style.left = "0";
        root.style.top = "0";
    }

    _bindResize() {
        if (this._resizeBound) return;
        window.addEventListener("resize", this._onWindowResize);
        this._resizeBound = true;
    }

    _applyBackgroundStyle(path) {
        const bg = this.element ? this.element.querySelector(".fbl-vn-bg") : null;
        if (!bg) return;
        bg.style.backgroundImage = path ? `url("${String(path).replace(/"/g, "%22")}")` : "";
    }

    _bindKeyboard() {
        const root = this.element;
        if (!root) return;
        if (this._keyboardElement && this._keyboardElement !== root) {
            this._keyboardElement.removeEventListener("keydown", this._onKeyboardKeydown);
            this._keyboardElement = null;
        }
        if (this._keyboardElement !== root) {
            root.addEventListener("keydown", this._onKeyboardKeydown);
            this._keyboardElement = root;
        }
        root.setAttribute("tabindex", "0");
        const activeElement = document.activeElement;
        if (!activeElement || activeElement === document.body || activeElement === document.documentElement) root.focus();
    }

    _bindClickAdvance() {
        const root = this.element;
        if (!root) return;
        const area = root.querySelector("[data-vn-advance-area]");
        if (!area || area.dataset.vnAdvanceBound === "true") return;
        area.dataset.vnAdvanceBound = "true";
        area.addEventListener("click", event => {
            if (event.target && event.target.closest && event.target.closest("button,input,label,.fbl-vn-volume-panel,.fbl-vn-volume-widget")) return;
            void this.next();
        });
    }

    _bindVolumeControls() {
        const root = this.element;
        if (!root) return;
        for (const input of root.querySelectorAll("[data-vn-volume]")) {
            if (input.dataset.vnVolumeBound === "true") continue;
            input.dataset.vnVolumeBound = "true";
            input.addEventListener("input", event => this._onVolumeInput(event));
            input.addEventListener("change", () => this._flushVolumeSettings());
        }
    }

    _onVolumeInput(event) {
        const input = event.currentTarget;
        const type = input?.dataset?.vnVolume;
        const setting = this._volumeSettingKey(type);
        if (!setting) return;
        const value = Math.max(0, Math.min(1, Number(input.value || 0)));
        const row = input.closest(".fbl-vn-volume-row");
        const valueNode = row ? row.querySelector(".fbl-vn-volume-value") : null;
        if (valueNode) valueNode.textContent = `${Math.round(value * 100)}%`;
        this._localVolumeValues.set(type, value);
        this._pendingVolumeSettings.set(setting, { type, value });
        this.audio.setVolumeMultiplier(type, value);
        this._scheduleVolumeSettingsFlush();
    }

    _scheduleVolumeSettingsFlush() {
        if (this._volumeSaveTimer) clearTimeout(this._volumeSaveTimer);
        this._volumeSaveTimer = setTimeout(() => {
            this._volumeSaveTimer = null;
            this._flushVolumeSettings();
        }, 150);
    }

    async _flushVolumeSettings() {
        if (this._volumeSaveTimer) {
            clearTimeout(this._volumeSaveTimer);
            this._volumeSaveTimer = null;
        }
        const pending = [...this._pendingVolumeSettings.entries()];
        this._pendingVolumeSettings.clear();
        for (const [setting, payload] of pending) {
            try {
                await game.settings.set(MODULE_ID, setting, payload.value);
                this.audio.clearVolumeOverride(payload.type);
            }
            catch (error) {
                this._pendingVolumeSettings.set(setting, payload);
                console.warn(`${MODULE_ID} | Failed to update VN volume setting.`, error);
            }
        }
    }

    _volumeSettingKey(type) {
        if (type === "music") return SETTINGS.MUSIC_VOLUME;
        if (type === "voice") return SETTINGS.VOICE_VOLUME;
        if (type === "sfx") return SETTINGS.SFX_VOLUME;
        return null;
    }

    _volumeLevels() {
        const specs = [
            ["music", "Музыка", SETTINGS.MUSIC_VOLUME],
            ["voice", "Голос", SETTINGS.VOICE_VOLUME],
            ["sfx", "SFX", SETTINGS.SFX_VOLUME]
        ];
        return specs.map(([key, label, setting]) => {
            const value = this._localVolumeValues.has(key) ? this._localVolumeValues.get(key) : getNumberSetting(setting, 1);
            return { key, label, value, percent: Math.round(value * 100) };
        });
    }

    _cancelTypingAnimation() {
        if (this._typingRaf !== null) cancelAnimationFrame(this._typingRaf);
        this._typingRaf = null;
    }

    _typeText(richText, fallbackText = "") {
        const node = this.element ? this.element.querySelector("[data-vn-text]") : null;
        const safeHtml = sanitizeRichTextHtml(
            richText || richTextFromPlainText(fallbackText),
            { fallbackText }
        );
        const frameKey = `${this.currentFrameId || ""}:${this.currentTextIndex}:${safeHtml}`;
        if (node && this._typingNode === node && this._typingKey === frameKey) return;
        if (node && this._typingKey === frameKey && this._typingComplete) {
            node.innerHTML = this._typingText;
            this._typingNode = node;
            return;
        }

        this._cancelTypingAnimation();
        this._typingText = safeHtml;
        this._typingKey = frameKey;
        this._typingNode = node;
        this._typingComplete = false;

        if (!node) {
            this._typingComplete = true;
            return;
        }

        const plainText = richTextToPlainText(safeHtml);
        if (this._prefersReducedMotion() || this._instantTextEnabled() || splitTextGraphemes(plainText).length > 900) {
            node.innerHTML = safeHtml;
            this._typingComplete = true;
            return;
        }

        const template = document.createElement("template");
        template.innerHTML = safeHtml;
        node.replaceChildren();

        const segments = [];
        const cloneChildren = (source, target) => {
            for (const child of source.childNodes) {
                if (child.nodeType === 3) {
                    const output = document.createTextNode("");
                    target.append(output);
                    segments.push({ node: output, chars: splitTextGraphemes(child.data), index: 0 });
                    continue;
                }
                if (child.nodeType !== 1) continue;
                const clone = child.cloneNode(false);
                target.append(clone);
                cloneChildren(child, clone);
            }
        };
        cloneChildren(template.content, node);

        const totalChars = segments.reduce((sum, segment) => sum + segment.chars.length, 0);
        if (!totalChars) {
            node.innerHTML = safeHtml;
            this._typingComplete = true;
            return;
        }

        let segmentIndex = 0;
        let revealed = 0;
        let carry = 0;
        let previous = performance.now();
        const charsPerMs = 0.16;
        const reveal = count => {
            let remaining = count;
            while (remaining > 0 && segmentIndex < segments.length) {
                const segment = segments[segmentIndex];
                const available = segment.chars.length - segment.index;
                if (available <= 0) {
                    segmentIndex += 1;
                    continue;
                }
                const take = Math.min(remaining, available);
                const end = segment.index + take;
                segment.node.appendData(segment.chars.slice(segment.index, end).join(""));
                segment.index = end;
                remaining -= take;
                revealed += take;
                if (segment.index >= segment.chars.length) segmentIndex += 1;
            }
        };
        const tick = now => {
            carry += Math.max(0, now - previous) * charsPerMs;
            previous = now;
            const count = Math.floor(carry);
            if (count > 0) {
                carry -= count;
                reveal(count);
            }
            if (revealed >= totalChars) {
                this._typingRaf = null;
                node.innerHTML = safeHtml;
                this._typingComplete = true;
                return;
            }
            this._typingRaf = requestAnimationFrame(tick);
        };
        this._typingRaf = requestAnimationFrame(tick);
    }

    _completeText() {
        const node = this.element ? this.element.querySelector("[data-vn-text]") : null;
        this._cancelTypingAnimation();
        if (node) node.innerHTML = this._typingText;
        this._typingNode = node;
        this._typingComplete = true;
    }

    _playerRoot() {
        if (!this.element) return null;
        if (this.element.matches?.(".fbl-vn-player")) return this.element;
        return this.element.querySelector?.(".fbl-vn-player") || this.element;
    }

    _setContentHidden(hidden) {
        this._contentHidden = hidden === true;
        const root = this._playerRoot();
        if (!root) return;
        root.classList.toggle("is-content-hidden", this._contentHidden);
        const showButton = root.querySelector(".fbl-vn-show-content");
        const hideButton = root.querySelector(".fbl-vn-hide-content");
        if (showButton) showButton.setAttribute("aria-hidden", this._contentHidden ? "false" : "true");
        if (hideButton) hideButton.setAttribute("aria-expanded", this._contentHidden ? "false" : "true");
    }

    _applyVisualState(frame) {
        if (!frame) return;
        if (frame.clearBackground === true) this.visualState.background = "";
        if (frame.background) this.visualState.background = frame.background;
        this.visualState.portraitPosition = ["left", "center", "right"].includes(frame.portraitPosition)
            ? frame.portraitPosition
            : "left";
        if (frame.hidePortrait === true) this.visualState.portrait = "";
        else if (frame.portrait) this.visualState.portrait = frame.portrait;
    }

    _resetVoteForStep(frameId, textIndex = 0) {
        this._localVote = null;
        this._voteState = this._emptyVoteState(frameId, textIndex);
        this._leaderVoteStep = "";
        this._leaderVotes.clear();
        this._resolvingVote = false;
    }

    goToFrame(frameId, options = {}) {
        return this._enqueuePlaybackOperation(() => this._goToFrameNow(frameId, options));
    }

    async _goToFrameNow(frameId, options = {}) {
        const remote = options.remote === true;
        const force = options.force === true;
        const frame = this._getFrame(frameId);
        if (!frame) return this.finish();
        const blocks = getFrameTextBlocks(frame);
        const requestedTextIndex = options.textIndex !== undefined ? Number(options.textIndex || 0) : 0;
        const nextTextIndex = Math.max(0, Math.min(Math.max(0, blocks.length - 1), Number.isFinite(requestedTextIndex) ? requestedTextIndex : 0));
        await this._ensureFrameAssets(frame, nextTextIndex);
        if (this._disposed) return;
        const reenter = this.currentFrameId === frame.id;
        this.currentFrameId = frame.id;
        this._contentHidden = false;
        this._applyFrameEffect(frame);
        this.currentTextIndex = nextTextIndex;
        this._resetVoteForStep(frame.id, this.currentTextIndex);
        this._applyVisualState(frame);
        await this.audio.applyFrame(frame);
        await this._playCurrentVoice(frame);
        await this.render();
        if (!remote && !force && this._shouldBroadcastAdvance()) {
            VNSocket.advance(this.scene.id, frame.id, this.currentTextIndex, {
                choiceId: options.choiceId || "",
                reenter
            });
        }
        this._warmUpcomingAssets(frame);
    }

    _goToTextBlock(index, options = {}) {
        return this._enqueuePlaybackOperation(() => this._goToTextBlockNow(index, options));
    }

    async _goToTextBlockNow(index, options = {}) {
        const frame = this._getFrame(this.currentFrameId);
        const blocks = getFrameTextBlocks(frame);
        if (!frame || index < 0 || index >= blocks.length) return;
        await this._ensureTextBlockAssets(frame, index);
        if (this._disposed) return;
        this.currentTextIndex = index;
        this._contentHidden = false;
        this._resetVoteForStep(frame.id, this.currentTextIndex);
        await this._playCurrentVoice(frame);
        await this.render();
        if (options.remote !== true && this._shouldBroadcastAdvance()) VNSocket.advance(this.scene.id, frame.id, this.currentTextIndex);
    }

    _shouldBroadcastAdvance() {
        return Boolean(this._isLeader() && (this.mode === PLAYER_MODES.GM || this.mode === PLAYER_MODES.VOTE));
    }

    async _playCurrentVoice(frame) {
        const block = getTextBlock(frame, this.currentTextIndex);
        if (block && block.voice) await this.audio.playVoice(block.voice);
        else this.audio.stopVoice();
    }

    async next() {
        if (!this.started || this._interactionBusy) return;
        if (!this._typingComplete) {
            this._completeText();
            return;
        }
        this._interactionBusy = true;
        try {
            if (this.mode === PLAYER_MODES.VOTE) return await this._submitContinueVote();
            if (this.mode === PLAYER_MODES.GM && !this._isLeader()) return;
            const frame = this._getFrame(this.currentFrameId);
            if (!frame) return await this.finish();
            const blocks = getFrameTextBlocks(frame);
            if (this.currentTextIndex < blocks.length - 1) {
                await this._goToTextBlock(this.currentTextIndex + 1);
                return;
            }
            if (frame.type === "choice") return;
            if (this.framePreview) return await this.finish();
            if (frame.isFinal === true) return await this.finish();
            const nextId = this._getNextFrameId(frame);
            if (!nextId) return await this.finish();
            await this.goToFrame(nextId);
        }
        catch (error) {
            console.error(`${MODULE_ID} | Failed to advance cutscene.`, error);
            notifyWarn("VN: не удалось перейти к следующему кадру. Подробности записаны в консоль.");
        }
        finally {
            this._interactionBusy = false;
        }
    }

    async choose(choiceId) {
        if (!this.started || this._interactionBusy) return;
        if (!this._typingComplete) {
            this._completeText();
            return;
        }
        this._interactionBusy = true;
        try {
            const frame = this._getFrame(this.currentFrameId);
            if (!frame) return;
            const blocks = getFrameTextBlocks(frame);
            if (this.currentTextIndex < blocks.length - 1) {
                if (this.mode === PLAYER_MODES.VOTE) return await this._submitContinueVote();
                await this._goToTextBlock(this.currentTextIndex + 1);
                return;
            }
            if (this.mode === PLAYER_MODES.VOTE) return await this._submitChoiceVote(choiceId);
            if (this.mode === PLAYER_MODES.GM && !this._isLeader()) return;
            if (this.framePreview) return await this.finish();
            const choices = Array.isArray(frame.choices) ? frame.choices : [];
            const choice = choices.find(c => c.id === choiceId);
            if (!choice || !isChoiceAvailable(choice, this.counterState)) return;
            this._applyChoiceEffect(choice);
            if (frame.isFinal === true) return await this.finish();
            const nextId = choice.next || this._getNextFrameId(frame);
            if (!nextId) return await this.finish();
            await this.goToFrame(nextId, { choiceId: choice.id });
        }
        catch (error) {
            console.error(`${MODULE_ID} | Failed to apply cutscene choice.`, error);
            notifyWarn("VN: не удалось применить выбор. Подробности записаны в консоль.");
        }
        finally {
            this._interactionBusy = false;
        }
    }

    async _submitContinueVote() {
        if (!this._canSubmitVote()) return;
        const frame = this._getFrame(this.currentFrameId);
        if (!frame) return;
        const blocks = getFrameTextBlocks(frame);
        if (frame.type === "choice" && this.currentTextIndex >= blocks.length - 1) return;
        if (this._isGmVoteOverride()) return this._resolveGmVoteOverride({ action: "continue" });
        await this._submitVote({ action: "continue" });
    }

    async _submitChoiceVote(choiceId) {
        if (!this._canSubmitVote()) return;
        const frame = this._getFrame(this.currentFrameId);
        if (!frame || frame.type !== "choice") return;
        const blocks = getFrameTextBlocks(frame);
        if (this.currentTextIndex < blocks.length - 1) return this._submitContinueVote();
        const choices = Array.isArray(frame.choices) ? frame.choices : [];
        const choice = choices.find(item => item.id === choiceId);
        if (!choice || !isChoiceAvailable(choice, this.counterState)) return;
        if (this._isGmVoteOverride()) return this._resolveGmVoteOverride({ action: "choice", choiceId });
        await this._submitVote({ action: "choice", choiceId });
    }

    _canSubmitVote() {
        return Boolean(this.mode === PLAYER_MODES.VOTE && (this._isGmVoteOverride() || this._activeParticipantIds().includes(game.user.id)));
    }

    async _submitVote({ action, choiceId = "" }) {
        const existing = this._getLocalVoteForCurrentStep();
        if (existing && existing.action === action && (existing.choiceId || "") === (choiceId || "")) return;
        const vote = {
            frameId: this.currentFrameId,
            textIndex: this.currentTextIndex,
            action,
            choiceId: choiceId || ""
        };
        this._localVote = vote;
        this._syncVoteDom();
        VNSocket.submitVote(this.scene.id, vote, this.leaderId);
    }

    _voteStepKey(frameId = this.currentFrameId, textIndex = this.currentTextIndex) {
        return `${frameId || ""}:${Number(textIndex || 0)}`;
    }

    _emptyVoteState(frameId = this.currentFrameId, textIndex = this.currentTextIndex) {
        return {
            frameId: frameId || null,
            textIndex: Number(textIndex || 0),
            action: "",
            voters: [],
            choices: {},
            total: this._activeParticipantIds().length
        };
    }

    _getLocalVoteForCurrentStep() {
        if (!this._localVote) return null;
        if (this._localVote.frameId !== this.currentFrameId) return null;
        if (Number(this._localVote.textIndex || 0) !== Number(this.currentTextIndex || 0)) return null;
        return this._localVote;
    }

    _getVoteStateForCurrentStep() {
        if (!this._voteState) return this._emptyVoteState();
        if (this._voteState.frameId !== this.currentFrameId) return this._emptyVoteState();
        if (Number(this._voteState.textIndex || 0) !== Number(this.currentTextIndex || 0)) return this._emptyVoteState();
        return this._voteState;
    }


    _syncVoteDom() {
        if (this.mode !== PLAYER_MODES.VOTE || !this.element || !this.started) return;
        const frame = this._getFrame(this.currentFrameId);
        if (!frame) return;
        const activeParticipants = this._activeParticipantIds();
        const isVoteOverride = this._isGmVoteOverride();
        const isParticipant = activeParticipants.includes(game.user.id);
        const canAct = isParticipant || isVoteOverride;
        const localVote = isVoteOverride ? null : this._getLocalVoteForCurrentStep();
        const voteState = this._getVoteStateForCurrentStep();
        const total = Number.isFinite(Number(voteState.total)) ? Number(voteState.total) : activeParticipants.length;

        for (const button of this.element.querySelectorAll(".fbl-vn-player-choice-list button[data-choice-id]")) {
            const choiceId = button.dataset.choiceId || "";
            const choice = this._getChoice(this.currentFrameId, choiceId);
            const available = Boolean(choice && isChoiceAvailable(choice, this.counterState));
            const selected = Boolean(localVote && localVote.action === "choice" && localVote.choiceId === choiceId);
            button.classList.toggle("is-selected", selected);
            button.classList.toggle("is-unavailable", !available);
            button.disabled = !canAct || (!isVoteOverride && Boolean(localVote)) || !available;
            const count = button.querySelector(".fbl-vn-vote-count");
            if (count) count.textContent = `${Number(voteState.choices?.[choiceId] || 0)} / ${total}`;
        }

        const nextButton = this.element.querySelector(".fbl-vn-next[data-action='next']");
        if (nextButton) {
            const voted = !isVoteOverride && Boolean(localVote);
            nextButton.classList.toggle("is-voted", voted);
            nextButton.disabled = !canAct || voted;
            const actionLabel = nextButton.querySelector("[data-vote-action-label]");
            if (actionLabel) actionLabel.textContent = isVoteOverride ? "Продолжить (ГМ)" : (voted ? "Ждём остальных" : "Продолжить");
            const count = nextButton.querySelector(".fbl-vn-vote-count");
            if (count) count.textContent = `${voteState.voters.length} / ${total}`;
        }
    }

    async _recordVoteAsLeader(payload, senderId) {
        if (!this._isLeader() || this.mode !== PLAYER_MODES.VOTE || this._resolvingVote) return;
        if (!payload || payload.sceneId !== this.scene.id) return;
        const userId = senderId;
        const activeParticipants = this._activeParticipantIds();
        if (!activeParticipants.includes(userId)) return;
        const frameId = payload.frameId || "";
        const textIndex = Number(payload.textIndex || 0);
        if (frameId !== this.currentFrameId || textIndex !== Number(this.currentTextIndex || 0)) return;
        const frame = this._getFrame(this.currentFrameId);
        if (!frame) return;
        const action = payload.action === "choice" ? "choice" : "continue";
        if (!this._isVoteActionValid(frame, action, payload.choiceId || "")) return;
        const stepKey = this._voteStepKey(frameId, textIndex);
        if (this._leaderVoteStep !== stepKey) {
            this._leaderVoteStep = stepKey;
            this._leaderVotes.clear();
        }
        this._leaderVotes.set(userId, { action, choiceId: payload.choiceId || "" });
        this._publishVoteState();
        if (activeParticipants.every(id => this._leaderVotes.has(id))) await this._resolveLeaderVotes();
    }

    _isVoteActionValid(frame, action, choiceId) {
        const blocks = getFrameTextBlocks(frame);
        const isLastTextBlock = this.currentTextIndex >= Math.max(0, blocks.length - 1);
        if (action === "continue") return !(frame.type === "choice" && isLastTextBlock);
        if (action !== "choice") return false;
        if (frame.type !== "choice" || !isLastTextBlock) return false;
        const choices = Array.isArray(frame.choices) ? frame.choices : [];
        const choice = choices.find(item => item.id === choiceId);
        return Boolean(choice && isChoiceAvailable(choice, this.counterState));
    }

    _buildVoteStateFromLeaderVotes() {
        const choices = {};
        let action = "";
        const activeParticipants = new Set(this._activeParticipantIds());
        const voters = [];
        for (const [userId, vote] of this._leaderVotes.entries()) {
            if (!activeParticipants.has(userId)) continue;
            voters.push(userId);
            action = vote.action || action;
            if (vote.action === "choice" && vote.choiceId) choices[vote.choiceId] = Number(choices[vote.choiceId] || 0) + 1;
        }
        return {
            sceneId: this.scene.id,
            frameId: this.currentFrameId,
            textIndex: this.currentTextIndex,
            action,
            voters,
            choices,
            total: activeParticipants.size,
            participantIds: this._voteParticipantIds()
        };
    }

    _publishVoteState() {
        const state = this._buildVoteStateFromLeaderVotes();
        VNSocket.broadcastVoteState(this.scene.id, state);
    }

    _applyVoteState(payload) {
        if (this.mode !== PLAYER_MODES.VOTE || !payload) return;
        if (payload.frameId !== this.currentFrameId) return;
        if (Number(payload.textIndex || 0) !== Number(this.currentTextIndex || 0)) return;
        const voters = uniqueIds(payload.voters || []);
        if (Array.isArray(payload.participantIds)) {
            this.participantIds = uniqueIds(payload.participantIds);
            for (const userId of [...this._participantConnectionState.keys()]) {
                if (!this.participantIds.includes(userId)) this._participantConnectionState.delete(userId);
            }
        }
        const choices = {};
        const sourceChoices = payload.choices && typeof payload.choices === "object" ? payload.choices : {};
        for (const [choiceId, count] of Object.entries(sourceChoices)) choices[choiceId] = Math.max(0, Number(count || 0));
        this._voteState = {
            frameId: payload.frameId,
            textIndex: Number(payload.textIndex || 0),
            action: payload.action || "",
            voters,
            choices,
            total: Number.isFinite(Number(payload.total)) ? Number(payload.total) : this._activeParticipantIds().length
        };
        this._syncVoteDom();
    }

    _onParticipantConnectionChange(user, connected) {
        if (!this._isLeader() || this.mode !== PLAYER_MODES.VOTE || !user || !this.participantIds.includes(user.id)) return;
        this._participantConnectionState.set(user.id, connected === true);
        if (connected !== true) this._leaderVotes.delete(user.id);
        this._publishVoteState();
        const activeParticipants = this._activeParticipantIds();
        if (activeParticipants.length && activeParticipants.every(id => this._leaderVotes.has(id))) {
            void this._resolveLeaderVotes();
        }
    }

    _onParticipantLeave(userId) {
        if (!this._isLeader() || this.mode !== PLAYER_MODES.VOTE || !userId || !this.participantIds.includes(userId)) return;
        this.participantIds = this.participantIds.filter(id => id !== userId);
        this._participantConnectionState.delete(userId);
        this._leaderVotes.delete(userId);
        this._publishVoteState();
        const activeParticipants = this._activeParticipantIds();
        if (activeParticipants.length && activeParticipants.every(id => this._leaderVotes.has(id))) {
            void this._resolveLeaderVotes();
        }
    }

    _onParticipantRejoin(userId) {
        if (!this._isLeader() || this.mode !== PLAYER_MODES.VOTE || !userId) return;
        if (!this.participantIds.includes(userId)) this.participantIds.push(userId);
        this._participantConnectionState.set(userId, true);
        this._leaderVotes.delete(userId);
        if (this.started) this._publishVoteState();
    }

    async _resolveGmVoteOverride({ action, choiceId = "" }) {
        if (!this._isGmVoteOverride() || this._resolvingVote) return;
        const frame = this._getFrame(this.currentFrameId);
        if (!frame || !this._isVoteActionValid(frame, action, choiceId)) return;
        this._resolvingVote = true;
        this._leaderVotes.clear();
        this._publishVoteState();

        if (action === "choice") {
            const choices = Array.isArray(frame.choices) ? frame.choices : [];
            const choice = choices.find(item => item.id === choiceId);
            if (!choice) {
                this._resolvingVote = false;
                return;
            }
            this._applyChoiceEffect(choice);
            if (frame.isFinal === true) return this.finish();
            const nextId = choice.next || this._getNextFrameId(frame);
            if (!nextId) return this.finish();
            await this.goToFrame(nextId, { choiceId: choice.id });
            return;
        }

        await this._advanceAfterContinueVote(frame);
    }

    async _resolveLeaderVotes() {
        if (this._resolvingVote) return;
        this._resolvingVote = true;
        const frame = this._getFrame(this.currentFrameId);
        if (!frame) return this.finish();
        const activeParticipants = new Set(this._activeParticipantIds());
        const votes = [...this._leaderVotes.entries()].filter(([userId]) => activeParticipants.has(userId)).map(([, vote]) => vote);
        const hasChoiceVote = votes.some(vote => vote.action === "choice");
        if (hasChoiceVote) {
            const choiceId = this._pickMajorityChoice(votes);
            const choices = Array.isArray(frame.choices) ? frame.choices : [];
            const choice = choices.find(item => item.id === choiceId);
            if (choice) this._applyChoiceEffect(choice);
            if (frame.isFinal === true) return this.finish();
            const nextId = (choice && choice.next) || this._getNextFrameId(frame);
            if (!nextId) return this.finish();
            await this.goToFrame(nextId, { choiceId });
            return;
        }
        await this._advanceAfterContinueVote(frame);
    }

    _pickMajorityChoice(votes) {
        const counts = new Map();
        for (const vote of votes) {
            if (vote.action !== "choice" || !vote.choiceId) continue;
            counts.set(vote.choiceId, (counts.get(vote.choiceId) || 0) + 1);
        }
        let max = 0;
        for (const count of counts.values()) max = Math.max(max, count);
        const tied = [...counts.entries()].filter(([, count]) => count === max).map(([choiceId]) => choiceId);
        if (!tied.length) return "";
        return tied[Math.floor(Math.random() * tied.length)];
    }

    async _advanceAfterContinueVote(frame) {
        const blocks = getFrameTextBlocks(frame);
        if (this.currentTextIndex < blocks.length - 1) {
            await this._goToTextBlock(this.currentTextIndex + 1);
            return;
        }
        if (frame.isFinal === true) return this.finish();
        if (frame.type === "choice") {
            this._resolvingVote = false;
            return;
        }
        const nextId = this._getNextFrameId(frame);
        if (!nextId) return this.finish();
        await this.goToFrame(nextId);
    }

    _applyFrameEffect(frame) {
        this.counterState = applyFrameCounterEffect(frame, this.counterState);
    }

    _applyChoiceEffect(choice) {
        this.counterState = applyChoiceCounterEffect(choice, this.counterState);
    }

    _applyChoiceEffectById(choiceId) {
        if (!choiceId) return;
        const choice = this._getChoice(this.currentFrameId, choiceId);
        if (choice) this._applyChoiceEffect(choice);
    }

    async finish() {
        if (this._finishing) return;
        this._finishing = true;
        const synchronized = this.networked && (this.mode === PLAYER_MODES.GM || this.mode === PLAYER_MODES.VOTE);
        if (synchronized && this._isLeader()) VNSocket.close(this.scene.id);
        await this.close({ force: true });
    }

    async close(options = {}) {
        this._disposed = true;
        this._preloader?.cancel();
        this._cancelTypingAnimation();
        if (this._preloadProgressRaf !== null) cancelAnimationFrame(this._preloadProgressRaf);
        this._preloadProgressRaf = null;
        await this._flushVolumeSettings();
        if (this._keyboardElement) {
            this._keyboardElement.removeEventListener("keydown", this._onKeyboardKeydown);
            this._keyboardElement = null;
        }
        if (this._resizeBound) {
            window.removeEventListener("resize", this._onWindowResize);
            this._resizeBound = false;
        }
        this.audio.destroy();
        VNPlayerApp.active.delete(this.scene.id);
        VNPlayerApp.pendingStarts.delete(this.scene.id);
        VNPlayerApp.pendingAdvances.delete(this.scene.id);
        return super.close(options);
    }

    static _onNext(event, target) {
        event.preventDefault();
        void this.next();
    }

    static _onChoose(event, target) {
        event.preventDefault();
        void this.choose(target.dataset.choiceId);
    }

    static _onCloseCutscene(event, target) {
        event.preventDefault();
        void this.requestClose();
    }

    static _onToggleVolumePanel(event, target) {
        event.preventDefault();
        this._volumePanelOpen = !this._volumePanelOpen;
        this.render();
    }

    static _onHideContent(event, target) {
        event.preventDefault();
        event.stopPropagation();
        this._setContentHidden(true);
    }

    static _onShowContent(event, target) {
        event.preventDefault();
        event.stopPropagation();
        this._setContentHidden(false);
    }
}

VNPlayerApp.active = new Map();
VNPlayerApp.pendingStarts = new Set();
VNPlayerApp.pendingAdvances = new Map();
VNPlayerApp.rejoinOffers = new Map();
VNPlayerApp.DEFAULT_OPTIONS = {
    id: "fbl-vn-player",
    classes: ["fbl-vn-player-app"],
    tag: "section",
    window: {
        frame: false
    },
    position: {
        width: window.innerWidth,
        height: window.innerHeight,
        top: 0,
        left: 0
    },
    actions: {
        next: VNPlayerApp._onNext,
        choose: VNPlayerApp._onChoose,
        closeCutscene: VNPlayerApp._onCloseCutscene,
        toggleVolumePanel: VNPlayerApp._onToggleVolumePanel,
        hideContent: VNPlayerApp._onHideContent,
        showContent: VNPlayerApp._onShowContent
    }
};
VNPlayerApp.PARTS = {
    main: {
        template: `modules/${MODULE_ID}/templates/player.hbs`
    }
};
