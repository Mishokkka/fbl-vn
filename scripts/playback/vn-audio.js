import { AUDIO_ACTIONS, MODULE_ID, SETTINGS } from "../utils/constants.js";

function clampMs(value, max = 60000) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(max, number));
}

function clampRepeatCount(value) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) ? Math.max(1, Math.min(20, number)) : 1;
}

export class VNAudioController {
    constructor() {
        this.music = new Map();
        this.sfx = new Map();
        this.voice = null;
        this.voicePath = "";
        this._externalPaused = false;
        this._volumeOverrides = new Map();
        this._pending = new Map();
        this._retiring = new Set();
        this._frameGeneration = 0;
        this._destroyed = false;
    }

    async applyFrame(frame) {
        if (!frame || this._destroyed) return;
        this._frameGeneration += 1;
        this._cancelStaleFrameTasks();
        await this._applyCues("music", frame.musicCues, this._frameGeneration);
        await this._applyCues("sfx", frame.sfxCues, this._frameGeneration);
    }

    async applyCue(kind, cue, { generation = this._frameGeneration } = {}) {
        if (!cue || this._destroyed) return;
        if (cue.action === AUDIO_ACTIONS.STOP_ALL) {
            void this.stopAll(kind, cue.fadeOutMs);
            return;
        }
        if (cue.action === AUDIO_ACTIONS.STOP) {
            void this.stopChannel(kind, cue.channel, cue.fadeOutMs);
            return;
        }
        if (cue.action === AUDIO_ACTIONS.PLAY && cue.channel && cue.src) {
            return this.playChannel(kind, cue.channel, cue.src, cue.loop === true, {
                repeatCount: cue.repeatCount,
                repeatDelayMs: cue.repeatDelayMs,
                startDelayMs: cue.startDelayMs,
                fadeInMs: cue.fadeInMs,
                crossFadeMs: cue.crossFadeMs,
                continueRepeats: cue.continueRepeats === true,
                generation
            });
        }
    }

    async _applyCues(kind, cues, generation) {
        for (const cue of Array.isArray(cues) ? cues : []) {
            await this.applyCue(kind, cue, { generation });
        }
    }

    async playChannel(kind, channel, path, loop = false, options = {}) {
        const key = String(channel || "").trim();
        if (!key || !path || this._destroyed) return null;
        const normalized = {
            repeatCount: loop === true ? 1 : clampRepeatCount(options.repeatCount),
            repeatDelayMs: loop === true ? 0 : clampMs(options.repeatDelayMs),
            startDelayMs: clampMs(options.startDelayMs),
            fadeInMs: clampMs(options.fadeInMs),
            crossFadeMs: clampMs(options.crossFadeMs),
            continueRepeats: loop === true ? false : options.continueRepeats === true,
            generation: Number.isFinite(Number(options.generation)) ? Number(options.generation) : this._frameGeneration
        };

        const pendingKey = this._entryKey(kind, key);
        this._cancelPending(pendingKey);

        const entry = this._createEntry(kind, key, path, loop === true, normalized);
        if (normalized.startDelayMs > 0) {
            entry.delayTimer = setTimeout(() => {
                entry.delayTimer = null;
                if (this._pending.get(pendingKey) !== entry || this._destroyed) return;
                this._pending.delete(pendingKey);
                if (!entry.continueRepeats && entry.generation !== this._frameGeneration) return;
                void this._startEntry(entry);
            }, normalized.startDelayMs);
            this._pending.set(pendingKey, entry);
            return entry;
        }

        await this._startEntry(entry);
        return entry;
    }

    _createEntry(kind, channel, path, loop, options) {
        const audio = new Audio(path);
        const entry = {
            kind,
            channel,
            audio,
            path,
            loop,
            repeatCount: options.repeatCount,
            repeatDelayMs: options.repeatDelayMs,
            fadeInMs: options.fadeInMs,
            crossFadeMs: options.crossFadeMs,
            continueRepeats: options.continueRepeats,
            generation: options.generation,
            playsStarted: 0,
            gain: 1,
            delayTimer: null,
            repeatTimer: null,
            awaitingRepeat: false,
            fadeRaf: null,
            fadeGeneration: 0,
            fadeResolve: null,
            stopped: false,
            endedHandler: null
        };
        audio.loop = loop;
        entry.endedHandler = () => this._onEntryEnded(entry);
        if (!loop) audio.addEventListener("ended", entry.endedHandler);
        return entry;
    }

