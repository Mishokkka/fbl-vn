import { VNSceneStore } from "../data/scene-store.js";
import { createCharacterPreset, createCharacterPortrait, sanitizeCharacter } from "../data/schema.js";
import { MODULE_ID } from "../utils/constants.js";
import { confirmDialog, duplicateData, notify } from "../utils/foundry-helpers.js";
import { VNAssetPickerApp } from "./asset-picker-app.js";

const ApplicationV2 = foundry.applications.api.ApplicationV2;
const HandlebarsApplicationMixin = foundry.applications.api.HandlebarsApplicationMixin;

const CHARACTER_SCOPE_ALL = "__all__";
const CHARACTER_SCOPE_SHARED = "__shared__";
const CHARACTER_SCENE_SHARED = "*";

export class VNCharacterManagerApp extends HandlebarsApplicationMixin(ApplicationV2) {
    constructor(options = {}) {
        super(options);
        this.editor = options.editor || null;
        this.expandedCharacterIds = new Set();
        this.selectedScope = options.scope || this.editor?.selectedSceneId || CHARACTER_SCOPE_ALL;
    }

    _sceneUsageIndex(data) {
        const usage = new Map();
        const register = (characterId, sceneId) => {
            const id = String(characterId || "");
            if (!id || !sceneId) return;
            if (!usage.has(id)) usage.set(id, new Set());
            usage.get(id).add(sceneId);
        };

        for (const scene of Array.isArray(data?.scenes) ? data.scenes : []) {
            if (!scene?.id) continue;
            for (const frame of Array.isArray(scene.frames) ? scene.frames : []) {
                register(frame?.characterId, scene.id);
                for (const character of Array.isArray(frame?.additionalCharacters) ? frame.additionalCharacters : []) {
                    register(character?.characterId, scene.id);
                }
            }
        }
        return usage;
    }

    _effectiveCharacterScope(character, usageIndex, validSceneIds) {
        const explicitSceneId = String(character?.sceneId || "");
        if (explicitSceneId === CHARACTER_SCENE_SHARED) return CHARACTER_SCOPE_SHARED;
        if (validSceneIds.has(explicitSceneId)) return explicitSceneId;

        const usedInScenes = usageIndex.get(character?.id);
        if (usedInScenes?.size === 1) {
            const [sceneId] = usedInScenes;
            if (validSceneIds.has(sceneId)) return sceneId;
        }
        return CHARACTER_SCOPE_SHARED;
    }

    _scopeOptions(scenes, characters, usageIndex, validSceneIds) {
        const counts = new Map([[CHARACTER_SCOPE_SHARED, 0]]);
        for (const scene of scenes) counts.set(scene.id, 0);
        for (const character of characters) {
            const scope = this._effectiveCharacterScope(character, usageIndex, validSceneIds);
            counts.set(scope, Number(counts.get(scope) || 0) + 1);
        }

        const preferredSceneId = this.editor?.selectedSceneId || "";
        const orderedScenes = [...scenes].sort((a, b) => {
            if (a.id === preferredSceneId) return -1;
            if (b.id === preferredSceneId) return 1;
            return String(a.title || "").localeCompare(String(b.title || ""), "ru");
        });
        const options = orderedScenes.map(scene => ({
            value: scene.id,
            label: `${scene.id === preferredSceneId ? "Текущая катсцена" : "Катсцена"}: ${scene.title || "Без названия"} (${counts.get(scene.id) || 0})`,
            selected: this.selectedScope === scene.id
        }));
        options.push({
            value: CHARACTER_SCOPE_SHARED,
            label: `Общие / между катсценами (${counts.get(CHARACTER_SCOPE_SHARED) || 0})`,
            selected: this.selectedScope === CHARACTER_SCOPE_SHARED
        });
        options.push({
            value: CHARACTER_SCOPE_ALL,
            label: `Все персонажи (${characters.length})`,
            selected: this.selectedScope === CHARACTER_SCOPE_ALL
        });
        return options;
    }

    _characterSceneOptions(scenes, selectedScope) {
        const selectedSceneId = selectedScope === CHARACTER_SCOPE_SHARED ? CHARACTER_SCENE_SHARED : selectedScope;
        return [
            {
                value: CHARACTER_SCENE_SHARED,
                label: "Общий / между катсценами",
                selected: selectedSceneId === CHARACTER_SCENE_SHARED
            },
            ...scenes.map(scene => ({
                value: scene.id,
                label: scene.title || "Без названия",
                selected: selectedSceneId === scene.id
            }))
        ];
    }

