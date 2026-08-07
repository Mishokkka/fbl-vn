import { MODULE_ID, MUSIC_MODES, SETTINGS } from "../utils/constants.js";

export class VNAudioController {
    constructor() {
        this.music = null;
        this.musicPath = "";
        this.voice = null;
        this.voicePath = "";
        this._externalPaused = false;
        this._externalSnapshots = [];
        this._volumeOverrides = new Map();
    }

    async applyFrame(frame) {
        if (!frame) return;
        if (frame.musicMode === MUSIC_MODES.STOP) this.stopMusic();
        else if (frame.musicMode === MUSIC_MODES.PLAY && frame.music) await this.playMusic(frame.music);
        if (frame.sfx) this.playSfx(frame.sfx);
    }

    async playMusic(path) {
        if (!path) return;
        if (this.musicPath === path && this.music && !this.music.paused) return;
        this.stopMusic();
        this.musicPath = path;
        this.music = new Audio(path);
        this.music.loop = true;
        this.music.volume = this.getMusicVolume();
        try {
            await this.music.play();
        }
        catch (error) {
            console.warn(`${MODULE_ID} | Music playback was blocked until user interaction.`, error);
        }
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

    playSfx(path) {
        if (!path) return;
        const volume = this.getSfxVolume();
        if (foundry.audio?.AudioHelper?.play) {
            foundry.audio.AudioHelper.play({ src: path, volume, autoplay: true, loop: false }, false);
            return;
        }
        const audio = new Audio(path);
        audio.volume = volume;
        audio.play().catch(error => console.warn(`${MODULE_ID} | SFX playback failed.`, error));
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
        if (this.music) this.music.volume = this.getMusicVolume();
        if (this.voice) this.voice.volume = this.getVoiceVolume();
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
            if (sound === this.music || sound === this.voice) continue;
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

    stopMusic() {
        if (!this.music) return;
        this.music.pause();
        this.music.currentTime = 0;
        this.music = null;
        this.musicPath = "";
    }

    stopVoice() {
        if (!this.voice) return;
        this.voice.pause();
        this.voice.currentTime = 0;
        this.voice = null;
        this.voicePath = "";
    }

    destroy() {
        this.stopMusic();
        this.stopVoice();
        this.restoreExternalAudio();
    }
}
