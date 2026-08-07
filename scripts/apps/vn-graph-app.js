import { VNSceneStore } from "../data/scene-store.js";
import { frameDisplayName, sanitizeFrameNextRouting, validateScene } from "../data/schema.js";
import { FRAME_TYPES, MODULE_ID } from "../utils/constants.js";

const ApplicationV2 = foundry.applications.api.ApplicationV2;
const HandlebarsApplicationMixin = foundry.applications.api.HandlebarsApplicationMixin;

const NODE_W = 250;
const NODE_H = 104;
const COL_W = 330;
const ROW_H = 142;
const PAD_X = 28;
const PAD_Y = 28;

export class VNGraphApp extends HandlebarsApplicationMixin(ApplicationV2) {
    constructor(options = {}) {
        super(options);
        this.sceneId = options.sceneId || null;
        this._panX = 0;
        this._panY = 0;
        this._zoom = 1;
        this._dragNode = null;
        this._panState = null;
        this.hideLinearFrames = options.hideLinearFrames === true;
        this._windowListenersBound = false;
        this._graphDomCache = null;
        this._graphRedrawRaf = null;
        this._pendingNodePosition = null;
        this._onWindowMouseMove = event => this._onGraphMouseMove(event);
        this._onWindowMouseUp = event => this._onGraphMouseUp(event);
    }

    async _prepareContext(options) {
        const context = await super._prepareContext(options);
        const scene = VNSceneStore.getScene(this.sceneId) || VNSceneStore.scenes[0] || null;
        if (scene && scene.id !== this.sceneId) this.sceneId = scene.id;
        const graph = this._buildGraph(scene);
        return Object.assign(context, {
            scene,
            nodes: graph.nodes,
            edges: graph.edges,
            canvasWidth: graph.canvasWidth,
            canvasHeight: graph.canvasHeight,
            nodeCount: graph.visibleFrameCount,
            totalFrameCount: graph.frameCount,
            compactGraph: this.hideLinearFrames === true,
            hasScene: Boolean(scene),
            hasNodes: graph.nodes.length > 0,
            issueCount: graph.issueCount
        });
    }