    async _prepareContext(options) {
        const context = await super._prepareContext(options);
        const data = VNSceneStore.data;
        const scenes = (Array.isArray(data.scenes) ? data.scenes : []).map(scene => ({
            id: scene.id,
            title: scene.title || "Без названия"
        }));
        const validSceneIds = new Set(scenes.map(scene => scene.id));
        const validScopes = new Set([CHARACTER_SCOPE_ALL, CHARACTER_SCOPE_SHARED, ...validSceneIds]);
        if (!validScopes.has(this.selectedScope)) {
            const editorSceneId = this.editor?.selectedSceneId || "";
            this.selectedScope = validSceneIds.has(editorSceneId) ? editorSceneId : CHARACTER_SCOPE_ALL;
        }

        const usageIndex = this._sceneUsageIndex(data);
        const allCharacters = Array.isArray(data.characters) ? data.characters : [];
        const characters = allCharacters
            .filter(character => {
                if (this.selectedScope === CHARACTER_SCOPE_ALL) return true;
                return this._effectiveCharacterScope(character, usageIndex, validSceneIds) === this.selectedScope;
            })
            .map(character => {
                const copy = duplicateData(character);
                const effectiveScope = this._effectiveCharacterScope(copy, usageIndex, validSceneIds);
                copy.portraits = Array.isArray(copy.portraits) ? copy.portraits : [];
                copy.positionOptions = this._positionOptions(copy.defaultPosition);
                copy.sceneOptions = this._characterSceneOptions(scenes, effectiveScope);
                copy.portraitCount = copy.portraits.length;
                copy.expanded = this.expandedCharacterIds.has(copy.id);
                return copy;
            });

        return Object.assign(context, {
            characters,
            hasCharacters: characters.length > 0,
            isFiltered: this.selectedScope !== CHARACTER_SCOPE_ALL,
            scopeOptions: this._scopeOptions(scenes, allCharacters, usageIndex, validSceneIds),
            visibleCharacterCount: characters.length,
            totalCharacterCount: allCharacters.length
        });
    }

    _positionOptions(selected) {
        const pairs = [["auto", "Стандарт / не задано"], ["left", "Слева"], ["center", "По центру"], ["right", "Справа"]];
        return pairs.map(pair => ({ value: pair[0], label: pair[1], selected: pair[0] === selected }));
    }

    _captureExpandedCharacters() {
        if (!this.element) return;
        for (const row of this.element.querySelectorAll("[data-character-row]")) {
            const characterId = row.dataset.characterId;
            if (!characterId) continue;
            if (row.dataset.expanded === "true") this.expandedCharacterIds.add(characterId);
            else this.expandedCharacterIds.delete(characterId);
        }
    }

    _attachPartListeners(partId, htmlElement, options) {
        super._attachPartListeners(partId, htmlElement, options);
        if (partId !== "main") return;

        const scopeFilter = htmlElement.querySelector("[data-character-scope-filter]");
        if (scopeFilter) {
            scopeFilter.addEventListener("change", async () => {
                this._captureExpandedCharacters();
                await this._commitCharacters();
                this.selectedScope = scopeFilter.value || CHARACTER_SCOPE_ALL;
                this.render();
            });
        }

        for (const input of htmlElement.querySelectorAll("[data-character-name]")) {
            input.addEventListener("input", () => {
                const row = input.closest("[data-character-row]");
                const summaryName = row ? row.querySelector("[data-character-summary-name]") : null;
                if (summaryName) summaryName.textContent = input.value.trim() || "Без имени";
            });
        }
    }

    _readCharacters() {
        const storedCharacters = VNSceneStore.characters;
        if (!this.element) return storedCharacters;

        const byId = new Map(storedCharacters.map(character => [character.id, character]));
        const rows = [...this.element.querySelectorAll("[data-character-row]")];
        for (const row of rows) {
            const id = row.dataset.characterId;
            if (!id) continue;
            const existing = byId.get(id) || {};
            const nameInput = row.querySelector("[data-character-name]");
            const positionInput = row.querySelector("[data-character-position]");
            const sceneInput = row.querySelector("[data-character-scene]");
            const portraits = [];
            for (const portraitRow of row.querySelectorAll("[data-portrait-row]")) {
                const labelInput = portraitRow.querySelector("[data-portrait-label]");
                const pathInput = portraitRow.querySelector("[data-portrait-path]");
                portraits.push({
                    id: portraitRow.dataset.portraitId,
                    label: labelInput ? labelInput.value : "Портрет",
                    path: pathInput ? pathInput.value : ""
                });
            }
            byId.set(id, sanitizeCharacter({
                ...existing,
                id,
                name: nameInput ? nameInput.value : "Без имени",
                defaultPosition: positionInput ? positionInput.value : "auto",
                sceneId: sceneInput ? sceneInput.value : existing.sceneId || "",
                portraits
            }));
        }
        return [...byId.values()];
    }

    _newCharacterSceneId() {
        const sceneIds = new Set(VNSceneStore.sceneSummaries.map(scene => scene.id));
        if (sceneIds.has(this.selectedScope)) return this.selectedScope;
        if (this.selectedScope === CHARACTER_SCOPE_SHARED) return CHARACTER_SCENE_SHARED;
        const editorSceneId = this.editor?.selectedSceneId || "";
        if (sceneIds.has(editorSceneId)) return editorSceneId;
        return CHARACTER_SCENE_SHARED;
    }

