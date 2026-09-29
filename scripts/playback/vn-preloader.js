import { collectAssetPaths, collectFrameAssetPaths, collectFrameEntryAssetPaths } from "../data/schema.js";

const IMAGE_EXT = /\.(webp|avif|png|jpe?g|gif|svg)(?:[?#].*)?$/i;
const AUDIO_EXT = /\.(ogg|oga|opus|mp3|wav|flac|m4a|aac|webm)(?:[?#].*)?$/i;
const PRELOAD_TIMEOUT_MS = 5000;
const STARTUP_WINDOW_DEPTH = 2;
const STARTUP_WINDOW_MAX_FRAMES = 12;
const STARTUP_CONCURRENCY = 6;
const NEARBY_WARM_DEPTH = 2;
const NEARBY_WARM_MAX_FRAMES = 12;
const FAR_WARM_DEFAULT_DEPTH = 10;
const FAR_WARM_MAX_FRAMES = 12;
const AUDIO_WARMER_LIMIT = 32;

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

    static _withTimeout(promise, timeoutMs, path, onTimeout = null) {
        let timer = null;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
                reject(new Error(`Preload timeout after ${timeoutMs}ms: ${path}`));
                try { onTimeout?.(); }
                catch (_error) {
                    // The underlying browser resource may already have settled.
                }
            }, timeoutMs);
        });
        return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    }

    static preloadPath(path, { decodeImage = false } = {}) {
        if (!path) return Promise.resolve();
        if (this.isImagePath(path)) return this.preloadImage(path, { decode: decodeImage });
        if (this.isAudioPath(path)) return this.preloadAudio(path);
        return Promise.resolve();
    }

    static preloadImage(path, { decode = false } = {}) {
        let cancelLoad = () => {};
        const promise = new Promise((resolve, reject) => {
            const image = new Image();
            let settled = false;
            const cleanup = () => {
                image.onload = null;
                image.onerror = null;
            };
            const release = () => {
                try {
                    if (typeof image.removeAttribute === "function") image.removeAttribute("src");
                    else image.src = "";
                }
                catch (_error) {
                    // The browser may have already released the speculative image.
                }
            };
            const settle = callback => {
                if (settled) return;
                settled = true;
                cleanup();
                callback();
            };
            image.onload = async () => {
                if (decode && typeof image.decode === "function") {
                    try { await image.decode(); }
                    catch (_error) {
                        // A successful load is still usable when explicit decode is unavailable or rejected.
                    }
                    if (settled) return;
                }
                settle(() => resolve(image));
            };
            image.onerror = () => settle(() => reject(new Error(`Image load failed: ${path}`)));
            cancelLoad = () => {
                if (settled) return;
                const error = new Error(`Image preload cancelled: ${path}`);
                error.code = "VN_PRELOAD_CANCELLED";
                settle(() => {
                    release();
                    reject(error);
                });
            };
            image.src = path;
        });
        promise.cancel = () => cancelLoad();
        return promise;
    }

    static preloadAudio(path) {
        let cancelLoad = () => {};
        const promise = new Promise((resolve, reject) => {
            const audio = new Audio();
            let settled = false;
            const cleanup = () => {
                audio.removeEventListener("canplaythrough", success);
                audio.removeEventListener("loadeddata", success);
                audio.removeEventListener("error", failure);
            };
            const release = () => {
                try {
                    audio.pause?.();
                    if (typeof audio.removeAttribute === "function") audio.removeAttribute("src");
                    else audio.src = "";
                    audio.load?.();
                }
                catch (_error) {
                    // The browser may have already released the speculative media element.
                }
            };
            const settle = callback => {
                if (settled) return;
                settled = true;
                cleanup();
                callback();
            };
            const success = () => settle(() => resolve(audio));
            const failure = () => settle(() => reject(new Error(`Audio load failed: ${path}`)));
            cancelLoad = () => {
                if (settled) return;
                const error = new Error(`Audio preload cancelled: ${path}`);
                error.code = "VN_PRELOAD_CANCELLED";
                settle(() => {
                    release();
                    reject(error);
                });
            };
            audio.preload = "auto";
            audio.addEventListener("canplaythrough", success, { once: true });
            audio.addEventListener("loadeddata", success, { once: true });
            audio.addEventListener("error", failure, { once: true });
            audio.src = path;
            audio.load();
        });
        promise.cancel = () => cancelLoad();
        return promise;
    }
}

export class VNPreloadController {
    constructor(scene) {
        this.scene = scene;
        this.loaded = new Set();
        this.decodedImages = new Set();
        this.inflight = new Map();
        this.decodeInflight = new Map();
        this.requestMeta = new Map();
        this.activeCancels = new Set();
        this.audioWarmers = new Map();
        this.cancelled = false;
        this.warmGeneration = 0;
    }

