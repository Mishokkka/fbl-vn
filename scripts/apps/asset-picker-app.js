import { VNSceneStore } from "../data/scene-store.js";
import { MODULE_ID } from "../utils/constants.js";
import { getFilePickerClass, notify } from "../utils/foundry-helpers.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class VNAssetPickerApp extends HandlebarsApplicationMixin(ApplicationV2) {
    constructor(options = {}) {
        super(options);
        this.pickerType = options.type || "image";
        this.currentPath = options.current || "";
        this.fieldLabel = options.label || "Ассет";
        this.onSelect = typeof options.onSelect === "function" ? options.onSelect : null;
    }

    async _prepareContext(options) {
        const context = await super._prepareContext(options);
        const allAssets = VNSceneStore.assets.filter(asset => asset.type === this.pickerType);
        const assets = allAssets.slice().sort((a, b) => Number(b.lastUsed || 0) - Number(a.lastUsed || 0));
        const favorites = assets.filter(asset => asset.favorite);
        const recent = assets.slice(0, 16);
        return Object.assign(context, {
            pickerType: this.pickerType,
            currentPath: this.currentPath,
            fieldLabel: this.fieldLabel,
            favorites,
            recent,
            hasFavorites: favorites.length > 0,
            hasRecent: recent.length > 0,
            isImage: this.pickerType === "image",
            isAudio: this.pickerType === "audio"
        });
    }

    _onRender(context, options) {
        super._onRender(context, options);
        const input = this.element ? this.element.querySelector("[data-current-path]") : null;
        if (input && input.dataset.vnPathBound !== "true") {
            input.dataset.vnPathBound = "true";
            input.addEventListener("change", event => { this.currentPath = event.currentTarget.value || ""; });
        }
    }

    _readCurrentPath() {
        const input = this.element ? this.element.querySelector("[data-current-path]") : null;
        if (input) this.currentPath = input.value || "";
        return this.currentPath;
    }

    async _selectPath(path, label) {
        if (!path) return;
        await VNSceneStore.rememberAsset(this.pickerType, path, label || "");
        if (this.onSelect) await this.onSelect(path);
        this.close();
    }

    static async _onUseCurrent(event, target) {
        event.preventDefault();
        const path = this._readCurrentPath();
        await this._selectPath(path, target.dataset.label || "");
    }

    static async _onSelectAsset(event, target) {
        event.preventDefault();
        const path = target.dataset.path || "";
        const label = target.dataset.label || "";
        await this._selectPath(path, label);
    }

    static async _onBrowse(event, target) {
        event.preventDefault();
        const Picker = getFilePickerClass();
        if (!Picker) return;
        new Picker({
            type: this.pickerType,
            current: this._readCurrentPath(),
            callback: async (path) => {
                this.currentPath = path || "";
                this.render();
            }
        }).render(true);
    }

    static async _onAddFavorite(event, target) {
        event.preventDefault();
        const path = this._readCurrentPath();
        if (!path) return;
        const asset = await VNSceneStore.rememberAsset(this.pickerType, path, path.split("/").pop());
        if (asset && !asset.favorite) await VNSceneStore.toggleAssetFavorite(asset.id);
        notify("VN: ассет добавлен в избранное.");
        this.render();
    }

    static async _onToggleFavorite(event, target) {
        event.preventDefault();
        const assetId = target.dataset.assetId;
        if (!assetId) return;
        await VNSceneStore.toggleAssetFavorite(assetId);
        this.render();
    }

    static async _onDeleteAsset(event, target) {
        event.preventDefault();
        const assetId = target.dataset.assetId;
        if (!assetId) return;
        await VNSceneStore.deleteAsset(assetId);
        this.render();
    }
}

VNAssetPickerApp.DEFAULT_OPTIONS = {
    id: "fbl-vn-asset-picker",
    classes: ["fbl-vn-asset-picker-app"],
    tag: "section",
    window: {
        title: "VN Asset Picker",
        icon: "fa-solid fa-folder-open",
        resizable: true
    },
    position: {
        width: 720,
        height: 520
    },
    actions: {
        browse: VNAssetPickerApp._onBrowse,
        useCurrent: VNAssetPickerApp._onUseCurrent,
        addFavorite: VNAssetPickerApp._onAddFavorite,
        selectAsset: VNAssetPickerApp._onSelectAsset,
        toggleFavorite: VNAssetPickerApp._onToggleFavorite,
        deleteAsset: VNAssetPickerApp._onDeleteAsset
    }
};

VNAssetPickerApp.PARTS = {
    main: {
        template: `modules/${MODULE_ID}/templates/asset-picker.hbs`,
        scrollable: [".fbl-vn-asset-list"]
    }
};