    _buildGraph(scene) {
        const frames = scene && Array.isArray(scene.frames) ? scene.frames : [];
        const frameMap = new Map();
        const nextSequentialById = new Map();
        const previousByBranch = new Map();
        for (let index = 0; index < frames.length; index += 1) {
            const frame = frames[index];
            frameMap.set(frame.id, { frame, index });
            const branchId = frame.branchId || "";
            const previous = previousByBranch.get(branchId);
            if (previous) nextSequentialById.set(previous.id, frame.id);
            previousByBranch.set(branchId, frame);
        }

        const issues = validateScene(scene);
        const issueFrameIds = new Set(issues.map(issue => issue.frameId).filter(Boolean));
        const rawOutgoing = new Map();
        const rawIncoming = new Map();
        for (const frame of frames) {
            rawIncoming.set(frame.id, 0);
            rawOutgoing.set(frame.id, this._outgoingForFrame(frame, nextSequentialById));
        }
        for (const links of rawOutgoing.values()) {
            for (const link of links) {
                if (link.targetId && rawIncoming.has(link.targetId)) rawIncoming.set(link.targetId, rawIncoming.get(link.targetId) + 1);
            }
        }

        const compact = this.hideLinearFrames === true;
        const visibleIds = compact ? this._compactVisibleFrameIds(scene, frames, rawOutgoing) : new Set(frames.map(frame => frame.id));
        const visibleFrames = frames.filter(frame => visibleIds.has(frame.id));
        const outgoing = new Map();
        const incoming = new Map();
        for (const frame of visibleFrames) {
            incoming.set(frame.id, 0);
            outgoing.set(frame.id, this._displayOutgoingForFrame(scene, frame, rawOutgoing, visibleIds, frameMap, compact));
        }
        for (const links of outgoing.values()) {
            for (const link of links) {
                if (link.targetId && incoming.has(link.targetId)) incoming.set(link.targetId, incoming.get(link.targetId) + 1);
            }
        }

        const levels = this._calculateLevels(scene, visibleFrames, outgoing);
        const buckets = new Map();
        for (const frame of visibleFrames) {
            const level = levels.has(frame.id) ? levels.get(frame.id) : 0;
            if (!buckets.has(level)) buckets.set(level, []);
            buckets.get(level).push(frame.id);
        }

        const graphPositions = scene && scene.graphPositions && typeof scene.graphPositions === "object" ? scene.graphPositions : {};
        const nodes = [];
        const nodeInfo = new Map();
        const sortedLevels = [...buckets.keys()].sort((a, b) => a - b);
        for (const level of sortedLevels) {
            const ids = buckets.get(level);
            for (let row = 0; row < ids.length; row += 1) {
                const id = ids[row];
                const record = frameMap.get(id);
                if (!record) continue;
                const frame = record.frame;
                const textLine = this._compactLine(frameDisplayName(frame), "Без текста");
                const speakerLine = this._compactLine(frame.speaker || "Без говорящего", "Без говорящего");
                const backgroundLine = this._compactLine(frame.background || "Фон не задан", "Фон не задан");
                const stored = graphPositions[frame.id] || null;
                const x = stored && Number.isFinite(Number(stored.x)) ? Number(stored.x) : PAD_X + level * COL_W;
                const y = stored && Number.isFinite(Number(stored.y)) ? Number(stored.y) : PAD_Y + row * ROW_H;
                const node = {
                    id: frame.id,
                    domId: this._domId(frame.id),
                    index: record.index + 1,
                    title: textLine,
                    textLine,
                    speakerLine,
                    backgroundLine,
                    type: frame.type,
                    isStart: scene && scene.startFrame === frame.id,
                    isUnreachable: scene && frame.id !== scene.startFrame && (incoming.has(frame.id) ? incoming.get(frame.id) : 0) === 0 && (rawIncoming.has(frame.id) ? rawIncoming.get(frame.id) : 0) === 0,
                    hasIssue: issueFrameIds.has(frame.id),
                    style: `left:${x}px;top:${y}px;width:${NODE_W}px;height:${NODE_H}px;`,
                    x,
                    y,
                    w: NODE_W,
                    h: NODE_H,
                    isVirtual: false,
                    isTerminal: false,
                    isBroken: false
                };
                nodes.push(node);
                nodeInfo.set(frame.id, node);
            }
        }

        const nodeCountByLevel = new Map();
        for (const node of nodes) {
            const level = this._levelFromX(node.x);
            nodeCountByLevel.set(level, (nodeCountByLevel.get(level) || 0) + 1);
        }
        const virtualByKey = new Map();
        const getVirtualNode = (kind, sourceNode, link, linkIndex) => {
            const key = `${kind}:${sourceNode.id}:${linkIndex}:${link.targetId || ""}`;
            if (virtualByKey.has(key)) return virtualByKey.get(key);
            const level = this._levelFromX(sourceNode.x) + 1;
            const existingAtLevel = nodeCountByLevel.get(level) || 0;
            nodeCountByLevel.set(level, existingAtLevel + 1);
            const x = PAD_X + level * COL_W;
            const y = PAD_Y + existingAtLevel * ROW_H;
            const id = `${kind}-${sourceNode.id}-${linkIndex}`;
            const node = {
                id,
                domId: this._domId(id),
                index: "",
                title: kind === "terminal" ? "Конец катсцены" : `Битая ссылка: ${link.targetId}`,
                textLine: kind === "terminal" ? "Конец катсцены" : "Битая ссылка",
                speakerLine: kind === "terminal" ? "Финал" : (link.targetId || "цель не задана"),
                backgroundLine: "",
                type: kind,
                isStart: false,
                isUnreachable: false,
                hasIssue: kind === "broken",
                style: `left:${x}px;top:${y}px;width:${NODE_W}px;height:${NODE_H}px;`,
                x,
                y,
                w: NODE_W,
                h: NODE_H,
                isVirtual: true,
                isTerminal: kind === "terminal",
                isBroken: kind === "broken"
            };
            nodes.push(node);
            virtualByKey.set(key, node);
            return node;
        };

        const edges = [];
        for (const frame of visibleFrames) {
            const source = nodeInfo.get(frame.id);
            if (!source) continue;
            const links = outgoing.get(frame.id) || [];
            for (let index = 0; index < links.length; index += 1) {
                const link = links[index];
                let target = null;
                if (link.targetId && nodeInfo.has(link.targetId)) target = nodeInfo.get(link.targetId);
                else target = getVirtualNode(link.targetId ? "broken" : "terminal", source, link, index);
                edges.push(this._edgeView(source, target, link, index));
            }
        }

        let maxX = NODE_W + PAD_X * 2;
        let maxY = NODE_H + PAD_Y * 2;
        for (const node of nodes) {
            maxX = Math.max(maxX, node.x + node.w + PAD_X);
            maxY = Math.max(maxY, node.y + node.h + PAD_Y);
        }
        return { nodes, edges, canvasWidth: maxX, canvasHeight: maxY, frameCount: frames.length, visibleFrameCount: visibleFrames.length, issueCount: issues.length };
    }