    async _commitCharacters() {
        const characters = this._readCharacters();
        await VNSceneStore.replaceCharacters(characters);
        return characters;
    }

    _refreshEditor(parts = ["framePanel"]) {
        if (!this.editor) return;
        if (typeof this.editor._renderEditorParts === "function") this.editor._renderEditorParts(parts);
        else if (typeof this.editor.render === "function") this.editor.render();
    }

    static _onToggleCharacter(event, target) {
        event.preventDefault();
        const characterId = target.dataset.characterId;
        if (!characterId) return;
        const row = target.closest("[data-character-row]");
        if (!row) return;

        const expanded = row.dataset.expanded !== "true";
        row.dataset.expanded = expanded ? "true" : "false";
        target.setAttribute("aria-expanded", expanded ? "true" : "false");
        const body = row.querySelector("[data-character-card-body]");
        if (body) body.setAttribute("aria-hidden", expanded ? "false" : "true");
        if (expanded) this.expandedCharacterIds.add(characterId);
        else this.expandedCharacterIds.delete(characterId);
    }

    static async _onSave(event, target) {
        event.preventDefault();
        await this._commitCharacters();
        notify("VN: пресеты персонажей сохранены.");
        this._refreshEditor();
    }

    static async _onAddCharacter(event, target) {
        event.preventDefault();
        const characters = this._readCharacters();
        this._captureExpandedCharacters();
        const character = createCharacterPreset("Новый персонаж", "Основной", "", "auto", this._newCharacterSceneId());
        characters.push(character);
        this.expandedCharacterIds.add(character.id);
        await VNSceneStore.replaceCharacters(characters);
        this._refreshEditor();
        this.render();
    }

    static async _onDeleteCharacter(event, target) {
        event.preventDefault();
        const characters = this._readCharacters();
        const character = characters.find(item => item.id === target.dataset.characterId);
        if (!character) return;
        if (!await confirmDialog(`Удалить пресет «${character.name}»?`, { title: "Удаление персонажа", yes: "Удалить", no: "Отмена" })) return;
        this._captureExpandedCharacters();
        await VNSceneStore.replaceCharacters(characters.filter(item => item.id !== character.id));
        this.expandedCharacterIds.delete(character.id);
        this._refreshEditor();
        this.render();
    }

    static async _onAddPortrait(event, target) {
        event.preventDefault();
        const characters = this._readCharacters();
        const character = characters.find(item => item.id === target.dataset.characterId);
        if (!character) return;
        character.portraits.push(createCharacterPortrait("Новый портрет", ""));
        this._captureExpandedCharacters();
        this.expandedCharacterIds.add(character.id);
        await VNSceneStore.replaceCharacters(characters);
        this._refreshEditor();
        this.render();
    }

    static async _onDeletePortrait(event, target) {
        event.preventDefault();
        const characters = this._readCharacters();
        const character = characters.find(item => item.id === target.dataset.characterId);
        if (!character) return;
        character.portraits = character.portraits.filter(portrait => portrait.id !== target.dataset.portraitId);
        this._captureExpandedCharacters();
        this.expandedCharacterIds.add(character.id);
        await VNSceneStore.replaceCharacters(characters);
        this._refreshEditor();
        this.render();
    }

    static _onPickPortrait(event, target) {
        event.preventDefault();
        const inputName = target.dataset.field;
        const input = this.element ? this.element.querySelector(`[name='${inputName}']`) : null;
        if (!input) return;
        new VNAssetPickerApp({
            type: "image",
            current: input.value || "",
            label: "Портрет",
            onSelect: async (path) => {
                const freshInput = this.element ? this.element.querySelector(`[name='${inputName}']`) : null;
                if (!freshInput) return;
                freshInput.value = path;
                await this._commitCharacters();
                this._refreshEditor();
            }
        }).render(true);
    }
}

VNCharacterManagerApp.DEFAULT_OPTIONS = {
    id: "fbl-vn-character-manager",
    classes: ["fbl-vn-character-manager-app"],
    tag: "section",
    window: {
        title: "VN Character Presets",
        icon: "fa-solid fa-users-gear",
        resizable: true
    },
    position: {
        width: 920,
        height: 720
    },
    actions: {
        toggleCharacter: VNCharacterManagerApp._onToggleCharacter,
        save: VNCharacterManagerApp._onSave,
        addCharacter: VNCharacterManagerApp._onAddCharacter,
        deleteCharacter: VNCharacterManagerApp._onDeleteCharacter,
        addPortrait: VNCharacterManagerApp._onAddPortrait,
        deletePortrait: VNCharacterManagerApp._onDeletePortrait,
        pickPortrait: VNCharacterManagerApp._onPickPortrait
    }
};

VNCharacterManagerApp.PARTS = {
    main: {
        template: `modules/${MODULE_ID}/templates/character-manager.hbs`,
        scrollable: [".fbl-vn-character-list"]
    }
};
