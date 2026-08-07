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
        this._registerSetting(SETTINGS.STORAGE_JOURNAL_ID, {
            name: "VN: служебное хранилище",
            scope: "world",
            config: false,
            type: String,
            default: ""
        });
        this._registerSetting(SETTINGS.PRELOAD_WAIT_MS, {
            name: "VN: ожидание предзагрузки",
            hint: "Сколько миллисекунд ГМ ждёт предзагрузку ассетов у активных клиентов перед синхронным стартом катсцены.",
            scope: "world",
            config: true,
            type: Number,
            default: 10000,
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

    static _hasMeaningfulData(data) {
        if (!data || typeof data !== "object") return false;
        return Boolean((Array.isArray(data.scenes) && data.scenes.length) || (Array.isArray(data.assets) && data.assets.length) || (Array.isArray(data.characters) && data.characters.length));
    }

    static _getStorageJournalClass() {
        return globalThis.CONFIG?.JournalEntry?.documentClass ?? globalThis.JournalEntry ?? null;
    }

    static _isStorageAuthority() {
        if (!game.user?.isGM) return false;
        const activeGM = game.users?.activeGM;
        return !activeGM || activeGM.id === game.user.id;
    }

    static _findStorageDocument() {
        const journal = game.journal;
        if (!journal) return null;
        const configuredId = game.settings.get(MODULE_ID, SETTINGS.STORAGE_JOURNAL_ID) || "";
        const configured = configuredId ? journal.get?.(configuredId) : null;
        if (configured) return configured;
        return journal.find?.(entry => entry?.getFlag?.(MODULE_ID, "storage") === true) ?? null;
    }

    static _bindStorageHooks() {
        if (this._storageHooksBound) return;
        this._storageHooksBound = true;
        Hooks.on("createJournalEntry", document => {
            if (document?.getFlag?.(MODULE_ID, "storage") !== true) return;
            const configuredId = game.settings.get(MODULE_ID, SETTINGS.STORAGE_JOURNAL_ID) || "";
            if (configuredId && configuredId !== document.id) return;
            this._storageDocument = document;
            this._storageReady = true;
            const clean = this._sanitizeData(document.getFlag?.(MODULE_ID, "data") || DEFAULT_DATA);
            this._setCache(clean);
        });
        Hooks.on("updateJournalEntry", document => {
            if (!this._storageDocument || document?.id !== this._storageDocument.id) return;
            const clean = this._sanitizeData(document.getFlag?.(MODULE_ID, "data") || DEFAULT_DATA);
            this._setCache(clean);
            Hooks.callAll(`${MODULE_ID}.dataChanged`, duplicateData(clean));
        });
        Hooks.on("deleteJournalEntry", document => {
            if (!this._storageDocument || document?.id !== this._storageDocument.id) return;
            this._storageDocument = null;
            this._storageReady = false;
            ui.notifications?.warn?.("VN: служебное хранилище катсцен было удалено. Оно будет создано заново при следующем сохранении.");
        });
    }

    static async initializeStorage() {
        if (!game.user?.isGM) {
            this._storageReady = false;
            this._storageDocument = null;
            this.invalidateCache();
            return null;
        }
        if (this._storageReady && this._storageDocument) return this._storageDocument;
        if (!game.ready || !game.journal) return null;
        this._bindStorageHooks();
        let document = this._findStorageDocument();
        const legacyStored = game.settings.get(MODULE_ID, SETTINGS.DATA) || duplicateData(DEFAULT_DATA);
        const legacyData = this._sanitizeData(legacyStored);
        if (!document) {
            if (!this._isStorageAuthority()) {
                console.warn(`${MODULE_ID} | Private VN storage is not ready yet. Waiting for the active GM to initialize it.`);
                return null;
            }
            const JournalClass = this._getStorageJournalClass();
            if (!JournalClass?.create) {
                console.error(`${MODULE_ID} | JournalEntry API is unavailable; private VN storage cannot be initialized.`);
                return null;
            }
            try {
                document = await JournalClass.create({
                    name: "[FBL VN] Cutscene Data",
                    ownership: { default: globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.NONE ?? 0 },
                    flags: {
                        [MODULE_ID]: {
                            storage: true,
                            data: legacyData
                        }
                    }
                });
            }
            catch (error) {
                console.error(`${MODULE_ID} | Failed to create private JournalEntry storage. VN writes are disabled to avoid exposing cutscene data through world settings.`, error);
                return null;
            }
        }
        this._storageDocument = document;
        const storedData = document.getFlag?.(MODULE_ID, "data");
        let clean = this._sanitizeData(storedData || DEFAULT_DATA);
        if (!this._hasMeaningfulData(clean) && this._hasMeaningfulData(legacyData) && this._isStorageAuthority()) {
            await document.setFlag(MODULE_ID, "data", legacyData);
            clean = legacyData;
        }
        if (this._isStorageAuthority() && game.settings.get(MODULE_ID, SETTINGS.STORAGE_JOURNAL_ID) !== document.id) {
            await game.settings.set(MODULE_ID, SETTINGS.STORAGE_JOURNAL_ID, document.id);
        }
        if (this._isStorageAuthority() && this._hasMeaningfulData(legacyData)) {
            await game.settings.set(MODULE_ID, SETTINGS.DATA, duplicateData(DEFAULT_DATA));
        }
        this._setCache(clean);
        this._storageReady = true;
        return document;
    }

    static _getSnapshot() {
        if (!game.user?.isGM) {
            const clean = duplicateData(DEFAULT_DATA);
            this._setCache(clean);
            return this._cache;
        }
        if (this._cache) return this._cache;
        const stored = this._storageDocument?.getFlag?.(MODULE_ID, "data") ?? game.settings.get(MODULE_ID, SETTINGS.DATA) ?? duplicateData(DEFAULT_DATA);
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

    static async _setDataImmediate(data) {
        const clean = this._sanitizeData(data || DEFAULT_DATA);
        clean.schemaVersion = DATA_SCHEMA_VERSION;
        clean.version = 3;
        const current = this._getSnapshot();
        if (this._sameData(clean, current)) return duplicateData(clean);
        if (!game.user?.isGM) throw new Error("VN data can only be modified by a GM.");
        if (game.ready && !this._storageDocument) await this.initializeStorage();
        const usingJournalStorage = Boolean(this._storageDocument?.setFlag);
        if (game.ready && !usingJournalStorage) {
            const message = "VN: приватное хранилище катсцен недоступно. Данные не сохранены, чтобы не раскрыть их через world settings.";
            ui.notifications?.error?.(message);
            throw new Error("VN private storage is unavailable. Data was not saved to avoid exposing cutscene content through world settings.");
        }
        if (usingJournalStorage) await this._storageDocument.setFlag(MODULE_ID, "data", clean);
        else await game.settings.set(MODULE_ID, SETTINGS.DATA, clean);
        this._setCache(clean);
        if (!usingJournalStorage) Hooks.callAll(`${MODULE_ID}.dataChanged`, duplicateData(clean));
        return duplicateData(clean);
    }

    static _enqueueMutation(operation) {
        const run = this._mutationQueue.then(operation, operation);
        this._mutationQueue = run.catch(error => {
            console.error(`${MODULE_ID} | VN data mutation failed.`, error);
        });
        return run;
    }

    static setData(data) {
        if (!game.user?.isGM) return Promise.reject(new Error("VN data can only be modified by a GM."));
        const snapshot = duplicateData(data || DEFAULT_DATA);
        return this._enqueueMutation(() => this._setDataImmediate(snapshot));
    }

    static mutateData(mutator) {
        if (!game.user?.isGM) return Promise.reject(new Error("VN data can only be modified by a GM."));
        if (typeof mutator !== "function") return Promise.reject(new TypeError("VN data mutator must be a function."));
        return this._enqueueMutation(async () => {
            const data = this.data;
            const result = await mutator(data);
            await this._setDataImmediate(data);
            return duplicateData(result);
        });
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

    static upsertScene(scene) {
        const clean = sanitizeScene(scene);
        return this.mutateData(data => {
            const index = data.scenes.findIndex(item => item.id === clean.id);
            if (index >= 0) data.scenes[index] = clean;
            else data.scenes.push(clean);
            return clean;
        });
    }

    static deleteScene(sceneId) {
        return this.mutateData(data => {
            data.scenes = data.scenes.filter(scene => scene.id !== sceneId);
            return null;
        });
    }

    static rememberAsset(type, path, label) {
        if (!path) return Promise.resolve(null);
        return this.mutateData(data => {
            const existing = data.assets.find(asset => asset.type === type && asset.path === path);
            if (existing) {
                if (label) existing.label = label;
                existing.lastUsed = Date.now();
                return existing;
            }
            const asset = createAssetRecord(type, path, label);
            data.assets.push(asset);
            return asset;
        });
    }

    static upsertAsset(asset) {
        const clean = sanitizeAsset(asset);
        if (!clean.path) return Promise.resolve(null);
        return this.mutateData(data => {
            const index = data.assets.findIndex(item => item.id === clean.id || (item.type === clean.type && item.path === clean.path));
            if (index >= 0) {
                clean.id = data.assets[index].id;
                clean.favorite = clean.favorite || data.assets[index].favorite;
                data.assets[index] = clean;
            }
            else data.assets.push(clean);
            return clean;
        });
    }

    static toggleAssetFavorite(assetId) {
        return this.mutateData(data => {
            const asset = data.assets.find(item => item.id === assetId);
            if (!asset) return null;
            asset.favorite = !asset.favorite;
            asset.lastUsed = Date.now();
            return asset;
        });
    }

    static deleteAsset(assetId) {
        return this.mutateData(data => {
            data.assets = data.assets.filter(asset => asset.id !== assetId);
            return null;
        });
    }

    static upsertCharacter(character) {
        const clean = sanitizeCharacter(character);
        return this.mutateData(data => {
            const index = data.characters.findIndex(item => item.id === clean.id);
            if (index >= 0) data.characters[index] = clean;
            else data.characters.push(clean);
            return clean;
        });
    }

    static replaceCharacters(characters) {
        const cleanCharacters = Array.isArray(characters) ? characters.map(sanitizeCharacter) : [];
        return this.mutateData(data => {
            data.characters = cleanCharacters;
            return cleanCharacters;
        });
    }

    static saveCharacterFromFrame(frame, portraitLabel) {
        if (!frame) return Promise.resolve(null);
        const name = frame.speaker || "Без имени";
        return this.mutateData(data => {
            let character = data.characters.find(item => String(item.name || "").toLowerCase() === String(name || "").toLowerCase());
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
            return character;
        });
    }

    static deleteCharacter(characterId) {
        return this.mutateData(data => {
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
            return null;
        });
    }

    static importData(imported, { replace = false } = {}) {
        const importedSnapshot = duplicateData(imported);
        return this.mutateData(data => {
            if (replace) {
                data.schemaVersion = DEFAULT_DATA.schemaVersion;
                data.version = DEFAULT_DATA.version;
                data.scenes = [];
                data.assets = [];
                data.characters = [];
            }
            const importedScenes = Array.isArray(importedSnapshot && importedSnapshot.scenes) ? importedSnapshot.scenes : Array.isArray(importedSnapshot) ? importedSnapshot : [importedSnapshot];
            for (const scene of importedScenes) {
                if (!scene) continue;
                const clean = sanitizeScene(scene);
                const index = data.scenes.findIndex(item => item.id === clean.id);
                if (index >= 0) data.scenes[index] = clean;
                else data.scenes.push(clean);
            }
            const importedAssets = Array.isArray(importedSnapshot && importedSnapshot.assets) ? importedSnapshot.assets : [];
            for (const asset of importedAssets) {
                const clean = sanitizeAsset(asset);
                if (!clean.path) continue;
                const index = data.assets.findIndex(item => item.id === clean.id || (item.type === clean.type && item.path === clean.path));
                if (index >= 0) data.assets[index] = clean;
                else data.assets.push(clean);
            }
            const importedCharacters = Array.isArray(importedSnapshot && importedSnapshot.characters) ? importedSnapshot.characters : [];
            for (const character of importedCharacters) {
                const clean = sanitizeCharacter(character);
                const index = data.characters.findIndex(item => item.id === clean.id || item.name === clean.name);
                if (index >= 0) data.characters[index] = clean;
                else data.characters.push(clean);
            }
            return data;
        });
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

VNSceneStore._storageDocument = null;
VNSceneStore._storageReady = false;
VNSceneStore._storageHooksBound = false;

VNSceneStore._mutationQueue = Promise.resolve();