    _compactVisibleFrameIds(scene, frames, outgoing) {
        const visible = new Set();
        const startId = scene && scene.startFrame ? scene.startFrame : (frames[0] ? frames[0].id : "");
        for (const frame of frames) {
            const links = outgoing.get(frame.id) || [];
            const isTerminal = links.some(link => !link.targetId || link.kind === "terminal");
            if (frame.id === startId || frame.type === FRAME_TYPES.CHOICE || frame.isFinal === true || isTerminal) visible.add(frame.id);
        }
        if (!visible.size && frames[0]) visible.add(frames[0].id);
        return visible;
    }

    _displayOutgoingForFrame(scene, frame, rawOutgoing, visibleIds, frameMap, compact) {
        const links = rawOutgoing.get(frame.id) || [];
        if (!compact) return links;
        return links.map(link => {
            const resolved = this._resolveVisibleTarget(link.targetId, visibleIds, rawOutgoing, frameMap);
            return Object.assign({}, link, { targetId: resolved.targetId });
        });
    }

    _resolveVisibleTarget(targetId, visibleIds, rawOutgoing, frameMap) {
        if (!targetId) return { targetId: "" };
        if (!frameMap.has(targetId)) return { targetId };
        let currentId = targetId;
        const seen = new Set();
        while (currentId) {
            if (visibleIds.has(currentId)) return { targetId: currentId };
            if (seen.has(currentId)) return { targetId: currentId };
            seen.add(currentId);
            const record = frameMap.get(currentId);
            if (!record) return { targetId: currentId };
            const links = rawOutgoing.get(currentId) || [];
            if (record.frame.type === FRAME_TYPES.CHOICE || links.length !== 1) return { targetId: currentId };
            const nextId = links[0] ? links[0].targetId || "" : "";
            if (!nextId) return { targetId: "" };
            currentId = nextId;
        }
        return { targetId: "" };
    }

    _outgoingForFrame(frame, nextSequentialById) {
        const links = [];
        if (frame.isFinal === true) {
            links.push({ label: "Финал", targetId: "", kind: "terminal" });
            return links;
        }
        const sequentialId = nextSequentialById.get(frame.id) || "";
        const routing = sanitizeFrameNextRouting(frame.nextRouting);
        if (frame.type === FRAME_TYPES.CHOICE) {
            const choices = Array.isArray(frame.choices) ? frame.choices : [];
            for (let index = 0; index < choices.length; index += 1) {
                const choice = choices[index];
                if (choice.next) links.push({ label: choice.text || `Выбор ${index + 1}`, targetId: choice.next, kind: "choice" });
            }
            if (!routing.enabled) {
                for (let index = 0; index < choices.length; index += 1) {
                    const choice = choices[index];
                    if (!choice.next) links.push({ label: choice.text || `Выбор ${index + 1}`, targetId: frame.next || sequentialId, kind: "choice" });
                }
                return links;
            }
        }
        if (routing.enabled) {
            links.push({ label: "Если да", targetId: routing.trueFrameId || sequentialId, kind: "condition" });
            links.push({ label: "Если нет", targetId: routing.falseFrameId || sequentialId, kind: "condition" });
            return links;
        }
        if (frame.type !== FRAME_TYPES.CHOICE) {
            links.push({ label: "Далее", targetId: frame.next || sequentialId, kind: "next" });
        }
        return links;
    }

    _calculateLevels(scene, frames, outgoing) {
        const levels = new Map();
        if (!frames.length) return levels;
        const startId = scene && scene.startFrame ? scene.startFrame : frames[0].id;
        levels.set(startId, 0);
        const queue = [startId];
        let cursor = 0;
        while (cursor < queue.length) {
            const id = queue[cursor++];
            const level = levels.get(id) ?? 0;
            const links = outgoing.get(id) || [];
            for (const link of links) {
                if (!link.targetId || levels.has(link.targetId) || !outgoing.has(link.targetId)) continue;
                levels.set(link.targetId, Math.max(0, level + 1));
                queue.push(link.targetId);
            }
        }
        let fallbackLevel = 0;
        for (const frame of frames) {
            if (!levels.has(frame.id)) {
                levels.set(frame.id, fallbackLevel);
                fallbackLevel += 1;
            }
        }
        return levels;
    }

