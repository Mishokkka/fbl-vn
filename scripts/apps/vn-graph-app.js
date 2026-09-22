import { VNSceneStore } from "../data/scene-store.js";
import { frameDisplayName, sanitizeFrameNextRouting, validateScene } from "../data/schema.js";
import { FRAME_TYPES, MODULE_ID } from "../utils/constants.js";

const ApplicationV2 = foundry.applications.api.ApplicationV2;
const HandlebarsApplicationMixin = foundry.applications.api.HandlebarsApplicationMixin;

const NODE_W = 250;
const NODE_H = 104;
const COL_W = 330;
const ROW_H = 142;
const BRANCH_GAP = 72;
const RETURN_EDGE_GAP = 42;
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
        this._compactPositions = new Map();
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

        const autoPositions = this._calculateAutoPositions(scene, visibleFrames, outgoing);
        const graphPositions = scene && scene.graphPositions && typeof scene.graphPositions === "object" ? scene.graphPositions : {};
        const nodes = [];
        const nodeInfo = new Map();
        for (const frame of visibleFrames) {
            const record = frameMap.get(frame.id);
            if (!record) continue;
            const textLine = this._compactLine(frameDisplayName(frame), "Без текста");
            const speakerLine = this._compactLine(frame.speaker || "Без говорящего", "Без говорящего");
            const backgroundLine = this._compactLine(frame.background || "Фон не задан", "Фон не задан");
            // Full and compact graphs have different topology. Reusing full-graph coordinates
            // in compact mode leaves the surviving anchors tens of thousands of pixels apart.
            // Keep compact drag positions session-local so toggling modes never damages the
            // user's persistent full-graph layout.
            const stored = compact ? (this._compactPositions.get(frame.id) || null) : (graphPositions[frame.id] || null);
            const fallback = autoPositions.get(frame.id) || { x: PAD_X, y: PAD_Y };
            const x = stored && Number.isFinite(Number(stored.x)) ? Number(stored.x) : fallback.x;
            const y = stored && Number.isFinite(Number(stored.y)) ? Number(stored.y) : fallback.y;
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

        const occupiedYByLevel = new Map();
        for (const node of nodes) {
            const level = this._levelFromX(node.x);
            if (!occupiedYByLevel.has(level)) occupiedYByLevel.set(level, []);
            occupiedYByLevel.get(level).push(node.y);
        }
        const virtualByKey = new Map();
        const getVirtualNode = (kind, sourceNode, link, linkIndex) => {
            const key = `${kind}:${sourceNode.id}:${linkIndex}:${link.targetId || ""}`;
            if (virtualByKey.has(key)) return virtualByKey.get(key);
            const level = this._levelFromX(sourceNode.x) + 1;
            const occupied = occupiedYByLevel.get(level) || [];
            let y = Math.max(PAD_Y, sourceNode.y + linkIndex * ROW_H);
            while (occupied.some(existingY => Math.abs(existingY - y) < NODE_H + 24)) y += ROW_H;
            occupied.push(y);
            occupiedYByLevel.set(level, occupied);
            const x = PAD_X + level * COL_W;
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
        // Return lanes fan out by 16px per zero-based source index. Size the gutter from
        // actual return edges so large forward-only choice lists do not inflate the canvas.
        let maxReturnIndex = 0;
        for (const edge of edges) {
            if (edge.isReturn) maxReturnIndex = Math.max(maxReturnIndex, edge.sourceIndex || 0);
        }
        maxX += RETURN_EDGE_GAP + maxReturnIndex * 16 + 150;
        return { nodes, edges, canvasWidth: maxX, canvasHeight: maxY, frameCount: frames.length, visibleFrameCount: visibleFrames.length, issueCount: issues.length };
    }

    _compactVisibleFrameIds(scene, frames, outgoing) {
        const visible = new Set();
        const frameMap = new Map(frames.map(frame => [frame.id, frame]));
        const startId = scene && scene.startFrame ? scene.startFrame : (frames[0] ? frames[0].id : "");

        for (const frame of frames) {
            const links = outgoing.get(frame.id) || [];
            const isTerminal = links.some(link => !link.targetId || link.kind === "terminal");
            const isBranchPoint = links.length !== 1 || links.some(link => link.kind === "condition");
            if (frame.id === startId || frame.type === FRAME_TYPES.CHOICE || frame.isFinal === true || isTerminal || isBranchPoint) {
                visible.add(frame.id);
            }

        }

        if (!visible.size && frames[0]) visible.add(frames[0].id);

        // All real branch points are already visible above. If resolution still stops on an
        // existing hidden frame, it means a purely linear hidden cycle has no visible anchor.
        // Promote only that cycle stop. Crossing editor branches alone is not a reason to keep
        // linear dialogue frames visible in compact mode.
        let changed = true;
        while (changed) {
            changed = false;
            for (const sourceId of [...visible]) {
                for (const link of outgoing.get(sourceId) || []) {
                    const resolved = this._resolveVisibleTarget(link.targetId, visible, outgoing, frameMap);
                    if (!resolved.targetId || !frameMap.has(resolved.targetId) || visible.has(resolved.targetId)) continue;
                    visible.add(resolved.targetId);
                    changed = true;
                }
            }
        }

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

        const ids = frames.map(frame => frame.id);
        const idSet = new Set(ids);
        const order = new Map(ids.map((id, index) => [id, index]));
        const adjacency = new Map();
        const reverse = new Map(ids.map(id => [id, []]));
        for (const id of ids) {
            const next = [];
            const seen = new Set();
            for (const link of outgoing.get(id) || []) {
                const targetId = link.targetId || "";
                if (!targetId || !idSet.has(targetId) || seen.has(targetId)) continue;
                seen.add(targetId);
                next.push(targetId);
                reverse.get(targetId).push(id);
            }
            adjacency.set(id, next);
        }

        // Kosaraju with explicit stacks keeps large cyclic scenes safe from recursion limits.
        const visited = new Set();
        const finish = [];
        for (const root of ids) {
            if (visited.has(root)) continue;
            visited.add(root);
            const stack = [{ id: root, index: 0 }];
            while (stack.length) {
                const top = stack[stack.length - 1];
                const next = adjacency.get(top.id) || [];
                if (top.index < next.length) {
                    const targetId = next[top.index++];
                    if (visited.has(targetId)) continue;
                    visited.add(targetId);
                    stack.push({ id: targetId, index: 0 });
                    continue;
                }
                finish.push(top.id);
                stack.pop();
            }
        }

        const componentById = new Map();
        const components = [];
        visited.clear();
        for (let i = finish.length - 1; i >= 0; i -= 1) {
            const root = finish[i];
            if (visited.has(root)) continue;
            const members = [];
            const stack = [root];
            visited.add(root);
            while (stack.length) {
                const id = stack.pop();
                members.push(id);
                for (const previous of reverse.get(id) || []) {
                    if (visited.has(previous)) continue;
                    visited.add(previous);
                    stack.push(previous);
                }
            }
            members.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
            const componentId = components.length;
            for (const id of members) componentById.set(id, componentId);
            components.push({ id: componentId, members });
        }

        const componentEdges = new Map(components.map(component => [component.id, new Set()]));
        const indegree = new Map(components.map(component => [component.id, 0]));
        for (const [sourceId, targets] of adjacency) {
            const sourceComponent = componentById.get(sourceId);
            for (const targetId of targets) {
                const targetComponent = componentById.get(targetId);
                if (sourceComponent === targetComponent || componentEdges.get(sourceComponent).has(targetComponent)) continue;
                componentEdges.get(sourceComponent).add(targetComponent);
                indegree.set(targetComponent, (indegree.get(targetComponent) || 0) + 1);
            }
        }

        const componentOrder = component => Math.min(...component.members.map(id => order.get(id) ?? Number.MAX_SAFE_INTEGER));
        const ready = components.filter(component => (indegree.get(component.id) || 0) === 0);
        ready.sort((a, b) => componentOrder(a) - componentOrder(b));
        const topo = [];
        while (ready.length) {
            const component = ready.shift();
            topo.push(component);
            for (const targetId of componentEdges.get(component.id) || []) {
                indegree.set(targetId, (indegree.get(targetId) || 0) - 1);
                if ((indegree.get(targetId) || 0) !== 0) continue;
                ready.push(components[targetId]);
                ready.sort((a, b) => componentOrder(a) - componentOrder(b));
            }
        }
        if (topo.length !== components.length) {
            for (const component of components) {
                if (!topo.includes(component)) topo.push(component);
            }
        }

        const baseRank = new Map(components.map(component => [component.id, 0]));
        for (const component of topo) {
            const base = baseRank.get(component.id) || 0;
            const span = Math.max(1, component.members.length);
            const endRank = base + span - 1;
            for (const targetId of componentEdges.get(component.id) || []) {
                baseRank.set(targetId, Math.max(baseRank.get(targetId) || 0, endRank + 1));
            }
        }

        for (const component of components) {
            const base = baseRank.get(component.id) || 0;
            for (let index = 0; index < component.members.length; index += 1) {
                levels.set(component.members[index], base + index);
            }
        }
        return levels;
    }

    _calculateAutoPositions(scene, frames, outgoing) {
        const positions = new Map();
        if (!frames.length) return positions;
        const levels = this._calculateLevels(scene, frames, outgoing);
        const order = new Map(frames.map((frame, index) => [frame.id, index]));

        const branchIds = [];
        const seenBranches = new Set();
        const usedBranches = new Set(frames.map(frame => frame.branchId || ""));
        for (const branch of Array.isArray(scene?.branches) ? scene.branches : []) {
            const branchId = branch.id || "";
            if (!usedBranches.has(branchId) || seenBranches.has(branchId)) continue;
            seenBranches.add(branchId);
            branchIds.push(branchId);
        }
        for (const frame of frames) {
            const branchId = frame.branchId || "";
            if (seenBranches.has(branchId)) continue;
            seenBranches.add(branchId);
            branchIds.push(branchId);
        }
        if (!branchIds.length) branchIds.push("");

        const groupsByBranch = new Map();
        const maxRowsByBranch = new Map(branchIds.map(branchId => [branchId, 1]));
        for (const frame of frames) {
            const branchId = frame.branchId || "";
            const level = levels.get(frame.id) ?? 0;
            if (!groupsByBranch.has(branchId)) groupsByBranch.set(branchId, new Map());
            const byLevel = groupsByBranch.get(branchId);
            if (!byLevel.has(level)) byLevel.set(level, []);
            byLevel.get(level).push(frame.id);
        }
        for (const [branchId, byLevel] of groupsByBranch) {
            for (const idsAtLevel of byLevel.values()) {
                idsAtLevel.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
                maxRowsByBranch.set(branchId, Math.max(maxRowsByBranch.get(branchId) || 1, idsAtLevel.length));
            }
        }

        const branchBaseY = new Map();
        let y = PAD_Y;
        for (const branchId of branchIds) {
            branchBaseY.set(branchId, y);
            y += (maxRowsByBranch.get(branchId) || 1) * ROW_H + BRANCH_GAP;
        }

        for (const frame of frames) {
            const branchId = frame.branchId || "";
            const level = levels.get(frame.id) ?? 0;
            const idsAtLevel = groupsByBranch.get(branchId)?.get(level) || [];
            const row = Math.max(0, idsAtLevel.indexOf(frame.id));
            positions.set(frame.id, {
                x: PAD_X + level * COL_W,
                y: (branchBaseY.get(branchId) ?? PAD_Y) + row * ROW_H
            });
        }
        return positions;
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
            isReturn: view.isReturn === true,
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

    _attachPartListeners(partId, htmlElement, options) {
        super._attachPartListeners(partId, htmlElement, options);
        if (partId !== "main") return;
        this._bindCompactToggle(htmlElement);
    }

    _bindCompactToggle(root) {
        const toggle = root?.querySelector?.("[data-compact-toggle]");
        if (!toggle || toggle.dataset.vnGraphToggleBound === "true") return;
        toggle.dataset.vnGraphToggleBound = "true";
        toggle.addEventListener("change", event => {
            void this._setCompactMode(event.currentTarget?.checked === true);
        });
    }

    async _setCompactMode(enabled) {
        const next = enabled === true;
        if (this.hideLinearFrames === next) return;
        this.hideLinearFrames = next;
        this._panX = 0;
        this._panY = 0;
        this._zoom = 1;
        await this.render(true);
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
            edge.path.classList.toggle("is-return", view.isReturn === true);
            if (edge.label) {
                edge.label.style.left = `${view.lx}px`;
                edge.label.style.top = `${view.ly}px`;
                edge.label.classList.toggle("is-return", view.isReturn === true);
            }
        }
    }

    _pathFromPoints(source, target, index) {
        const sourceY = source.y + Math.min(source.h - 18, 34 + index * 18);
        const targetY = target.y + target.h / 2;
        const sourceRight = source.x + source.w;
        const targetLeft = target.x;
        const targetRight = target.x + target.w;
        const isReturn = targetLeft <= sourceRight + 18;

        if (!isReturn) {
            const gap = Math.max(1, targetLeft - sourceRight);
            const offsetLimit = Math.max(0, Math.min(24, gap / 2 - 10));
            const laneOffset = Math.max(-offsetLimit, Math.min(offsetLimit, (index - 0.5) * 8));
            const midX = Math.round(sourceRight + gap / 2 + laneOffset);
            const path = `M ${sourceRight} ${sourceY} H ${midX} V ${targetY} H ${targetLeft}`;
            return {
                path,
                lx: Math.round(midX - 60),
                ly: Math.round((sourceY + targetY) / 2 - 11),
                isReturn: false
            };
        }

        // Back-edges and same-column edges use a dedicated lane to the right of both nodes.
        // This keeps branch returns out of the node bodies instead of producing giant cubic loops.
        const routeX = Math.round(Math.max(sourceRight, targetRight) + RETURN_EDGE_GAP + index * 16);
        const path = `M ${sourceRight} ${sourceY} H ${routeX} V ${targetY} H ${targetRight}`;
        return {
            path,
            lx: Math.round(routeX - 132),
            ly: Math.round((sourceY + targetY) / 2 - 11),
            isReturn: true
        };
    }

    async _saveNodePosition(id, x, y) {
        if (!id || !this.sceneId) return;
        if (this.hideLinearFrames === true) {
            this._compactPositions.set(id, { x, y });
            return;
        }
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

    async _saveAutoLayout() {
        if (!this.sceneId) return;
        if (this.hideLinearFrames === true) {
            this._compactPositions.clear();
            this._panX = 0;
            this._panY = 0;
            this._zoom = 1;
            return;
        }
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
        this._panX = 0;
        this._panY = 0;
        this._zoom = 1;
    }

    static async _onAutoLayout(event, target) {
        event.preventDefault();
        await this._saveAutoLayout();
        await this.render({ parts: ["main"] });
    }

    static async _onResetLayout(event, target) {
        event.preventDefault();
        if (this.hideLinearFrames === true) {
            this._compactPositions.clear();
        }
        else {
            const scene = VNSceneStore.getScene(this.sceneId);
            if (!scene) return;
            scene.graphPositions = {};
            await VNSceneStore.upsertScene(scene);
        }
        this._panX = 0;
        this._panY = 0;
        this._zoom = 1;
        await this.render({ parts: ["main"] });
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
