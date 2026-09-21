import { collectAssetPaths, collectFrameAssetPaths, collectFrameEntryAssetPaths } from "../data/schema.js";

const IMAGE_EXT = /\.(webp|avif|png|jpe?g|gif|svg)(?:[?#].*)?$/i;
const AUDIO_EXT = /\.(ogg|oga|opus|mp3|wav|flac|m4a|aac|webm)(?:[?#].*)?$/i;
const PRELOAD_TIMEOUT_MS = 5000;
const STARTUP_WINDOW_DEPTH = 2;
const STARTUP_WINDOW_MAX_FRAMES = 12;
const STARTUP_CONCURRENCY = 6;
const BACKGROUND_CONCURRENCY = 2;

function uniquePaths(paths) {
    return [...new Set((Array.isArray(paths) ? paths : []).filter(path => typeof path === "string" && path))];
}

export class VNPreloader {
    static collectPaths(scene) {
        return collectAssetPaths(scene);
    }

    static collectFramePaths(frame) {
        return collectFrameAssetPaths(frame);
    }

    static collectFrameEntryPaths(frame, textIndex = 0) {
        return collectFrameEntryAssetPaths(frame, textIndex);
    }

    static isImagePath(path) {
        return IMAGE_EXT.test(String(path || ""));
    }

    static isAudioPath(path) {
        return AUDIO_EXT.test(String(path || ""));
    }

    static collectWindowFrameIds(scene, startFrameId = "", { depth = STARTUP_WINDOW_DEPTH, maxFrames = STARTUP_WINDOW_MAX_FRAMES } = {}) {
        const frames = scene && Array.isArray(scene.frames) ? scene.frames : [];
        if (!frames.length) return [];
        const frameById = new Map(frames.map(frame => [frame.id, frame]));
        const nextSequentialById = new Map();
        const previousByBranch = new Map();
        for (const frame of frames) {
            const branchId = frame.branchId || "";
            const previous = previousByBranch.get(branchId);
            if (previous?.id && frame.id) nextSequentialById.set(previous.id, frame.id);
            previousByBranch.set(branchId, frame);
        }

        const first = (startFrameId && frameById.get(startFrameId))
            || (scene?.startFrame && frameById.get(scene.startFrame))
            || frames[0];
        if (!first?.id) return [];

        const safeDepth = Math.max(0, Number.isFinite(Number(depth)) ? Math.floor(Number(depth)) : STARTUP_WINDOW_DEPTH);
        const safeMaxFrames = Math.max(1, Number.isFinite(Number(maxFrames)) ? Math.floor(Number(maxFrames)) : STARTUP_WINDOW_MAX_FRAMES);
        const visited = new Set();
        const result = [];
        const queue = [{ id: first.id, depth: 0 }];
        let cursor = 0;

        while (cursor < queue.length && result.length < safeMaxFrames) {
            const item = queue[cursor++];
            if (!item?.id || visited.has(item.id)) continue;
            const frame = frameById.get(item.id);
            if (!frame) continue;
            visited.add(item.id);
            result.push(item.id);
            if (item.depth >= safeDepth || frame.isFinal === true) continue;

            for (const nextId of this._candidateNextFrameIds(frame, frameById, nextSequentialById)) {
                if (!visited.has(nextId)) queue.push({ id: nextId, depth: item.depth + 1 });
            }
        }
        return result;
    }

    static collectWindowPaths(scene, startFrameId = "", options = {}) {
        const frameIds = this.collectWindowFrameIds(scene, startFrameId, options);
        const frameById = new Map((Array.isArray(scene?.frames) ? scene.frames : []).map(frame => [frame.id, frame]));
        const paths = new Set();
        for (const frameId of frameIds) {
            const frame = frameById.get(frameId);
            for (const path of this.collectFramePaths(frame)) paths.add(path);
        }
        return [...paths];
    }

    static collectStartupWindowPaths(scene, startFrameId = "", options = {}) {
        const frameIds = this.collectWindowFrameIds(scene, startFrameId, options);
        const frameById = new Map((Array.isArray(scene?.frames) ? scene.frames : []).map(frame => [frame.id, frame]));
        const paths = new Set();
        for (const frameId of frameIds) {
            const frame = frameById.get(frameId);
            for (const path of this.collectFrameEntryPaths(frame, 0)) paths.add(path);
        }
        return [...paths];
    }

    static collectBackgroundImagePaths(scene) {
        return this.collectPaths(scene).filter(path => this.isImagePath(path));
    }

    static _candidateNextFrameIds(frame, frameById, nextSequentialById) {
        if (!frame || frame.isFinal === true) return [];
        const result = [];
        const add = id => {
            if (id && frameById.has(id) && !result.includes(id)) result.push(id);
        };
        const sequential = nextSequentialById.get(frame.id) || "";
        const routing = frame.nextRouting && typeof frame.nextRouting === "object" ? frame.nextRouting : null;

        if (routing?.enabled === true) {
            add(routing.trueFrameId);
            add(routing.falseFrameId);
            if (!routing.trueFrameId || !frameById.has(routing.trueFrameId)) add(sequential);
            if (!routing.falseFrameId || !frameById.has(routing.falseFrameId)) add(sequential);
        }
        else {
            if (frame.next && frameById.has(frame.next)) add(frame.next);
            else add(sequential);
        }

        for (const choice of Array.isArray(frame.choices) ? frame.choices : []) {
            if (choice?.next && frameById.has(choice.next)) add(choice.next);
        }
        return result;
    }

    static async preloadScene(scene, onProgress = null, paths = null) {
        const assetPaths = Array.isArray(paths) ? paths : this.collectPaths(scene);
        const controller = new VNPreloadController(scene);
        return controller.ensurePaths(assetPaths, { concurrency: STARTUP_CONCURRENCY, onProgress });
    }

    static _withTimeout(promise, timeoutMs, path) {
        let timer = null;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Preload timeout after ${timeoutMs}ms: ${path}`)), timeoutMs);
        });
        return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    }

    static preloadPath(path) {
        if (!path) return Promise.resolve();
        if (this.isImagePath(path)) return this.preloadImage(path);
        if (this.isAudioPath(path)) return this.preloadAudio(path);
        return Promise.resolve();
    }

    static preloadImage(path) {
        return new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(path);
            image.onerror = () => reject(new Error(`Image load failed: ${path}`));
            image.src = path;
        });
    }

    static preloadAudio(path) {
        return new Promise((resolve, reject) => {
            const audio = new Audio();
            let settled = false;
            const cleanup = () => {
                audio.removeEventListener("canplaythrough", success);
                audio.removeEventListener("loadeddata", success);
                audio.removeEventListener("error", failure);
            };
            const settle = callback => {
                if (settled) return;
                settled = true;
                cleanup();
                callback();
            };
            const success = () => settle(() => resolve(path));
            const failure = () => settle(() => reject(new Error(`Audio load failed: ${path}`)));
            audio.preload = "auto";
            audio.addEventListener("canplaythrough", success, { once: true });
            audio.addEventListener("loadeddata", success, { once: true });
            audio.addEventListener("error", failure, { once: true });
            audio.src = path;
            audio.load();
        });
    }
}

export class VNPreloadController {
    constructor(scene) {
        this.scene = scene;
        this.loaded = new Set();
        this.inflight = new Map();
        this.cancelled = false;
        this.backgroundPromise = null;
    }

    async ensurePaths(paths, { concurrency = STARTUP_CONCURRENCY, onProgress = null } = {}) {
        const assetPaths = uniquePaths(paths);
        if (!assetPaths.length) return [];
        let done = 0;
        let cursor = 0;
        const results = new Array(assetPaths.length);
        const workerCount = Math.min(Math.max(1, Number(concurrency) || 1), assetPaths.length);
        const worker = async () => {
            while (!this.cancelled && cursor < assetPaths.length) {
                const index = cursor++;
                const path = assetPaths[index];
                const result = await this._ensurePath(path);
                results[index] = result;
                done += 1;
                onProgress?.({ done, total: assetPaths.length, path, result });
            }
        };
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
        return results.filter(Boolean);
    }

    ensureFrame(frame, options = {}) {
        return this.ensurePaths(VNPreloader.collectFramePaths(frame), options);
    }

    ensureFrameEntry(frame, textIndex = 0, options = {}) {
        return this.ensurePaths(VNPreloader.collectFrameEntryPaths(frame, textIndex), options);
    }

    warmWindow(startFrameId, { depth = STARTUP_WINDOW_DEPTH, maxFrames = STARTUP_WINDOW_MAX_FRAMES, concurrency = STARTUP_CONCURRENCY } = {}) {
        const frame = (Array.isArray(this.scene?.frames) ? this.scene.frames : []).find(item => item?.id === startFrameId) || null;
        const paths = new Set(VNPreloader.collectStartupWindowPaths(this.scene, startFrameId, { depth, maxFrames }));
        for (const path of VNPreloader.collectFramePaths(frame)) paths.add(path);
        return this.ensurePaths([...paths], { concurrency });
    }

    startBackgroundImages() {
        if (this.backgroundPromise) return this.backgroundPromise;
        const paths = VNPreloader.collectBackgroundImagePaths(this.scene);
        this.backgroundPromise = this.ensurePaths(paths, { concurrency: BACKGROUND_CONCURRENCY })
            .catch(error => {
                console.warn("fbl-vn-cutscenes | Background image preload failed.", error);
                return [];
            });
        return this.backgroundPromise;
    }

    cancel() {
        this.cancelled = true;
    }

    async _ensurePath(path) {
        if (!path) return { path, ok: true };
        if (this.loaded.has(path)) return { path, ok: true, cached: true };
        if (this.inflight.has(path)) return this.inflight.get(path);

        const promise = VNPreloader._withTimeout(VNPreloader.preloadPath(path), PRELOAD_TIMEOUT_MS, path)
            .then(() => {
                const result = { path, ok: true };
                this.loaded.add(path);
                return result;
            })
            .catch(error => {
                const result = { path, ok: false, error: error?.message ?? String(error) };
                console.warn(`fbl-vn-cutscenes | Failed to preload asset: ${path}`, error);
                return result;
            })
            .finally(() => this.inflight.delete(path));
        this.inflight.set(path, promise);
        return promise;
    }
}