    _edgeView(source, target, link, index) {
        const view = this._pathFromPoints(source, target, index);
        const edgeId = `edge-${source.id}-${target.id}-${index}`.replace(/[^a-zA-Z0-9_-]/g, "-");
        return {
            edgeId,
            sourceId: source.id,
            targetId: target.id,
            label: link.label || "Далее",
            path: view.path,
            sourceDomId: source.domId,
            targetDomId: target.domId,
            sourceIndex: index,
            labelStyle: `left:${view.lx}px;top:${view.ly}px;`,
            isChoice: link.kind === "choice",
            isConditional: link.kind === "condition",
            isBroken: target.isBroken,
            isTerminal: target.isTerminal
        };
    }

    async _onRender(context, options) {
        await super._onRender(context, options);
        this._applyGraphTransform();
        this._bindGraphInteraction();
        this._cacheGraphDom();
        this._redrawEdgesLive();
    }

    _bindGraphInteraction() {
        if (!this.element) return;
        this._bindWindowGraphInteraction();
        const body = this.element.querySelector(".fbl-vn-graph-body");
        const canvas = this.element.querySelector(".fbl-vn-graph-canvas");
        if (!body || !canvas) return;
        if (body.dataset.vnGraphBound !== "true") {
            body.dataset.vnGraphBound = "true";
            body.addEventListener("wheel", event => this._onGraphWheel(event), { passive: false });
            body.addEventListener("mousedown", event => this._onGraphMouseDown(event));
        }
        for (const node of canvas.querySelectorAll(".fbl-vn-graph-node[data-node-id]")) {
            if (node.dataset.vnGraphNodeBound === "true") continue;
            node.dataset.vnGraphNodeBound = "true";
            node.addEventListener("mousedown", event => this._onNodeMouseDown(event, node));
        }
    }

    _bindWindowGraphInteraction() {
        if (this._windowListenersBound) return;
        window.addEventListener("mousemove", this._onWindowMouseMove);
        window.addEventListener("mouseup", this._onWindowMouseUp);
        this._windowListenersBound = true;
    }

    async close(options = {}) {
        if (this._windowListenersBound) {
            window.removeEventListener("mousemove", this._onWindowMouseMove);
            window.removeEventListener("mouseup", this._onWindowMouseUp);
            this._windowListenersBound = false;
        }
        if (this._graphRedrawRaf !== null) cancelAnimationFrame(this._graphRedrawRaf);
        this._graphRedrawRaf = null;
        this._pendingNodePosition = null;
        this._graphDomCache = null;
        this._dragNode = null;
        this._panState = null;
        return super.close(options);
    }

    _onGraphWheel(event) {
        if (!event.currentTarget) return;
        event.preventDefault();
        const body = event.currentTarget;
        const rect = body.getBoundingClientRect();
        const oldZoom = this._zoom;
        const direction = event.deltaY < 0 ? 1 : -1;
        const nextZoom = Math.max(0.35, Math.min(2.4, oldZoom + direction * 0.1));
        if (nextZoom === oldZoom) return;
        const localX = event.clientX - rect.left;
        const localY = event.clientY - rect.top;
        const worldX = (localX - this._panX) / oldZoom;
        const worldY = (localY - this._panY) / oldZoom;
        this._zoom = nextZoom;
        this._panX = localX - worldX * nextZoom;
        this._panY = localY - worldY * nextZoom;
        this._applyGraphTransform();
    }

    _onGraphMouseDown(event) {
        if (event.button !== 1) return;
        event.preventDefault();
        this._panState = { startX: event.clientX, startY: event.clientY, panX: this._panX, panY: this._panY };
    }

    _onNodeMouseDown(event, node) {
        if (event.button !== 0) return;
        if (node.dataset.virtual === "true") return;
        event.preventDefault();
        event.stopPropagation();
        const body = this.element ? this.element.querySelector(".fbl-vn-graph-body") : null;
        if (!body) return;
        const rect = body.getBoundingClientRect();
        const x = Number(node.dataset.x || 0);
        const y = Number(node.dataset.y || 0);
        const localX = event.clientX - rect.left;
        const localY = event.clientY - rect.top;
        this._dragNode = {
            id: node.dataset.nodeId,
            element: node,
            offsetX: (localX - this._panX) / this._zoom - x,
            offsetY: (localY - this._panY) / this._zoom - y
        };
        node.classList.add("is-dragging");
    }

