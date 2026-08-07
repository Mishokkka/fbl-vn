import { DATA_SCHEMA_VERSION, DEFAULT_DATA, MODULE_ID, SETTINGS } from "../utils/constants.js";
import { duplicateData, randomId } from "../utils/foundry-helpers.js";
import { createAssetRecord, createCharacterPreset, createSampleScene, sanitizeAsset, sanitizeCharacter, sanitizeScene } from "./schema.js";
import { migrateData } from "./migrations.js";

export class VNSceneStore {
    static _hasSetting(key) {
        return Boolean(game.settings?.settings?.has?.(`${MODULE_ID}.${key}`));
    }

    static _registerSetting(key, config) {
        if (this._hasSetting(key)) return;
        game.settings.register(MODULE_ID, key, config);
    }

    static registerSettings() {
        this._registerSetting(SETTINGS.DATA, {
            name: "VN: данные катсцен",
            scope: "world",
            config: false,
            type: Object,
            default: duplicateData(DEFAULT_DATA),
            onChange: () => this.invalidateCache()
        });
        this._registerSetting(SETTINGS.PRELOAD_WAIT_MS, {
            name: "VN: ожидание предзагрузки",
            hint: "Сколько миллисекунд ГМ ждёт предзагрузку ассетов у активных клиентов перед синхронным стартом катсцены.",
            scope: "world",
            config: true,
            type: Number,
            default: 10000,
            restricted: true
        });
        this._registerSetting(SETTINGS.MUSIC_VOLUME, {
            name: "VN: громкость музыки",
            hint: "Множитель громкости музыки VN после общего уровня громкости плейлистов Foundry.",
            scope: "client",
            config: true,
            type: Number,
            range: { min: 0, max: 1, step: 0.05 },
            default: 1
        });
        this._registerSetting(SETTINGS.VOICE_VOLUME, {
            name: "VN: громкость голосов",
            hint: "Множитель громкости голосовых реплик VN после общего уровня громкости интерфейса Foundry.",
            scope: "client",
            config: true,
            type: Number,
            range: { min: 0, max: 1, step: 0.05 },
            default: 1
        });
        this._registerSetting(SETTINGS.SFX_VOLUME, {
            name: "VN: громкость SFX",
            hint: "Множитель громкости звуковых эффектов VN после общего уровня громкости окружения Foundry.",
            scope: "client",
            config: true,
            type: Number,
            range: { min: 0, max: 1, step: 0.05 },
            default: 1
        });
        this._registerSetting(SETTINGS.DISABLE_TRANSITIONS, {
            name: "VN: отключить анимации",
            hint: "Локально отключает переходы, движения портретов и печатание текста по буквам.",
            scope: "client",
            config: true,
            type: Boolean,
            default: false
        });
        this._registerSetting(SETTINGS.INSTANT_TEXT, {
            name: "VN: мгновенный текст",
            hint: "Локально показывает реплики целиком без эффекта печатной машинки.",
            scope: "client",
            config: true,
            type: Boolean,
            default: false
        });
    }

    static _getSnapshot() {
        if (this._cache) return this._cache;
        const stored = game.settings.get(MODULE_ID, SETTINGS.DATA) || duplicateData(DEFAULT_DATA);
        const clean = this._sanitizeData(stored);
        this._setCache(clean);
        return this._cache;
    }

    static _setCache(clean) {
        this._cache = clean;
        this._sceneById = new Map(clean.scenes.map(scene => [scene.id, scene]));
        this._assetById = new Map(clean.assets.map(asset => [asset.id, asset]));
        this._characterById = new Map(clean.characters.map(character => [character.id, character]));
    }

    static get data() {
        return duplicateData(this._getSnapshot());
    }

    static _sanitizeData(data) {
        let migrated;
        try {
            migrated = migrateData(data || DEFAULT_DATA);
        }
        catch (error) {
            console.warn(`${MODULE_ID} | Stored VN data is damaged. Falling back to empty data.`, error);
            migrated = duplicateData(DEFAULT_DATA);
        }
        const clean = duplicateData(migrated || DEFAULT_DATA);
        clean.schemaVersion = DATA_SCHEMA_VERSION;
        clean.version = Number(clean.version || 3);
        clean.scenes = Array.isArray(clean.scenes) ? clean.scenes.map(sanitizeScene) : [];
        clean.assets = Array.isArray(clean.assets) ? clean.assets.map(sanitizeAsset).filter(asset => asset.path) : [];
        clean.characters = Array.isArray(clean.characters) ? clean.characters.map(sanitizeCharacter) : [];
        return clean;
    }

    static invalidateCache() {
        this._cache = null;
        this._sceneById = null;
        this._assetById = null;
        this._characterById = null;
    }

    static _sameData(a, b) {
        try {
            return JSON.stringify(a) === JSON.stringify(b);
        }
        catch (_error) {
            return false;
        }
    }

    static async setData(data) {
        const clean = this._sanitizeData(data || DEFAULT_DATA);
        clean.schemaVersion = DATA_SCHEMA_VERSION;
        clean.version = 3;
        const current = this._getSnapshot();
        if (this._sameData(clean, current)) return duplicateData(clean);
        await game.settings.set(MODULE_ID, SETTINGS.DATA, clean);
        this._setCache(clean);
        Hooks.callAll(`${MODULE_ID}.dataChanged`, duplicateData(clean));
        return duplicateData(clean);
    }

    static get scenes() {
        return duplicateData(this._getSnapshot().scenes);
    }

    static get assets() {
        return duplicateData(this._getSnapshot().assets);
    }

    static get characters() {
        return duplicateData(this._getSnapshot().characters);
    }