    async ensurePaths(paths, { concurrency = STARTUP_CONCURRENCY, onProgress = null, shouldContinue = null, critical = false, generation = null, decodeImages = false } = {}) {
        const assetPaths = uniquePaths(paths);
        if (!assetPaths.length) return [];
        let done = 0;
        let cursor = 0;
        const results = new Array(assetPaths.length);
        const workerCount = Math.min(Math.max(1, Number(concurrency) || 1), assetPaths.length);
        const worker = async () => {
            while (!this.cancelled && cursor < assetPaths.length && (!shouldContinue || shouldContinue())) {
                const index = cursor++;
                const path = assetPaths[index];
                const result = await this._ensurePath(path, {
                    critical,
                    generation,
                    decodeImage: decodeImages && VNPreloader.isImagePath(path)
                });
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

    warmWindow(startFrameId, { depth = STARTUP_WINDOW_DEPTH, maxFrames = STARTUP_WINDOW_MAX_FRAMES, concurrency = STARTUP_CONCURRENCY, fullFrameAssets = false, shouldContinue = null, generation = null } = {}) {
        const frame = (Array.isArray(this.scene?.frames) ? this.scene.frames : []).find(item => item?.id === startFrameId) || null;
        const collected = fullFrameAssets
            ? VNPreloader.collectWindowPaths(this.scene, startFrameId, { depth, maxFrames })
            : VNPreloader.collectStartupWindowPaths(this.scene, startFrameId, { depth, maxFrames });
        const paths = new Set(collected);
        for (const path of VNPreloader.collectFramePaths(frame)) paths.add(path);
        return this.ensurePaths([...paths], { concurrency, shouldContinue, generation });
    }

    async warmAhead(startFrameId, { depth = FAR_WARM_DEFAULT_DEPTH, maxFrames = FAR_WARM_MAX_FRAMES } = {}) {
        const safeDepth = Math.max(NEARBY_WARM_DEPTH, Math.floor(Number(depth) || FAR_WARM_DEFAULT_DEPTH));
        const safeMaxFrames = Math.max(NEARBY_WARM_MAX_FRAMES, Math.floor(Number(maxFrames) || FAR_WARM_MAX_FRAMES));
        const generation = ++this.warmGeneration;
        this._cancelStaleSpeculativeLoads(generation);
        const current = () => !this.cancelled && generation === this.warmGeneration;

        await this.warmWindow(startFrameId, {
            depth: NEARBY_WARM_DEPTH,
            maxFrames: NEARBY_WARM_MAX_FRAMES,
            concurrency: 2,
            fullFrameAssets: false,
            shouldContinue: current,
            generation
        });
        if (!current() || safeDepth <= NEARBY_WARM_DEPTH) return [];

        return this.warmWindow(startFrameId, {
            depth: safeDepth,
            maxFrames: safeMaxFrames,
            concurrency: 1,
            fullFrameAssets: true,
            shouldContinue: current,
            generation
        });
    }


    cancel() {
        if (this.cancelled) return;
        this.cancelled = true;
        this.warmGeneration += 1;
        for (const cancel of [...this.activeCancels]) {
            try { cancel(); }
            catch (_error) {
                // The browser resource may already have completed.
            }
        }
        this.activeCancels.clear();
        for (const audio of this.audioWarmers.values()) this._releaseAudioWarmer(audio);
        this.audioWarmers.clear();
    }

    _cancelStaleSpeculativeLoads(activeGeneration) {
        for (const meta of this.requestMeta.values()) {
            if (meta.critical || !Number.isFinite(Number(meta.generation)) || Number(meta.generation) >= activeGeneration) continue;
            try { meta.cancel?.(); }
            catch (_error) {
                // A stale speculative request may already have settled.
            }
        }
    }

    _trackCancel(cancel) {
        if (typeof cancel !== "function") return () => {};
        this.activeCancels.add(cancel);
        return () => this.activeCancels.delete(cancel);
    }

    _releaseImageResource(image) {
        if (!image || typeof image !== "object") return;
        try {
            if (typeof image.removeAttribute === "function") image.removeAttribute("src");
            else if ("src" in image) image.src = "";
        }
        catch (_error) {
            // The browser may have already released the speculative image.
        }
    }

    _retainAudioWarmer(path, audio) {
        if (!path || !audio) return;
        const previous = this.audioWarmers.get(path);
        if (previous && previous !== audio) this._releaseAudioWarmer(previous);
        this.audioWarmers.delete(path);
        this.audioWarmers.set(path, audio);
        while (this.audioWarmers.size > AUDIO_WARMER_LIMIT) {
            const oldest = this.audioWarmers.entries().next().value;
            if (!oldest) break;
            const [oldestPath, oldestAudio] = oldest;
            this.audioWarmers.delete(oldestPath);
            this.loaded.delete(oldestPath);
            this._releaseAudioWarmer(oldestAudio);
        }
    }

    _releaseAudioWarmer(audio) {
        if (!audio) return;
        try {
            audio.pause?.();
            if (typeof audio.removeAttribute === "function") audio.removeAttribute("src");
            else if ("src" in audio) audio.src = "";
            audio.load?.();
        }
        catch (_error) {
            // The browser may have already released the speculative media element.
        }
    }

    async _ensureDecodedImage(path) {
        if (!path || !VNPreloader.isImagePath(path)) return { path, ok: true };
        if (this.decodedImages.has(path)) return { path, ok: true, cached: true, decoded: true };
        if (this.decodeInflight.has(path)) return this.decodeInflight.get(path);

        const task = VNPreloader.preloadImage(path, { decode: true });
        const cancel = typeof task?.cancel === "function" ? () => task.cancel() : null;
        const untrack = this._trackCancel(cancel);
        const promise = VNPreloader._withTimeout(Promise.resolve(task), PRELOAD_TIMEOUT_MS, path, cancel)
            .then(image => {
                if (this.cancelled) {
                    this._releaseImageResource(image);
                    return { path, ok: false, cancelled: true };
                }
                this.loaded.add(path);
                this.decodedImages.add(path);
                return { path, ok: true, decoded: true };
            })
            .catch(error => {
                const cancelled = this.cancelled || error?.code === "VN_PRELOAD_CANCELLED";
                if (!cancelled) console.warn(`fbl-vn-cutscenes | Failed to decode critical image: ${path}`, error);
                return { path, ok: false, cancelled, error: error?.message ?? String(error) };
            })
            .finally(() => {
                untrack();
                this.decodeInflight.delete(path);
            });
        this.decodeInflight.set(path, promise);
        return promise;
    }

    async _ensurePath(path, { critical = false, generation = null, decodeImage = false } = {}) {
        if (!path) return { path, ok: true };
        if (this.cancelled) return { path, ok: false, cancelled: true };

        if (this.loaded.has(path)) {
            if (decodeImage && VNPreloader.isImagePath(path) && !this.decodedImages.has(path)) {
                return this._ensureDecodedImage(path);
            }
            return { path, ok: true, cached: true, decoded: this.decodedImages.has(path) };
        }

        if (this.inflight.has(path)) {
            const meta = this.requestMeta.get(path);
            if (critical && meta) meta.critical = true;
            const result = await this.inflight.get(path);
            if (decodeImage && result?.ok && VNPreloader.isImagePath(path) && !this.decodedImages.has(path)) {
                return this._ensureDecodedImage(path);
            }
            return result;
        }

        const task = VNPreloader.preloadPath(path, { decodeImage });
        const cancel = typeof task?.cancel === "function" ? () => task.cancel() : null;
        const untrack = this._trackCancel(cancel);
        this.requestMeta.set(path, { critical: critical === true, generation, cancel });

        const promise = VNPreloader._withTimeout(Promise.resolve(task), PRELOAD_TIMEOUT_MS, path, cancel)
            .then(resource => {
                if (this.cancelled) {
                    if (VNPreloader.isAudioPath(path)) this._releaseAudioWarmer(resource);
                    else if (VNPreloader.isImagePath(path)) this._releaseImageResource(resource);
                    return { path, ok: false, cancelled: true };
                }
                if (VNPreloader.isAudioPath(path) && resource && typeof resource === "object") {
                    this._retainAudioWarmer(path, resource);
                }
                if (decodeImage && VNPreloader.isImagePath(path)) this.decodedImages.add(path);
                this.loaded.add(path);
                return { path, ok: true, decoded: this.decodedImages.has(path) };
            })
            .catch(error => {
                const cancelled = this.cancelled || error?.code === "VN_PRELOAD_CANCELLED";
                if (!cancelled) console.warn(`fbl-vn-cutscenes | Failed to preload asset: ${path}`, error);
                return { path, ok: false, cancelled, error: error?.message ?? String(error) };
            })
            .finally(() => {
                untrack();
                this.inflight.delete(path);
                this.requestMeta.delete(path);
            });
        this.inflight.set(path, promise);

        const result = await promise;
        if (decodeImage && result?.ok && VNPreloader.isImagePath(path) && !this.decodedImages.has(path)) {
            return this._ensureDecodedImage(path);
        }
        return result;
    }

}