    _onGraphMouseMove(event) {
        if (this._panState) {
            this._panX = this._panState.panX + event.clientX - this._panState.startX;
            this._panY = this._panState.panY + event.clientY - this._panState.startY;
            this._applyGraphTransform();
            return;
        }
        if (!this._dragNode || !this.element) return;
        const body = this.element.querySelector(".fbl-vn-graph-body");
        if (!body) return;
        const rect = body.getBoundingClientRect();
        const localX = event.clientX - rect.left;
        const localY = event.clientY - rect.top;
        const x = Math.round((localX - this._panX) / this._zoom - this._dragNode.offsetX);
        const y = Math.round((localY - this._panY) / this._zoom - this._dragNode.offsetY);
        this._scheduleNodePosition(this._dragNode.id, this._dragNode.element, x, y);
    }

    async _onGraphMouseUp(event) {
        if (this._panState) this._panState = null;
        if (!this._dragNode) return;
        this._flushGraphFrame();
        const node = this._dragNode.element;
        node.classList.remove("is-dragging");
        const id = this._dragNode.id;
        this._dragNode = null;
        await this._saveNodePosition(id, Number(node.dataset.x || 0), Number(node.dataset.y || 0));
    }

    _applyGraphTransform() {
        if (!this.element) return;
        const canvas = this.element.querySelector(".fbl-vn-graph-canvas");
        const zoomLabel = this.element.querySelector("[data-zoom-label]");
        if (canvas) canvas.style.transform = `translate(${this._panX}px, ${this._panY}px) scale(${this._zoom})`;
        if (zoomLabel) zoomLabel.textContent = `${Math.round(this._zoom * 100)}%`;
    }

    _setNodePosition(node, x, y) {
        if (!node) return;
        const nx = Math.max(0, x);
        const ny = Math.max(0, y);
        node.dataset.x = String(nx);
        node.dataset.y = String(ny);
        node.style.left = `${nx}px`;
        node.style.top = `${ny}px`;
    }

    _cacheGraphDom() {
        const canvas = this.element ? this.element.querySelector(".fbl-vn-graph-canvas") : null;
        if (!canvas) {
            this._graphDomCache = null;
            return;
        }
        const nodes = new Map();
        for (const element of canvas.querySelectorAll(".fbl-vn-graph-node[data-node-id]")) {
            nodes.set(element.dataset.nodeId, element);
        }
        const edges = new Map();
        const edgesByNodeId = new Map();
        const addEdgeForNode = (nodeId, edgeId) => {
            if (!edgesByNodeId.has(nodeId)) edgesByNodeId.set(nodeId, new Set());
            edgesByNodeId.get(nodeId).add(edgeId);
        };
        for (const path of canvas.querySelectorAll(".graph-edge[data-edge-id]")) {
            const edgeId = path.dataset.edgeId;
            const sourceId = path.dataset.sourceId;
            const targetId = path.dataset.targetId;
            if (!edgeId || !sourceId || !targetId) continue;
            edges.set(edgeId, {
                path,
                label: canvas.querySelector(`.graph-edge-label[data-edge-id='${edgeId}']`),
                sourceId,
                targetId,
                sourceIndex: Number(path.dataset.sourceIndex || 0)
            });
            addEdgeForNode(sourceId, edgeId);
            addEdgeForNode(targetId, edgeId);
        }
        this._graphDomCache = { canvas, nodes, edges, edgesByNodeId };
    }

    _scheduleNodePosition(id, element, x, y) {
        this._pendingNodePosition = { id, element, x, y };
        if (this._graphRedrawRaf !== null) return;
        this._graphRedrawRaf = requestAnimationFrame(() => this._flushGraphFrame());
    }

    _flushGraphFrame() {
        if (this._graphRedrawRaf !== null) cancelAnimationFrame(this._graphRedrawRaf);
        this._graphRedrawRaf = null;
        const pending = this._pendingNodePosition;
        this._pendingNodePosition = null;
        if (!pending) return;
        this._setNodePosition(pending.element, pending.x, pending.y);
        this._redrawEdgesLive(pending.id);
    }

    _nodeGeometry(nodeId) {
        const element = this._graphDomCache?.nodes?.get(nodeId);
        if (!element) return null;
        return {
            x: Number(element.dataset.x || 0),
            y: Number(element.dataset.y || 0),
            w: Number(element.dataset.w || NODE_W),
            h: Number(element.dataset.h || NODE_H)
        };
    }

