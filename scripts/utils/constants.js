export const MODULE_ID = "fbl-vn-cutscenes";
export const MODULE_TITLE = "FBL Visual Novel Cutscenes";
export const SETTINGS = {
    DATA: "data",
    STORAGE_JOURNAL_ID: "storageJournalId",
    PRELOAD_WAIT_MS: "preloadWaitMs",
    MUSIC_VOLUME: "musicVolume",
    VOICE_VOLUME: "voiceVolume",
    SFX_VOLUME: "sfxVolume",
    DISABLE_TRANSITIONS: "disableTransitions",
    INSTANT_TEXT: "instantText"
};
export const SOCKET_NAME = `module.${MODULE_ID}`;
export const FRAME_TYPES = {
    DIALOGUE: "dialogue",
    NARRATION: "narration",
    CHOICE: "choice"
};
export const TEXT_PRESENTATIONS = {
    BOX: "box",
    CENTER: "center"
};
export const VIGNETTE_MODES = {
    AUTO: "auto",
    SCREEN: "screen",
    TEXT: "text",
    NONE: "none"
};
export const COUNTER_OPERATORS = {
    NONE: "",
    GT: "gt",
    GTE: "gte",
    EQ: "eq",
    LTE: "lte",
    LT: "lt",
    NE: "ne"
};
export const COUNTER_EFFECTS = {
    NONE: "",
    ADD: "add",
    SUBTRACT: "subtract"
};
// Retained for migration of scenes created before schema v8.
export const MUSIC_MODES = {
    KEEP: "keep",
    PLAY: "play",
    STOP: "stop"
};
export const AUDIO_ACTIONS = {
    PLAY: "play",
    STOP: "stop",
    STOP_ALL: "stop-all"
};
export const PLAYER_MODES = {
    INDIVIDUAL: "individual",
    GM: "gm",
    VOTE: "vote"
};
export const DATA_SCHEMA_VERSION = 9;
export const DEFAULT_DATA = {
    schemaVersion: DATA_SCHEMA_VERSION,
    version: 3,
    scenes: [],
    assets: [],
    characters: []
};
