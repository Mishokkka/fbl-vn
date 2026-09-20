import { AUDIO_ACTIONS, MODULE_ID, SETTINGS } from "../utils/constants.js";

export class VNAudioController {
    constructor() {
        this.music = new Map();
        this.sfx = new Map();
        this.voice = null;
        this.voicePath = "";
        this._externalPaused = false;
        this._externalSnapshots = [];
        this._volumeOverrides = new Map();
    }

    async applyFrame(frame) {
        if (!frame) return;
        await this._applyCues("music", frame.musicCues);
        await this._applyCues("sfx", frame.sfxCues);
    }

    async _applyCues(kind, cues) {
        for (const cue of Array.isArray(cues) ? cues : []) {
            if (cue.action === AUDIO_ACTIONS.STOP_ALL) {
                this.stopAll(kind);
                continue;
            }
            if (cue.action === AUDIO_ACTIONS.STOP) {
                this.stopChannel(kind, cue.channel);
                continue;
            }
            if (cue.action === AUDIO_ACTIONS.PLAY && cue.channel && cue.src) {
                await this.playChannel(kind, cue.channel, cue.src, cue.loop === true);
            }
        }
    }

    async playChannel(kind, channel, path, loop = false) {
        const key = String(channel || "").trim();
        if (!key || !path) return;
        const bank = this._bank(kind);
        this.stopChannel(kind, key);

        const audio = new Audio(path);
        const entry = { audio, path, loop: loop === true };
        bank.set(key, entry);
        audio.loop = entry.loop;
        audio.volume = kind === "music" ? this.getMusicVolume() : this.getSfxVolume();

        if (!entry.loop) {
            audio.addEventListener("ended", () => {
                if (bank.get(key) === entry) bank.delete(key);
            }, { once: true });
        }

        try {
            await audio.play();
        }
        catch (error) {
            if (bank.get(key) === entry) bank.delete(key);
            console.warn(`${MODULE_ID} | ${kind === "music" ? "Music" : "SFX"} playback failed or was blocked: ${path}`, error);
        }
    }

    async playMusic(path, channel = "music-1", loop = true) {
        return this.playChannel("music", channel, path, loop);
    }

    playSfx(path, channel = "sfx-1", loop = false) {
        return this.playChannel("sfx", channel, path, loop);
    }

    async playVoice(path) {
        if (!path) return;
        this.stopVoice();
        this.voicePath = path;
        this.voice = new Audio(path);
        this.voice.loop = false;
        this.voice.volume = this.getVoiceVolume();
        try {
            await this.voice.play();
        }
        catch (error) {
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
        for (const entry of this.music.values()) entry.audio.volume = this.getMusicVolume();
        for (const entry of this.sfx.values()) entry.audio.volume = this.getSfxVolume();
        if (this.voice) this.voice.volume = this.getVoiceVolume();
    }

    _bank(kind) {
        return kind === "sfx" ? this.sfx : this.music;
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

    pauseExternalAudio() {
        if (this._externalPaused) return;
        this._externalPaused = true;
        this._externalSnapshots = [];
        this._pauseFoundrySounds();
    }

    _pauseFoundrySounds() {
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
                this._externalSnapshots.push({
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
        const snapshots = this._externalSnapshots.splice(0);
        this._externalPaused = false;
        for (const snapshot of snapshots) snapshot.resume?.();
    }

    stopChannel(kind, channel) {
        const key = String(channel || "").trim();
        if (!key) return;
        const bank = this._bank(kind);
        const entry = bank.get(key);
        if (!entry) return;
        try {
            entry.audio.pause();
            entry.audio.currentTime = 0;
        }
        catch (_error) {
            // Nothing else to clean up.
        }
        bank.delete(key);
    }

    stopAll(kind) {
        const bank = this._bank(kind);
        for (const channel of [...bank.keys()]) this.stopChannel(kind, channel);
    }

    stopMusic(channel = "") {
        if (channel) this.stopChannel("music", channel);
        else this.stopAll("music");
    }

    stopSfx(channel = "") {
        if (channel) this.stopChannel("sfx", channel);
        else this.stopAll("sfx");
    }

    stopVoice() {
        if (!this.voice) return;
        this.voice.pause();
        this.voice.currentTime = 0;
        this.voice = null;
        this.voicePath = "";
    }

    destroy() {
        this.stopAll("music");
        this.stopAll("sfx");
        this.stopVoice();
        this.restoreExternalAudio();
    }
}