    static getScene(sceneId) {
        this._getSnapshot();
        const scene = this._sceneById.get(sceneId);
        return scene ? duplicateData(scene) : null;
    }

    static getCharacter(characterId) {
        this._getSnapshot();
        const character = this._characterById.get(characterId);
        return character ? duplicateData(character) : null;
    }

    static getAsset(assetId) {
        this._getSnapshot();
        const asset = this._assetById.get(assetId);
        return asset ? duplicateData(asset) : null;
    }

    static async upsertScene(scene) {
        const data = this.data;
        const clean = sanitizeScene(scene);
        const index = data.scenes.findIndex(item => item.id === clean.id);
        if (index >= 0) data.scenes[index] = clean;
        else data.scenes.push(clean);
        await this.setData(data);
        return duplicateData(clean);
    }

    static async deleteScene(sceneId) {
        const data = this.data;
        data.scenes = data.scenes.filter(scene => scene.id !== sceneId);
        await this.setData(data);
    }

    static async rememberAsset(type, path, label) {
        if (!path) return null;
        const data = this.data;
        const existing = data.assets.find(asset => asset.type === type && asset.path === path);
        if (existing) {
            if (label) existing.label = label;
            existing.lastUsed = Date.now();
            await this.setData(data);
            return duplicateData(existing);
        }
        const asset = createAssetRecord(type, path, label);
        data.assets.push(asset);
        await this.setData(data);
        return duplicateData(asset);
    }

    static async upsertAsset(asset) {
        const data = this.data;
        const clean = sanitizeAsset(asset);
        if (!clean.path) return null;
        const index = data.assets.findIndex(item => item.id === clean.id || (item.type === clean.type && item.path === clean.path));
        if (index >= 0) {
            clean.id = data.assets[index].id;
            clean.favorite = clean.favorite || data.assets[index].favorite;
            data.assets[index] = clean;
        }
        else data.assets.push(clean);
        await this.setData(data);
        return duplicateData(clean);
    }

    static async toggleAssetFavorite(assetId) {
        const data = this.data;
        const asset = data.assets.find(item => item.id === assetId);
        if (!asset) return null;
        asset.favorite = !asset.favorite;
        asset.lastUsed = Date.now();
        await this.setData(data);
        return duplicateData(asset);
    }

    static async deleteAsset(assetId) {
        const data = this.data;
        data.assets = data.assets.filter(asset => asset.id !== assetId);
        await this.setData(data);
    }

    static async upsertCharacter(character) {
        const data = this.data;
        const clean = sanitizeCharacter(character);
        const index = data.characters.findIndex(item => item.id === clean.id);
        if (index >= 0) data.characters[index] = clean;
        else data.characters.push(clean);
        await this.setData(data);
        return duplicateData(clean);
    }

    static async saveCharacterFromFrame(frame, portraitLabel) {
        if (!frame) return null;
        const name = frame.speaker || "Без имени";
        const data = this.data;
        let character = data.characters.find(item => item.name.toLowerCase() === name.toLowerCase());
        if (!character) {
            character = createCharacterPreset(name, portraitLabel || "Основной", frame.portrait || "", frame.portraitPosition || "center");
            data.characters.push(character);
        }
        else {
            character.defaultPosition = frame.portraitPosition || character.defaultPosition || "center";
            if (frame.portrait) {
                const existing = character.portraits.find(portrait => portrait.path === frame.portrait);
                if (existing) existing.label = portraitLabel || existing.label || "Основной";
                else character.portraits.push({ id: randomId("portrait"), label: portraitLabel || "Портрет", path: frame.portrait });
            }
        }
        await this.setData(data);
        return duplicateData(character);
    }

    static async deleteCharacter(characterId) {
        const data = this.data;
        data.characters = data.characters.filter(character => character.id !== characterId);
        for (const scene of data.scenes) {
            const frames = Array.isArray(scene.frames) ? scene.frames : [];
            for (const frame of frames) {
                if (frame.characterId === characterId) {
                    frame.characterId = "";
                    frame.portraitId = "";
                }
            }
        }
        await this.setData(data);
    }

    static async importData(imported, { replace = false } = {}) {
        const data = replace ? duplicateData(DEFAULT_DATA) : this.data;
        const importedScenes = Array.isArray(imported && imported.scenes) ? imported.scenes : Array.isArray(imported) ? imported : [imported];
        for (const scene of importedScenes) {
            if (!scene) continue;
            const clean = sanitizeScene(scene);
            const index = data.scenes.findIndex(item => item.id === clean.id);
            if (index >= 0) data.scenes[index] = clean;
            else data.scenes.push(clean);
        }
        const importedAssets = Array.isArray(imported && imported.assets) ? imported.assets : [];
        for (const asset of importedAssets) {
            const clean = sanitizeAsset(asset);
            if (!clean.path) continue;
            const index = data.assets.findIndex(item => item.id === clean.id || (item.type === clean.type && item.path === clean.path));
            if (index >= 0) data.assets[index] = clean;
            else data.assets.push(clean);
        }
        const importedCharacters = Array.isArray(imported && imported.characters) ? imported.characters : [];
        for (const character of importedCharacters) {
            const clean = sanitizeCharacter(character);
            const index = data.characters.findIndex(item => item.id === clean.id || item.name === clean.name);
            if (index >= 0) data.characters[index] = clean;
            else data.characters.push(clean);
        }
        return this.setData(data);
    }

    static async ensureSampleScene() {
        if (this._getSnapshot().scenes.length) return null;
        const scene = createSampleScene();
        await this.upsertScene(scene);
        return scene;
    }
}

VNSceneStore._cache = null;
VNSceneStore._sceneById = null;
VNSceneStore._assetById = null;
VNSceneStore._characterById = null;