    _redrawEdgesLive(nodeId = null) {
        if (!this._graphDomCache) this._cacheGraphDom();
        const cache = this._graphDomCache;
        if (!cache) return;
        const edgeIds = nodeId ? cache.edgesByNodeId.get(nodeId) || [] : cache.edges.keys();
        for (const edgeId of edgeIds) {
            const edge = cache.edges.get(edgeId);
            if (!edge) continue;
            const source = this._nodeGeometry(edge.sourceId);
            const target = this._nodeGeometry(edge.targetId);
            if (!source || !target) continue;
            const view = this._pathFromPoints(source, target, edge.sourceIndex);
            edge.path.setAttribute("d", view.path);
            if (edge.label) {
                edge.label.style.left = `${view.lx}px`;
                edge.label.style.top = `${view.ly}px`;
            }
        }
    }

    _pathFromPoints(source, target, index) {
        const sourceY = source.y + Math.min(source.h - 18, 34 + index * 18);
        const targetY = target.y + target.h / 2;
        const sourceX = source.x + source.w;
        const targetX = target.x;
        const dx = Math.max(70, Math.abs(targetX - sourceX) * 0.45);
        const path = `M ${sourceX} ${sourceY} C ${sourceX + dx} ${sourceY}, ${targetX - dx} ${targetY}, ${targetX} ${targetY}`;
        return { path, lx: Math.round((sourceX + targetX) / 2 - 60), ly: Math.round((sourceY + targetY) / 2 - 11) };
    }

    async _saveNodePosition(id, x, y) {
        if (!id || !this.sceneId) return;
        const scene = VNSceneStore.getScene(this.sceneId);
        if (!scene) return;
        scene.graphPositions = scene.graphPositions && typeof scene.graphPositions === "object" ? scene.graphPositions : {};
        scene.graphPositions[id] = { x, y };
        await VNSceneStore.upsertScene(scene);
    }

    _levelFromX(x) {
        return Math.max(0, Math.round((x - PAD_X) / COL_W));
    }

    _domId(id) {
        return `node-${String(id).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    }

    _compactLine(value, fallback) {
        const text = String(value || fallback || "").replace(/\s+/g, " ").trim();
        if (!text) return fallback || "";
        return text;
    }

    _typeLabel(type) {
        if (type === FRAME_TYPES.NARRATION) return "Наррация";
        if (type === FRAME_TYPES.CHOICE) return "Выбор";
        return "Реплика";
    }

    static async _onToggleLinearFrames(event, target) {
        event.stopPropagation();
        this.hideLinearFrames = target && target.checked === true;
        this.render();
    }

    async _saveAutoLayout() {
        if (!this.sceneId) return;
        const scene = VNSceneStore.getScene(this.sceneId);
        if (!scene) return;
        const draft = Object.assign({}, scene, { graphPositions: {} });
        const graph = this._buildGraph(draft);
        const positions = {};
        for (const node of graph.nodes) {
            if (node.isVirtual) continue;
            positions[node.id] = { x: node.x, y: node.y };
        }
        scene.graphPositions = positions;
        await VNSceneStore.upsertScene(scene);
    }

    static async _onAutoLayout(event, target) {
        event.preventDefault();
        await this._saveAutoLayout();
        this.render();
    }

    static async _onResetLayout(event, target) {
        event.preventDefault();
        const scene = VNSceneStore.getScene(this.sceneId);
        if (!scene) return;
        scene.graphPositions = {};
        await VNSceneStore.upsertScene(scene);
        this.render();
    }
}

VNGraphApp.DEFAULT_OPTIONS = {
    id: "fbl-vn-graph",
    classes: ["fbl-vn-graph-app"],
    tag: "section",
    window: {
        title: "VN Branch Graph",
        icon: "fa-solid fa-diagram-project",
        resizable: true
    },
    position: {
        width: 1200,
        height: 760
    },
    actions: {
        toggleLinearFrames: VNGraphApp._onToggleLinearFrames,
        autoLayout: VNGraphApp._onAutoLayout,
        resetLayout: VNGraphApp._onResetLayout
    }
};

VNGraphApp.PARTS = {
    main: {
        template: `modules/${MODULE_ID}/templates/graph.hbs`,
        scrollable: [".fbl-vn-graph-body"]
    }
};