    async _startEntry(entry) {
        if (!entry || entry.stopped || this._destroyed) return;
        const bank = this._bank(entry.kind);
        const previous = bank.get(entry.channel) || null;
        const crossFadeMs = previous && previous !== entry ? entry.crossFadeMs : 0;

        if (previous && previous !== entry) {
            if (crossFadeMs > 0) {
                bank.delete(entry.channel);
                this._retiring.add(previous);
                void this._fadeEntry(previous, 0, crossFadeMs).then(completed => {
                    if (completed) this._retireEntry(previous);
                });
            }
            else {
                this._retireEntry(previous);
            }
        }

        bank.set(entry.channel, entry);
        const incomingFadeMs = crossFadeMs > 0 ? crossFadeMs : (entry.fadeInMs > 0 ? entry.fadeInMs : (!previous && entry.crossFadeMs > 0 ? entry.crossFadeMs : 0));
        entry.gain = incomingFadeMs > 0 ? 0 : 1;
        this._applyEntryVolume(entry);

        try {
            entry.playsStarted += 1;
            entry.audio.currentTime = 0;
            await entry.audio.play();
            if (entry.stopped || this._destroyed || bank.get(entry.channel) !== entry) {
                try {
                    entry.audio.pause();
                    entry.audio.currentTime = 0;
                }
                catch (_error) {
                    // Playback was already detached while play() was pending.
                }
                return;
            }
            if (incomingFadeMs > 0) void this._fadeEntry(entry, 1, incomingFadeMs);
        }
        catch (error) {
            const stillOwned = !entry.stopped && !this._destroyed && bank.get(entry.channel) === entry;
            if (!stillOwned) return;
            this._retireEntry(entry);
            console.warn(`${MODULE_ID} | ${entry.kind === "music" ? "Music" : "SFX"} playback failed or was blocked: ${entry.path}`, error);
        }
    }

    _onEntryEnded(entry) {
        if (!entry || entry.stopped || entry.loop || this._destroyed) return;
        const bank = this._bank(entry.kind);
        if (bank.get(entry.channel) !== entry) return;
        if (entry.playsStarted >= entry.repeatCount) {
            bank.delete(entry.channel);
            this._retireEntry(entry);
            return;
        }
        if (!entry.continueRepeats && entry.generation !== this._frameGeneration) {
            bank.delete(entry.channel);
            this._retireEntry(entry);
            return;
        }

        entry.awaitingRepeat = true;
        const replay = async () => {
            entry.repeatTimer = null;
            entry.awaitingRepeat = false;
            if (entry.stopped || this._destroyed || bank.get(entry.channel) !== entry) return;
            if (!entry.continueRepeats && entry.generation !== this._frameGeneration) {
                bank.delete(entry.channel);
                this._retireEntry(entry);
                return;
            }
            try {
                entry.audio.currentTime = 0;
                entry.playsStarted += 1;
                await entry.audio.play();
                if (entry.stopped || this._destroyed || bank.get(entry.channel) !== entry) {
                    try {
                        entry.audio.pause();
                        entry.audio.currentTime = 0;
                    }
                    catch (_error) {
                        // Playback was already detached while play() was pending.
                    }
                }
            }
            catch (error) {
                const stillOwned = !entry.stopped && !this._destroyed && bank.get(entry.channel) === entry;
                if (!stillOwned) return;
                bank.delete(entry.channel);
                this._retireEntry(entry);
                console.warn(`${MODULE_ID} | Repeated ${entry.kind} playback failed: ${entry.path}`, error);
            }
        };

        if (entry.repeatDelayMs > 0) entry.repeatTimer = setTimeout(() => void replay(), entry.repeatDelayMs);
        else void replay();
    }

