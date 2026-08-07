import { collectAssetPaths } from "../data/schema.js";

const IMAGE_EXT = /\.(webp|png|jpe?g|gif|svg)$/i;
const AUDIO_EXT = /\.(ogg|mp3|wav|flac|m4a)$/i;
const PRELOAD_TIMEOUT_MS = 5000;

export class VNPreloader {
    static collectPaths(scene) {
        return collectAssetPaths(scene);
    }

    static async preloadScene(scene, onProgress = null, paths = null) {
        const assetPaths = Array.isArray(paths) ? paths : this.collectPaths(scene);
        let done = 0;
        let cursor = 0;
        const results = new Array(assetPaths.length);
        const concurrency = Math.min(6, Math.max(1, assetPaths.length));
        const worker = async () => {
            while (cursor < assetPaths.length) {
                const index = cursor;
                cursor += 1;
                const path = assetPaths[index];
                try {
                    await this._withTimeout(this.preloadPath(path), PRELOAD_TIMEOUT_MS, path);
                    results[index] = { path, ok: true };
                }
                catch (error) {
                    console.warn(`fbl-vn-cutscenes | Failed to preload asset: ${path}`, error);
                    results[index] = { path, ok: false, error: error?.message ?? String(error) };
                }
                finally {
                    done += 1;
                    onProgress?.({ done, total: assetPaths.length, path, result: results[index] });
                }
            }
        };
        await Promise.all(Array.from({ length: concurrency }, () => worker()));
        return results;
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
        if (IMAGE_EXT.test(path)) return this.preloadImage(path);
        if (AUDIO_EXT.test(path)) return this.preloadAudio(path);
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
        return new Promise((resolve) => {
            const audio = new Audio();
            let settled = false;
            const cleanup = () => {
                audio.removeEventListener("canplaythrough", success);
                audio.removeEventListener("loadeddata", success);
                audio.removeEventListener("error", failSoft);
            };
            const success = () => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(path);
            };
            const failSoft = () => success();
            audio.preload = "auto";
            audio.addEventListener("canplaythrough", success, { once: true });
            audio.addEventListener("loadeddata", success, { once: true });
            audio.addEventListener("error", failSoft, { once: true });
            audio.src = path;
            audio.load();
            setTimeout(success, 3000);
        });
    }
}
