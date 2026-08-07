import { VNSceneStore } from "../data/scene-store.js";
import { createCharacterPreset, createCharacterPortrait, sanitizeCharacter } from "../data/schema.js";
import { MODULE_ID } from "../utils/constants.js";
import { confirmDialog, duplicateData, notify } from "../utils/foundry-helpers.js";
import { VNAssetPickerApp } from "./asset-picker-app.js";

const ApplicationV2 = foundry.applications.api.ApplicationV2;
const HandlebarsApplicationMixin = foundry.applications.api.HandlebarsApplicationMixin;

export class VNCharacterManagerApp extends HandlebarsApplicationMixin(ApplicationV2) {
    constructor(options = {}) {
        super(options);
        this.editor = options.editor || null;
    }

    async _prepareContext(options) {
        const context = await super._prepareContext(options);
        const characters = VNSceneStore.characters.map(character => {
            const copy = duplicateData(character);
            copy.portraits = Array.isArray(copy.portraits) ? copy.portraits : [];
            copy.positionOptions = this._positionOptions(copy.defaultPosition);
            return copy;
        });
        return Object.assign(context, {
            characters,
            hasCharacters: characters.length > 0
        });
    }

    _positionOptions(selected) {
        const pairs = [["left", "Слева"], ["center", "По центру"], ["right", "Справа"]];
        return pairs.map(pair => ({ value: pair[0], label: pair[1], selected: pair[0] === selected }));
    }

    _readCharacters() {
        if (!this.element) return VNSceneStore.characters;
        const rows = [...this.element.querySelectorAll("[data-character-row]")];
        const characters = [];
        for (const row of rows) {
            const id = row.dataset.characterId;
            const nameInput = row.querySelector("[data-character-name]");
            const positionInput = row.querySelector("[data-character-position]");
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
            characters.push(sanitizeCharacter({
                id,
                name: nameInput ? nameInput.value : "Без имени",
                defaultPosition: positionInput ? positionInput.value : "center",
                portraits
            }));
        }
        return characters;
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

    static async _onSave(event, target) {
        event.preventDefault();
        await this._commitCharacters();
        notify("VN: пресеты персонажей сохранены.");
        this._refreshEditor();
    }

    static async _onAddCharacter(event, target) {
        event.preventDefault();
        const characters = this._readCharacters();
        characters.push(createCharacterPreset("Новый персонаж", "Основной", "", "center"));
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
        await VNSceneStore.replaceCharacters(characters.filter(item => item.id !== character.id));
        this._refreshEditor();
        this.render();
    }

    static async _onAddPortrait(event, target) {
        event.preventDefault();
        const characters = this._readCharacters();
        const character = characters.find(item => item.id === target.dataset.characterId);
        if (!character) return;
        character.portraits.push(createCharacterPortrait("Новый портрет", ""));
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
                input.value = path;
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