    async playMusic(path, channel = "music-1", loop = true, options = {}) {
        return this.playChannel("music", channel, path, loop, options);
    }

    playSfx(path, channel = "sfx-1", loop = false, options = {}) {
        return this.playChannel("sfx", channel, path, loop, options);
    }

    async playVoice(path) {
        if (!path || this._destroyed) return;
        this.stopVoice();
        const voice = new Audio(path);
        this.voicePath = path;
        this.voice = voice;
        voice.loop = false;
        voice.volume = this.getVoiceVolume();
        try {
            await voice.play();
            if (this._destroyed || this.voice !== voice) {
                try {
                    voice.pause();
                    voice.currentTime = 0;
                }
                catch (_error) {
                    // Voice was already detached while play() was pending.
                }
            }
        }
        catch (error) {
            if (this._destroyed || this.voice !== voice) return;
            this.stopVoice();
            console.warn(`${MODULE_ID} | Voice playback failed or was blocked.`, error);
        }
    }

    getMusicVolume() {
        return this._volume("globalPlaylistVolume", 0.5, SETTINGS.MUSIC_VOLUME, "music");
    }

    getVoiceVolume() {
        return this._volume("globalInterfaceVolume", 0.8, SETTINGS.VOICE_VOLUME, "voice");
    }

    getSfxVolume() {
        return this._volume("globalAmbientVolume", 0.8, SETTINGS.SFX_VOLUME, "sfx");
    }

    setVolumeMultiplier(type, value) {
        if (!type) return;
        const normalized = Math.max(0, Math.min(1, Number(value || 0)));
        this._volumeOverrides.set(type, normalized);
        this.refreshVolumes();
    }

    clearVolumeOverride(type) {
        if (!type) return;
        this._volumeOverrides.delete(type);
        this.refreshVolumes();
    }

    refreshVolumes() {
        for (const entry of this.music.values()) this._applyEntryVolume(entry);
        for (const entry of this.sfx.values()) this._applyEntryVolume(entry);
        for (const entry of this._retiring) this._applyEntryVolume(entry);
        if (this.voice) this.voice.volume = this.getVoiceVolume();
    }

    _applyEntryVolume(entry) {
        if (!entry?.audio) return;
        const base = entry.kind === "music" ? this.getMusicVolume() : this.getSfxVolume();
        entry.audio.volume = Math.max(0, Math.min(1, base * Math.max(0, Math.min(1, Number(entry.gain ?? 1)))));
    }

    _bank(kind) {
        return kind === "sfx" ? this.sfx : this.music;
    }

    _entryKey(kind, channel) {
        return `${kind}:${String(channel || "").trim()}`;
    }

    _volume(coreSetting, fallback, moduleSetting, type) {
        const core = this._numberSetting("core", coreSetting, fallback);
        const override = type ? this._volumeOverrides.get(type) : undefined;
        const multiplier = typeof override === "number" ? override : (moduleSetting ? this._numberSetting(MODULE_ID, moduleSetting, 1) : 1);
        return Math.max(0, Math.min(1, core * multiplier));
    }

    _numberSetting(namespace, setting, fallback) {
        try {
            if (game.settings && game.settings.get) {
                const value = game.settings.get(namespace, setting);
                if (typeof value === "number" && Number.isFinite(value)) return value;
            }
        }
        catch (_error) {
            return fallback;
        }
        return fallback;
    }

    _cancelPending(key) {
        const pending = this._pending.get(key);
        if (!pending) return;
        if (pending.delayTimer) clearTimeout(pending.delayTimer);
        pending.delayTimer = null;
        pending.stopped = true;
        this._pending.delete(key);
        this._detachEntry(pending);
    }

    _cancelStaleFrameTasks() {
        for (const [key, entry] of [...this._pending.entries()]) {
            if (entry.generation === this._frameGeneration) continue;
            this._cancelPending(key);
        }
        for (const bank of [this.music, this.sfx]) {
            for (const entry of [...bank.values()]) {
                if (!entry.repeatTimer || entry.continueRepeats || entry.generation === this._frameGeneration) continue;
                clearTimeout(entry.repeatTimer);
                entry.repeatTimer = null;
                entry.awaitingRepeat = false;
                this._retireEntry(entry);
            }
        }
    }

    _detachEntry(entry) {
        if (!entry) return;
        if (entry.endedHandler && entry.audio?.removeEventListener) entry.audio.removeEventListener("ended", entry.endedHandler);
        entry.endedHandler = null;
    }

    _retireEntry(entry) {
        if (!entry || entry.stopped) return;
        entry.stopped = true;
        if (entry.delayTimer) clearTimeout(entry.delayTimer);
        if (entry.repeatTimer) clearTimeout(entry.repeatTimer);
        entry.fadeGeneration += 1;
        if (entry.fadeResolve) {
            const resolveFade = entry.fadeResolve;
            entry.fadeResolve = null;
            resolveFade(false);
        }
        if (entry.fadeRaf !== null && entry.fadeRaf !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(entry.fadeRaf);
        entry.delayTimer = null;
        entry.repeatTimer = null;
        entry.fadeRaf = null;
        this._detachEntry(entry);
        try {
            entry.audio.pause();
            entry.audio.currentTime = 0;
        }
        catch (_error) {
            // Audio may already be detached.
        }
        const bank = this._bank(entry.kind);
        if (bank.get(entry.channel) === entry) bank.delete(entry.channel);
        this._retiring.delete(entry);
    }

    _fadeEntry(entry, targetGain, durationMs) {
        const duration = clampMs(durationMs);
        const target = Math.max(0, Math.min(1, Number(targetGain)));
        if (!entry || entry.stopped || duration <= 0) {
            if (entry && !entry.stopped) {
                entry.gain = target;
                this._applyEntryVolume(entry);
                return Promise.resolve(true);
            }
            return Promise.resolve(false);
        }

        if (entry.fadeResolve) {
            const resolvePrevious = entry.fadeResolve;
            entry.fadeResolve = null;
            resolvePrevious(false);
        }
        if (entry.fadeRaf !== null && entry.fadeRaf !== undefined && typeof cancelAnimationFrame === "function") {
            cancelAnimationFrame(entry.fadeRaf);
            entry.fadeRaf = null;
        }

        const startGain = Math.max(0, Math.min(1, Number(entry.gain ?? 1)));
        const nowValue = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
        const startedAt = nowValue();
        const raf = typeof requestAnimationFrame === "function"
            ? requestAnimationFrame
            : callback => setTimeout(() => callback(nowValue()), 16);
        const fadeGeneration = ++entry.fadeGeneration;

        return new Promise(resolve => {
            entry.fadeResolve = resolve;
            const finish = completed => {
                if (entry.fadeGeneration === fadeGeneration) {
                    entry.fadeRaf = null;
                    entry.fadeResolve = null;
                }
                resolve(completed);
            };
            const step = now => {
                if (entry.stopped || entry.fadeGeneration !== fadeGeneration) return finish(false);
                const elapsed = Math.max(0, Number(now) - startedAt);
                const progress = Math.min(1, elapsed / duration);
                entry.gain = startGain + ((target - startGain) * progress);
                this._applyEntryVolume(entry);
                if (progress >= 1) {
                    finish(true);
                    return;
                }
                entry.fadeRaf = raf(step);
            };
            entry.fadeRaf = raf(step);
        });
    }

    pauseExternalAudio() {
        if (this._externalPaused) return;
        this._externalPaused = true;
        if (!VNAudioController._externalPauseOwners.size) {
            VNAudioController._externalSnapshots = this._pauseFoundrySounds();
        }
        VNAudioController._externalPauseOwners.add(this);
    }

    _pauseFoundrySounds() {
        const snapshots = [];
        const sounds = this._collectSoundObjects(game.audio?.playing)
            .concat(this._collectSoundObjects(foundry.audio?.AudioHelper?.playing));
        const seen = new Set();
        for (const sound of sounds) {
            if (!sound || seen.has(sound)) continue;
            seen.add(sound);
            if (sound === this.voice) continue;
            if (sound.playing !== true || typeof sound.pause !== "function") continue;
            try {
                sound.pause();
                snapshots.push({
                    type: "sound",
                    resume: () => {
                        try {
                            if (typeof sound.play === "function") {
                                const result = sound.play();
                                if (result && typeof result.catch === "function") result.catch(error => console.warn(`${MODULE_ID} | Failed to resume Foundry sound.`, error));
                            }
                        }
                        catch (error) {
                            console.warn(`${MODULE_ID} | Failed to resume Foundry sound.`, error);
                        }
                    }
                });
            }
            catch (error) {
                console.warn(`${MODULE_ID} | Failed to pause Foundry sound.`, error);
            }
        }
        return snapshots;
    }

    _collectSoundObjects(source) {
        if (!source) return [];
        if (source instanceof Map) return [...source.values()];
        if (source instanceof Set) return [...source.values()];
        if (Array.isArray(source)) return source;
        if (typeof source === "object") return Object.values(source);
        return [];
    }

    restoreExternalAudio() {
        if (!this._externalPaused) return;
        this._externalPaused = false;
        VNAudioController._externalPauseOwners.delete(this);
        if (VNAudioController._externalPauseOwners.size) return;
        const snapshots = VNAudioController._externalSnapshots.splice(0);
        for (const snapshot of snapshots) snapshot.resume?.();
    }

    async stopChannel(kind, channel, fadeOutMs = 0) {
        const key = String(channel || "").trim();
        if (!key) return;
        this._cancelPending(this._entryKey(kind, key));
        const bank = this._bank(kind);
        const active = bank.get(key) || null;
        if (active) bank.delete(key);
        const entries = new Set([
            ...(active ? [active] : []),
            ...[...this._retiring].filter(entry => entry.kind === kind && entry.channel === key)
        ]);
        if (!entries.size) return;

        const duration = clampMs(fadeOutMs);
        await Promise.all([...entries].map(async entry => {
            if (!entry || entry.stopped) return;
            if (duration > 0) {
                this._retiring.add(entry);
                await this._fadeEntry(entry, 0, duration);
            }
            this._retireEntry(entry);
        }));
    }

    async stopAll(kind, fadeOutMs = 0) {
        const prefix = `${kind}:`;
        for (const key of [...this._pending.keys()]) {
            if (key.startsWith(prefix)) this._cancelPending(key);
        }
        const bank = this._bank(kind);
        const channels = new Set([
            ...bank.keys(),
            ...[...this._retiring].filter(entry => entry.kind === kind).map(entry => entry.channel)
        ]);
        await Promise.all([...channels].map(channel => this.stopChannel(kind, channel, fadeOutMs)));
    }

    stopMusic(channel = "", fadeOutMs = 0) {
        if (channel) return this.stopChannel("music", channel, fadeOutMs);
        return this.stopAll("music", fadeOutMs);
    }

    stopSfx(channel = "", fadeOutMs = 0) {
        if (channel) return this.stopChannel("sfx", channel, fadeOutMs);
        return this.stopAll("sfx", fadeOutMs);
    }

    stopVoice() {
        if (!this.voice) return;
        this.voice.pause();
        this.voice.currentTime = 0;
        this.voice = null;
        this.voicePath = "";
    }

    async fadeOutAll(durationMs = 0) {
        const duration = clampMs(durationMs, 10000);
        await Promise.all([this.stopAll("music", duration), this.stopAll("sfx", duration)]);
        this.stopVoice();
    }

    destroy() {
        this._destroyed = true;
        for (const key of [...this._pending.keys()]) this._cancelPending(key);
        for (const entry of [...this.music.values(), ...this.sfx.values(), ...this._retiring]) this._retireEntry(entry);
        this.music.clear();
        this.sfx.clear();
        this._retiring.clear();
        this.stopVoice();
        this.restoreExternalAudio();
    }
}

VNAudioController._externalPauseOwners = new Set();
VNAudioController._externalSnapshots = [];
