import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { loadInterfaceXML } from 'resource:///org/gnome/shell/misc/fileUtils.js';
import Clutter from 'gi://Clutter';
import Cairo from 'gi://cairo';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import { Toolbar, TRASH_BUTTON_RADIUS } from './topBar.js';
import { TOOLS, buildEffectiveToolShortcuts } from './tools.js';
import { GradiaSettings } from './settings.js';
import { captureAndStoreScreenshot } from './screenshotStore.js';
import { ResolutionOverlay } from './resolutionOverlay.js';
import { isGradiaFlatpakInstalled, createOcrButton, createSettingsButton, launchGradiaOcrForFile, setOcrButtonEnabled } from './gradiaIntegration.js';
import { destroyActiveToast } from './screenshotToast.js';
import { SelectionClearer } from './selectionClearer.js';

const MAX_CANVAS_WIDTH = 1920;
const MAX_CANVAS_HEIGHT = 1080;

const MODE_BUTTONS = [
    ['_windowButton',    '_windowButtonId'],
    ['_selectionButton', '_selectionButtonId'],
    ['_screenButton',    '_screenButtonId'],
    ['_castButton',      '_castButtonId'],
];

export function setAreaSelectorHandlesVisible(selector, visible) {
    const handles = [
        selector?._topLeftHandle,
        selector?._topRightHandle,
        selector?._bottomLeftHandle,
        selector?._bottomRightHandle,
    ].filter(h => h != null);

    for (const handle of handles) {
        if (visible)
            handle.show();
        else
            handle.hide();
    }
}

function getToolDef(id) {
    return TOOLS.find(t => t.id === id) ?? null;
}

function getStrokePadding(toolId, strokeWidth) {
    const sw = strokeWidth ?? 4;
    switch (toolId) {
        case 'arrow':
            return sw * 5 + 16;
        case 'highlighter':
            return sw * 4 + 16;
        case 'stamp':
            return sw * 5 + 24;
        case 'text':
            return sw * 3 + 24;
        default:
            return sw * 2 + 16;
    }
}

const HANDLE_RADIUS = 4.5;
const HANDLE_HIT_RADIUS = 10;
const MIN_DISTANCE_SQ = 4;
const SELECTION_BOX_PADDING = 4;

function getRectangleBounds(stroke) {
    if (!stroke?.stagePoints || stroke.stagePoints.length < 2)
        return null;
    const p0 = stroke.stagePoints[0];
    const p1 = stroke.stagePoints[1];
    const minX = Math.min(p0.x, p1.x);
    const maxX = Math.max(p0.x, p1.x);
    const minY = Math.min(p0.y, p1.y);
    const maxY = Math.max(p0.y, p1.y);
    return {
        minX,
        minY,
        maxX,
        maxY,
        width: maxX - minX,
        height: maxY - minY,
    };
}

function getPaddedSelectionBounds(stroke) {
    const raw = getRectangleBounds(stroke);
    if (!raw)
        return null;
    const pad = (stroke.toolId === 'solid-rectangle')
        ? SELECTION_BOX_PADDING
        : (SELECTION_BOX_PADDING + (stroke.strokeWidth ?? 3) / 2);
    return {
        minX: raw.minX - pad,
        minY: raw.minY - pad,
        maxX: raw.maxX + pad,
        maxY: raw.maxY + pad,
    };
}

function getRectangleHandles(bounds) {
    if (!bounds) return [];
    const { minX, minY, maxX, maxY } = bounds;
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;
    return [
        { id: 'nw', x: minX, y: minY },
        { id: 'n',  x: midX, y: minY },
        { id: 'ne', x: maxX, y: minY },
        { id: 'e',  x: maxX, y: midY },
        { id: 'se', x: maxX, y: maxY },
        { id: 's',  x: midX, y: maxY },
        { id: 'sw', x: minX, y: maxY },
        { id: 'w',  x: minX, y: midY },
    ];
}

function hitTestRectangleHandles(stroke, stageX, stageY) {
    const padded = getPaddedSelectionBounds(stroke);
    if (!padded) return null;

    // 1. Discrete 8 handles (corners and midpoints)
    const handles = getRectangleHandles(padded);
    for (const h of handles) {
        if (Math.abs(h.x - stageX) <= HANDLE_HIT_RADIUS && Math.abs(h.y - stageY) <= HANDLE_HIT_RADIUS)
            return h.id;
    }

    // 2. Edges of the padded bounding box (8px tolerance)
    const edgeThreshold = 8;
    const nearTop = Math.abs(stageY - padded.minY) <= edgeThreshold;
    const nearBottom = Math.abs(stageY - padded.maxY) <= edgeThreshold;
    const nearLeft = Math.abs(stageX - padded.minX) <= edgeThreshold;
    const nearRight = Math.abs(stageX - padded.maxX) <= edgeThreshold;

    const withinX = stageX >= padded.minX - edgeThreshold && stageX <= padded.maxX + edgeThreshold;
    const withinY = stageY >= padded.minY - edgeThreshold && stageY <= padded.maxY + edgeThreshold;

    if (nearTop && nearLeft) return 'nw';
    if (nearTop && nearRight) return 'ne';
    if (nearBottom && nearLeft) return 'sw';
    if (nearBottom && nearRight) return 'se';

    if (nearTop && withinX) return 'n';
    if (nearBottom && withinX) return 's';
    if (nearLeft && withinY) return 'w';
    if (nearRight && withinY) return 'e';

    return null;
}

function hitTestRectangleBody(stroke, stageX, stageY) {
    const padded = getPaddedSelectionBounds(stroke);
    if (!padded) return false;
    return stageX >= padded.minX && stageX <= padded.maxX &&
           stageY >= padded.minY && stageY <= padded.maxY;
}

const CommittedArea = GObject.registerClass(
    class CommittedArea extends St.DrawingArea {
        _init(canvas) {
            super._init({
                reactive: false,
                x_expand: true,
                y_expand: true,
                style: 'background-color: transparent;',
            });
            this._canvas = canvas;
        }

        vfunc_repaint() {
            const cr = this.get_context();
            this._canvas._paintCommitted(cr);
            cr.$dispose();
        }
    }
);

const ActiveArea = GObject.registerClass(
    class ActiveArea extends St.DrawingArea {
        _init(canvas) {
            super._init({
                reactive: false,
                visible: false,
                style: 'background-color: transparent;',
            });
            this._canvas = canvas;
        }

        vfunc_repaint() {
            const cr = this.get_context();
            this._canvas._paintActive(cr);
            cr.$dispose();
        }
    }
);

const BrushCursorIndicator = GObject.registerClass(
    class BrushCursorIndicator extends St.DrawingArea {
        _init() {
            super._init({
                reactive: false,
                visible: false,
                style: 'background-color: transparent;',
            });
            this._diameter = 16;
            this._pad = 4;
            this._updateSize();
        }

        _updateSize() {
            const size = this._diameter + this._pad * 2;
            this.set_size(size, size);
            this.queue_repaint();
        }

        setDiameter(d) {
            const diam = Math.max(4, Math.round(d));
            if (this._diameter === diam)
                return;
            this._diameter = diam;
            this._updateSize();
            const [stageX, stageY] = global.get_pointer();
            this.setPosition(stageX, stageY);
        }

        setPosition(stageX, stageY) {
            const radius = this._diameter / 2;
            this.set_position(
                Math.round(stageX - radius - this._pad),
                Math.round(stageY - radius - this._pad)
            );
        }

        vfunc_repaint() {
            const cr = this.get_context();
            cr.save();
            try {
                cr.setOperator(Cairo.Operator.CLEAR);
                cr.paint();
                cr.setOperator(Cairo.Operator.OVER);

                const r = this._diameter / 2;
                const cx = r + this._pad;
                const cy = r + this._pad;

                // Outer dark circle for visibility on bright backgrounds
                cr.setSourceRGBA(0.0, 0.0, 0.0, 0.65);
                cr.setLineWidth(2.2);
                cr.arc(cx, cy, r, 0, 2 * Math.PI);
                cr.stroke();

                // Inner white circle for visibility on dark backgrounds
                cr.setSourceRGBA(1.0, 1.0, 1.0, 0.95);
                cr.setLineWidth(1.0);
                cr.arc(cx, cy, r, 0, 2 * Math.PI);
                cr.stroke();
            } finally {
                cr.restore();
                cr.$dispose();
            }
        }
    }
);

const DrawingCanvas = GObject.registerClass(
    class DrawingCanvas extends St.Widget {
        _init(params) {
            super._init({
                reactive: false,
                x_expand: true,
                y_expand: true,
                ...params,
            });

            this._strokes = [];
            this._currentStroke = null;
            this._strokeColor = '#000000';
            this._toolId = 'freehand';
            this._strokeWidth = 3;
            this._drawing = false;
            this._dragButton = 0;
            this._dragGrab = null;
            this._overlay = null;
            this._stampCounter = 1;
            this._selectedStroke = null;
            this._activeBBox = null;
            this._transformMode = null;
            this._transformHandle = null;
            this._transformStartX = 0;
            this._transformStartY = 0;
            this._transformOrigBounds = null;
            this._lastDrawStageX = 0;
            this._lastDrawStageY = 0;

            this._originX = undefined;
            this._originY = undefined;

            this._committedArea = new CommittedArea(this);
            this._committedArea.set_position(0, 0);
            this._committedArea.add_constraint(new Clutter.BindConstraint({
                source: this,
                coordinate: Clutter.BindCoordinate.SIZE,
            }));
            this.add_child(this._committedArea);

            this._activeArea = new ActiveArea(this);
            this.add_child(this._activeArea);

            this.connect('notify::allocation', () => {
                this._updateOrigin();
                this._committedArea.queue_repaint();
            });
        }

        vfunc_destroy() {
            if (this._dragGrab) {
                this._dragGrab.dismiss();
                this._dragGrab = null;
            }
            this._overlay = null;
            super.vfunc_destroy();
        }

        get strokes() { return this._strokes; }
        get selectedStroke() { return this._selectedStroke; }

        setColor(hex) { this._strokeColor = hex; }
        setTool(id) {
            this._toolId = id;
            if (id !== 'drag' && id !== 'rectangle' && id !== 'solid-rectangle')
                this._selectedStroke = null;
            this._committedArea.queue_repaint();
        }
        setStrokeWidth(w) { this._strokeWidth = w; }

        clear() {
            this._strokes = [];
            this._currentStroke = null;
            this._activeBBox = null;
            this._activeArea.hide();
            this._stampCounter = 1;
            this._selectedStroke = null;
            this._transformMode = null;
            this._transformHandle = null;
            this._transformOrigBounds = null;
            if (this._dragGrab) {
                this._dragGrab.dismiss();
                this._dragGrab = null;
            }
            this._committedArea.queue_repaint();
        }

        undo() {
            if (this._strokes.length > 0) {
                const popped = this._strokes.pop();
                if (this._selectedStroke === popped) {
                    this._selectedStroke = null;
                    this._transformMode = null;
                    this._transformHandle = null;
                    this._transformOrigBounds = null;
                }
                this._committedArea.queue_repaint();
            }
        }

        hasStrokes() { return this._strokes.length > 0; }

        deleteSelectedStroke() {
            if (!this._selectedStroke)
                return false;
            const idx = this._strokes.indexOf(this._selectedStroke);
            if (idx !== -1)
                this._strokes.splice(idx, 1);
            this._selectedStroke = null;
            this._transformMode = null;
            this._transformHandle = null;
            this._transformOrigBounds = null;
            this._committedArea.queue_repaint();
            return true;
        }

        selectStrokeAt(stageX, stageY) {
            for (let i = this._strokes.length - 1; i >= 0; i--) {
                const stroke = this._strokes[i];
                const tool = getToolDef(stroke.toolId);
                if (tool?.hitTest?.(stroke, stageX, stageY)) {
                    this._selectedStroke = stroke;
                    this._committedArea.queue_repaint();
                    return stroke;
                }
            }
            this._selectedStroke = null;
            this._transformMode = null;
            this._transformHandle = null;
            this._transformOrigBounds = null;
            this._committedArea.queue_repaint();
            return null;
        }

        clearSelection() {
            if (this._selectedStroke) {
                this._selectedStroke = null;
                this._transformMode = null;
                this._transformHandle = null;
                this._transformOrigBounds = null;
                this._committedArea.queue_repaint();
            }
        }

        hitTestHandles(stageX, stageY) {
            if (!this._selectedStroke) return null;
            if (this._selectedStroke.toolId === 'rectangle' || this._selectedStroke.toolId === 'solid-rectangle') {
                return hitTestRectangleHandles(this._selectedStroke, stageX, stageY);
            }
            return null;
        }

        hitTestSelectedBody(stageX, stageY) {
            if (!this._selectedStroke) return false;
            if (this._selectedStroke.toolId === 'rectangle' || this._selectedStroke.toolId === 'solid-rectangle') {
                return hitTestRectangleBody(this._selectedStroke, stageX, stageY);
            }
            const tool = getToolDef(this._selectedStroke.toolId);
            return tool?.hitTest?.(this._selectedStroke, stageX, stageY) ?? false;
        }

        startTransform(stageX, stageY, handle = null, doGrab = true) {
            if (!this._selectedStroke) return;
            if (handle) {
                this._transformMode = 'resize';
                this._transformHandle = handle;
                this._transformOrigBounds = getRectangleBounds(this._selectedStroke);
            } else {
                this._transformMode = 'move';
                this._transformHandle = null;
                this._transformOrigBounds = null;
            }
            this._transformStartX = stageX;
            this._transformStartY = stageY;
            if (doGrab && !this._dragGrab)
                this._dragGrab = global.stage.grab(this._overlay ?? this);
        }

        updateTransform(stageX, stageY, shiftHeld = false, altHeld = false) {
            if (!this._selectedStroke || !this._transformMode) return;
            const selBounds = this._getSelectionBounds();
            if (this._transformMode === 'resize' && this._transformOrigBounds) {
                if (selBounds) {
                    stageX = Math.max(selBounds.minX, Math.min(selBounds.maxX, stageX));
                    stageY = Math.max(selBounds.minY, Math.min(selBounds.maxY, stageY));
                }
                const dx = stageX - this._transformStartX;
                const dy = stageY - this._transformStartY;
                const orig = this._transformOrigBounds;
                const origCenterX = (orig.minX + orig.maxX) / 2;
                const origCenterY = (orig.minY + orig.maxY) / 2;

                let minX = orig.minX;
                let minY = orig.minY;
                let maxX = orig.maxX;
                let maxY = orig.maxY;

                if (altHeld) {
                    switch (this._transformHandle) {
                        case 'e':  maxX += dx; minX -= dx; break;
                        case 'w':  minX += dx; maxX -= dx; break;
                        case 's':  maxY += dy; minY -= dy; break;
                        case 'n':  minY += dy; maxY -= dy; break;
                        case 'se': maxX += dx; minX -= dx; maxY += dy; minY -= dy; break;
                        case 'ne': maxX += dx; minX -= dx; minY += dy; maxY -= dy; break;
                        case 'sw': minX += dx; maxX -= dx; maxY += dy; minY -= dy; break;
                        case 'nw': minX += dx; maxX -= dx; minY += dy; maxY -= dy; break;
                    }
                } else {
                    switch (this._transformHandle) {
                        case 'e':  maxX += dx; break;
                        case 'w':  minX += dx; break;
                        case 's':  maxY += dy; break;
                        case 'n':  minY += dy; break;
                        case 'se': maxX += dx; maxY += dy; break;
                        case 'ne': maxX += dx; minY += dy; break;
                        case 'sw': minX += dx; maxY += dy; break;
                        case 'nw': minX += dx; minY += dy; break;
                    }
                }

                if (shiftHeld) {
                    const curW = maxX - minX;
                    const curH = maxY - minY;
                    const absW = Math.abs(curW);
                    const absH = Math.abs(curH);

                    if (this._transformHandle === 'e' || this._transformHandle === 'w') {
                        const side = absW;
                        minY = origCenterY - side / 2;
                        maxY = origCenterY + side / 2;
                    } else if (this._transformHandle === 'n' || this._transformHandle === 's') {
                        const side = absH;
                        minX = origCenterX - side / 2;
                        maxX = origCenterX + side / 2;
                    } else {
                        const side = Math.max(absW, absH);
                        const targetW = (Math.sign(curW) || 1) * side;
                        const targetH = (Math.sign(curH) || 1) * side;
                        if (altHeld) {
                            minX = origCenterX - targetW / 2;
                            maxX = origCenterX + targetW / 2;
                            minY = origCenterY - targetH / 2;
                            maxY = origCenterY + targetH / 2;
                        } else {
                            switch (this._transformHandle) {
                                case 'se': maxX = minX + targetW; maxY = minY + targetH; break;
                                case 'ne': maxX = minX + targetW; minY = maxY - targetH; break;
                                case 'sw': minX = maxX - targetW; maxY = minY + targetH; break;
                                case 'nw': minX = maxX - targetW; minY = maxY - targetH; break;
                            }
                        }
                    }
                }

                if (selBounds) {
                    minX = Math.max(selBounds.minX, Math.min(selBounds.maxX, minX));
                    maxX = Math.max(selBounds.minX, Math.min(selBounds.maxX, maxX));
                    minY = Math.max(selBounds.minY, Math.min(selBounds.maxY, minY));
                    maxY = Math.max(selBounds.minY, Math.min(selBounds.maxY, maxY));
                }

                this._selectedStroke.stagePoints = [
                    { x: minX, y: minY },
                    { x: maxX, y: maxY },
                ];
                this._committedArea.queue_repaint();
            } else if (this._transformMode === 'move') {
                let dx = stageX - this._transformStartX;
                let dy = stageY - this._transformStartY;
                if (selBounds) {
                    const b = getRectangleBounds(this._selectedStroke);
                    if (b) {
                        if (b.minX + dx < selBounds.minX) dx = selBounds.minX - b.minX;
                        if (b.maxX + dx > selBounds.maxX) dx = selBounds.maxX - b.maxX;
                        if (b.minY + dy < selBounds.minY) dy = selBounds.minY - b.minY;
                        if (b.maxY + dy > selBounds.maxY) dy = selBounds.maxY - b.maxY;
                    }
                }
                for (const p of this._selectedStroke.stagePoints) {
                    p.x += dx;
                    p.y += dy;
                }
                this._transformStartX = stageX;
                this._transformStartY = stageY;
                this._committedArea.queue_repaint();
            }
        }

        endTransform() {
            if (!this._transformMode) return;
            if (this._transformMode === 'resize' && this._selectedStroke) {
                const b = getRectangleBounds(this._selectedStroke);
                if (b) {
                    const minW = Math.max(4, b.width ?? (b.maxX - b.minX));
                    const minH = Math.max(4, b.height ?? (b.maxY - b.minY));
                    this._selectedStroke.stagePoints = [
                        { x: b.minX, y: b.minY },
                        { x: b.minX + minW, y: b.minY + minH },
                    ];
                }
            }
            this._transformMode = null;
            this._transformHandle = null;
            this._transformOrigBounds = null;
            if (this._dragGrab) {
                this._dragGrab.dismiss();
                this._dragGrab = null;
            }
            this._committedArea.queue_repaint();
        }

        moveSelectedStroke(dx, dy) {
            if (!this._selectedStroke)
                return;
            for (const p of this._selectedStroke.stagePoints) {
                p.x += dx;
                p.y += dy;
            }
            this._committedArea.queue_repaint();
        }

        adoptStroke(stroke) {
            this._strokes.push(stroke);
            this._selectedStroke = stroke;
            this._committedArea.queue_repaint();
        }

        evictStroke(stroke) {
            const idx = this._strokes.indexOf(stroke);
            if (idx !== -1)
                this._strokes.splice(idx, 1);
            if (this._selectedStroke === stroke)
                this._selectedStroke = null;
            this._committedArea.queue_repaint();
        }

        queue_repaint() {
            this._committedArea.queue_repaint();
        }

        _getSelectionBounds() {
            const ui = Main.screenshotUI;
            if (!ui?._selectionButton?.checked || !ui._areaSelector)
                return null;
            const [x, y, w, h] = ui._areaSelector.getGeometry?.() ?? [0, 0, 0, 0];
            if (w <= 2 || h <= 2)
                return null;
            return { minX: x, minY: y, maxX: x + w, maxY: y + h, w, h };
        }

        _updateOrigin() {
            const [ok, lx, ly] = this.transform_stage_point(0, 0);
            if (ok) {
                this._originX = -lx;
                this._originY = -ly;
            } else {
                const [x, y] = this.get_transformed_position();
                this._originX = x;
                this._originY = y;
            }
        }

        _stageToLocal(stageX, stageY) {
            if (this._originX === undefined || this._originY === undefined)
                this._updateOrigin();
            return {
                x: stageX - (this._originX ?? 0),
                y: stageY - (this._originY ?? 0),
            };
        }

        _startDrawing(stageX, stageY) {
            const tool = getToolDef(this._toolId);
            if (!tool?.isDrawing)
                return;

            const selBounds = this._getSelectionBounds();
            if (selBounds) {
                if (stageX < selBounds.minX || stageX > selBounds.maxX ||
                    stageY < selBounds.minY || stageY > selBounds.maxY)
                    return;
            }

            this._updateOrigin();

            this._lastDrawStageX = stageX;
            this._lastDrawStageY = stageY;

            const extra = tool.beginStroke?.() ?? {};
            this._currentStroke = {
                color: this._strokeColor,
                toolId: this._toolId,
                strokeWidth: this._strokeWidth,
                stagePoints: [{ x: stageX, y: stageY }],
                ...extra,
            };

            if (tool.isStamp) {
                this._currentStroke.counter = this._stampCounter;
                this._finishStamp();
                return;
            }

            this._drawing = true;
            this._dragGrab = global.stage.grab(this._overlay ?? this);
            this._updateActiveAreaGeometry();
        }

        _finishStamp() {
            if (this._currentStroke)
                this._strokes.push(this._currentStroke);
            this._stampCounter++;
            this._currentStroke = null;
            this._committedArea.queue_repaint();
        }

        _updateActiveAreaGeometry() {
            if (!this._currentStroke || this._currentStroke.stagePoints.length === 0)
                return;

            const pts = this._currentStroke.stagePoints;
            let minX = pts[0].x, minY = pts[0].y, maxX = pts[0].x, maxY = pts[0].y;
            for (let i = 1; i < pts.length; i++) {
                const p = pts[i];
                if (p.x < minX) minX = p.x;
                if (p.y < minY) minY = p.y;
                if (p.x > maxX) maxX = p.x;
                if (p.y > maxY) maxY = p.y;
            }

            const pad = getStrokePadding(this._toolId, this._strokeWidth);
            const boxX = minX - pad;
            const boxY = minY - pad;
            const boxW = Math.max(1, Math.ceil(maxX - minX + pad * 2));
            const boxH = Math.max(1, Math.ceil(maxY - minY + pad * 2));

            this._activeBBox = { x: boxX, y: boxY, w: boxW, h: boxH };

            if (this._originX === undefined || this._originY === undefined)
                this._updateOrigin();

            const localX = Math.round(boxX - (this._originX ?? 0));
            const localY = Math.round(boxY - (this._originY ?? 0));

            this._activeArea.set_position(localX, localY);
            this._activeArea.set_size(boxW, boxH);
            this._activeArea.show();
            this._activeArea.queue_repaint();
        }

        _updateDrawing(stageX, stageY, ctrlHeld = false) {
            if (!this._drawing || !this._currentStroke)
                return;

            const isRect = (this._toolId === 'rectangle' || this._toolId === 'solid-rectangle');
            const selBounds = this._getSelectionBounds();

            if (isRect && ctrlHeld && this._currentStroke.stagePoints.length > 1) {
                let dx = stageX - this._lastDrawStageX;
                let dy = stageY - this._lastDrawStageY;

                if (selBounds) {
                    const pts = this._currentStroke.stagePoints;
                    const minX = Math.min(pts[0].x, pts[1].x);
                    const maxX = Math.max(pts[0].x, pts[1].x);
                    const minY = Math.min(pts[0].y, pts[1].y);
                    const maxY = Math.max(pts[0].y, pts[1].y);

                    if (minX + dx < selBounds.minX) dx = selBounds.minX - minX;
                    if (maxX + dx > selBounds.maxX) dx = selBounds.maxX - maxX;
                    if (minY + dy < selBounds.minY) dy = selBounds.minY - minY;
                    if (maxY + dy > selBounds.maxY) dy = selBounds.maxY - maxY;
                }

                for (const p of this._currentStroke.stagePoints) {
                    p.x += dx;
                    p.y += dy;
                }

                this._lastDrawStageX = stageX;
                this._lastDrawStageY = stageY;
                this._updateActiveAreaGeometry();
                return;
            }

            this._lastDrawStageX = stageX;
            this._lastDrawStageY = stageY;

            if (selBounds) {
                stageX = Math.max(selBounds.minX, Math.min(selBounds.maxX, stageX));
                stageY = Math.max(selBounds.minY, Math.min(selBounds.maxY, stageY));
            }

            const tool = getToolDef(this._toolId);
            const isContinuous = (tool?.id === 'freehand' || tool?.id === 'highlighter');

            if (isContinuous) {
                const pts = this._currentStroke.stagePoints;
                const lastPt = pts[pts.length - 1];
                if (lastPt) {
                    const dx = stageX - lastPt.x;
                    const dy = stageY - lastPt.y;
                    if (dx * dx + dy * dy < MIN_DISTANCE_SQ)
                        return;
                }
                pts.push({ x: stageX, y: stageY });
            } else {
                if (this._currentStroke.stagePoints.length === 1)
                    this._currentStroke.stagePoints.push({ x: stageX, y: stageY });
                else
                    this._currentStroke.stagePoints[this._currentStroke.stagePoints.length - 1] = { x: stageX, y: stageY };
            }

            this._updateActiveAreaGeometry();
        }

        _endDrawing(stageX = null, stageY = null) {
            if (this._currentStroke) {
                if (stageX !== null && stageY !== null) {
                    const selBounds = this._getSelectionBounds();
                    if (selBounds) {
                        stageX = Math.max(selBounds.minX, Math.min(selBounds.maxX, stageX));
                        stageY = Math.max(selBounds.minY, Math.min(selBounds.maxY, stageY));
                    }
                    const pts = this._currentStroke.stagePoints;
                    const lastPt = pts[pts.length - 1];
                    const isContinuous = (this._toolId === 'freehand' || this._toolId === 'highlighter');
                    if (!lastPt || lastPt.x !== stageX || lastPt.y !== stageY) {
                        if (isContinuous)
                            pts.push({ x: stageX, y: stageY });
                        else if (pts.length > 1)
                            pts[pts.length - 1] = { x: stageX, y: stageY };
                    }
                }
                const isRect = (this._toolId === 'rectangle' || this._toolId === 'solid-rectangle');
                if (this._currentStroke.stagePoints.length > 1) {
                    let keepStroke = true;
                    if (isRect || this._toolId === 'arrow') {
                        const p0 = this._currentStroke.stagePoints[0];
                        const p1 = this._currentStroke.stagePoints[this._currentStroke.stagePoints.length - 1];
                        if (Math.abs(p1.x - p0.x) < 4 && Math.abs(p1.y - p0.y) < 4)
                            keepStroke = false;
                    }
                    if (keepStroke) {
                        this._strokes.push(this._currentStroke);
                        if (isRect) {
                            this._selectedStroke = this._currentStroke;
                            this._onSelectionChanged?.(this._selectedStroke);
                        }
                    }
                }
            }

            this._currentStroke = null;
            this._activeBBox = null;
            this._activeArea.hide();
            this._drawing = false;
            this._dragButton = 0;

            if (this._dragGrab) {
                this._dragGrab.dismiss();
                this._dragGrab = null;
            }

            this._committedArea.queue_repaint();
        }

        commitTextStroke(stroke) {
            if (stroke)
                this._strokes.push(stroke);
            this._committedArea.queue_repaint();
        }

        vfunc_button_press_event(event) {
            if (this._dragButton)
                return Clutter.EVENT_PROPAGATE;

            const button = event.get_button();
            if (button !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;

            const [stageX, stageY] = event.get_coords();

            if (this._selectedStroke) {
                const handle = this.hitTestHandles(stageX, stageY);
                if (handle) {
                    this._dragButton = button;
                    this.startTransform(stageX, stageY, handle, true);
                    this._onSelectionActivity?.();
                    return Clutter.EVENT_STOP;
                }

                if (this.hitTestSelectedBody(stageX, stageY)) {
                    this._dragButton = button;
                    this.startTransform(stageX, stageY, null, true);
                    this._onSelectionActivity?.();
                    return Clutter.EVENT_STOP;
                }

                this.clearSelection();
                this._onSelectionCleared?.();
                return Clutter.EVENT_STOP;
            }

            const tool = getToolDef(this._toolId);
            if (!tool?.isDrawing)
                return Clutter.EVENT_PROPAGATE;

            this._dragButton = button;
            this._startDrawing(stageX, stageY);
            return Clutter.EVENT_STOP;
        }

        vfunc_button_release_event(event) {
            if (this._transformMode) {
                this.endTransform();
                this._dragButton = 0;
                this._onStrokeTransformed?.(this._selectedStroke);
                return Clutter.EVENT_STOP;
            }

            if (event.get_button() !== this._dragButton)
                return Clutter.EVENT_PROPAGATE;

            const [stageX, stageY] = event.get_coords();
            this._endDrawing(stageX, stageY);
            return Clutter.EVENT_STOP;
        }

        vfunc_motion_event(event) {
            const [stageX, stageY] = event.get_coords();

            if (this._transformMode) {
                const mods = event.get_state();
                const shiftHeld = (mods & Clutter.ModifierType.SHIFT_MASK) !== 0;
                const altHeld = (mods & Clutter.ModifierType.MOD1_MASK) !== 0;
                this.updateTransform(stageX, stageY, shiftHeld, altHeld);
                this._onStrokeTransformed?.(this._selectedStroke);
                return Clutter.EVENT_STOP;
            }

            if (!this._drawing)
                return Clutter.EVENT_PROPAGATE;

            const mods = event.get_state();
            const ctrlHeld = (mods & Clutter.ModifierType.CONTROL_MASK) !== 0;
            this._updateDrawing(stageX, stageY, ctrlHeld);
            return Clutter.EVENT_STOP;
        }

        vfunc_touch_event(event) {
            const eventType = event.type();

            if (eventType === Clutter.EventType.TOUCH_BEGIN) {
                if (this._dragButton)
                    return Clutter.EVENT_PROPAGATE;

                const [stageX, stageY] = event.get_coords();
                if (this._selectedStroke) {
                    const handle = this.hitTestHandles(stageX, stageY);
                    if (handle) {
                        this._dragButton = 1;
                        this.startTransform(stageX, stageY, handle, true);
                        this._onSelectionActivity?.();
                        return Clutter.EVENT_STOP;
                    }
                    if (this.hitTestSelectedBody(stageX, stageY)) {
                        this._dragButton = 1;
                        this.startTransform(stageX, stageY, null, true);
                        this._onSelectionActivity?.();
                        return Clutter.EVENT_STOP;
                    }
                    this.clearSelection();
                    this._onSelectionCleared?.();
                    return Clutter.EVENT_STOP;
                }

                this._dragButton = 1;
                this._startDrawing(stageX, stageY);
                return Clutter.EVENT_STOP;
            } else if (eventType === Clutter.EventType.TOUCH_UPDATE) {
                const [stageX, stageY] = event.get_coords();
                if (this._transformMode) {
                    const mods = event.get_state?.() ?? 0;
                    const shiftHeld = (mods & Clutter.ModifierType.SHIFT_MASK) !== 0;
                    const altHeld = (mods & Clutter.ModifierType.MOD1_MASK) !== 0;
                    this.updateTransform(stageX, stageY, shiftHeld, altHeld);
                    this._onStrokeTransformed?.(this._selectedStroke);
                    return Clutter.EVENT_STOP;
                }
                if (!this._drawing)
                    return Clutter.EVENT_PROPAGATE;
                this._updateDrawing(stageX, stageY, false);
                return Clutter.EVENT_STOP;
            } else if (eventType === Clutter.EventType.TOUCH_END ||
                eventType === Clutter.EventType.TOUCH_CANCEL) {
                const [stageX, stageY] = event.get_coords();
                if (this._transformMode) {
                    this.endTransform();
                    this._dragButton = 0;
                    this._onStrokeTransformed?.(this._selectedStroke);
                    return Clutter.EVENT_STOP;
                }
                if (!this._drawing)
                    return Clutter.EVENT_PROPAGATE;
                this._endDrawing(stageX, stageY);
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        }

        _paintCommitted(cr) {
            cr.save();
            try {
                if (this._originX === undefined || this._originY === undefined)
                    this._updateOrigin();

                const ox = this._originX ?? 0;
                const oy = this._originY ?? 0;

                const selBounds = this._getSelectionBounds();
                if (selBounds) {
                    cr.rectangle(selBounds.minX - ox, selBounds.minY - oy, selBounds.w, selBounds.h);
                    cr.clip();
                }

                let stampCounter = 1;

                for (const stroke of this._strokes) {
                    const tool = getToolDef(stroke.toolId);
                    if (!tool?.render)
                        continue;

                    const localPoints = stroke.stagePoints.map(sp => ({
                        x: sp.x - ox,
                        y: sp.y - oy,
                    }));

                    cr.save();
                    try {
                        tool.render(cr, {
                            color: stroke.color,
                            points: localPoints,
                            counter: stroke.toolId === 'stamp' ? stampCounter++ : stroke.counter,
                            text: stroke.text,
                        }, stroke.strokeWidth);
                    } catch (e) {
                        log(`[Gradia] Error rendering stroke ${stroke.toolId}: ${e}`);
                    } finally {
                        cr.restore();
                    }
                }

                if (this._selectedStroke) {
                    cr.save();
                    try {
                        this._renderSelectionOverlay(cr, this._selectedStroke, ox, oy);
                    } catch (e) {
                        log(`[Gradia] Error rendering selection overlay: ${e}`);
                    } finally {
                        cr.restore();
                    }
                }
            } catch (err) {
                log(`[Gradia] Error in _paintCommitted: ${err}`);
            } finally {
                cr.restore();
            }
        }

        _renderSelectionOverlay(cr, stroke, ox, oy) {
            const isRect = (stroke.toolId === 'rectangle' || stroke.toolId === 'solid-rectangle');
            const padded = isRect ? getPaddedSelectionBounds(stroke) : (getToolDef(stroke.toolId)?.bounds?.(stroke));
            if (!padded)
                return;

            const tlX = padded.minX - ox;
            const tlY = padded.minY - oy;
            const brX = padded.maxX - ox;
            const brY = padded.maxY - oy;
            const w = brX - tlX;
            const h = brY - tlY;

            // 1. Accent blue outline (#3584e4)
            cr.setSourceRGBA(0.208, 0.518, 0.894, 0.95);
            cr.setLineWidth(1.5);
            cr.setDash(isRect ? [] : [5, 4], 0);
            cr.rectangle(tlX, tlY, w, h);
            cr.stroke();

            // 2. 8 transform handles for rectangles
            if (isRect) {
                const handles = getRectangleHandles(padded);
                cr.setDash([], 0);
                for (const handle of handles) {
                    const hx = handle.x - ox;
                    const hy = handle.y - oy;
                    cr.rectangle(hx - HANDLE_RADIUS, hy - HANDLE_RADIUS, HANDLE_RADIUS * 2, HANDLE_RADIUS * 2);
                    cr.setSourceRGBA(1.0, 1.0, 1.0, 1.0);
                    cr.fillPreserve();
                    cr.setSourceRGBA(0.208, 0.518, 0.894, 1.0);
                    cr.setLineWidth(1.5);
                    cr.stroke();
                }
            }
        }

        _paintActive(cr) {
            if (!this._currentStroke || !this._activeBBox)
                return;

            cr.save();
            try {
                cr.setOperator(Cairo.Operator.CLEAR);
                cr.paint();
                cr.setOperator(Cairo.Operator.OVER);
                const tool = getToolDef(this._currentStroke.toolId);
                if (!tool?.render)
                    return;

                const bboxX = this._activeBBox.x;
                const bboxY = this._activeBBox.y;

                const selBounds = this._getSelectionBounds();
                if (selBounds) {
                    cr.rectangle(selBounds.minX - bboxX, selBounds.minY - bboxY, selBounds.w, selBounds.h);
                    cr.clip();
                }

                const localPoints = this._currentStroke.stagePoints.map(p => ({
                    x: p.x - bboxX,
                    y: p.y - bboxY,
                }));

                let stampCount = 1;
                if (this._currentStroke.toolId === 'stamp') {
                    for (const s of this._strokes) {
                        if (s.toolId === 'stamp')
                            stampCount++;
                    }
                }

                tool.render(cr, {
                    color: this._currentStroke.color,
                    points: localPoints,
                    counter: this._currentStroke.counter ?? stampCount,
                    text: this._currentStroke.text,
                }, this._currentStroke.strokeWidth);
            } catch (err) {
                log(`[Gradia] Error in _paintActive: ${err}`);
            } finally {
                cr.restore();
            }
        }
    }
);

const DrawingInputOverlay = GObject.registerClass(
    class DrawingInputOverlay extends St.Widget {
        _init(canvas, params) {
            super._init({
                reactive: false,
                x_expand: true,
                y_expand: true,
                ...params,
            });
            this._canvas = canvas;
        }

        vfunc_button_press_event(event) {
            return this._canvas.vfunc_button_press_event(event);
        }

        vfunc_button_release_event(event) {
            return this._canvas.vfunc_button_release_event(event);
        }

        vfunc_motion_event(event) {
            return this._canvas.vfunc_motion_event(event);
        }

        vfunc_touch_event(event) {
            return this._canvas.vfunc_touch_event(event);
        }
    });

export default class GradiaCompanion extends Extension {
    enable() {
        this._originalOpen = Main.screenshotUI.open.bind(Main.screenshotUI);
        this._originalSaveScreenshot = Main.screenshotUI._saveScreenshot.bind(Main.screenshotUI);
        this._gradiaSettings = new GradiaSettings(this);
        this._toolbar = null;
        this._canvases = [];
        this._overlays = [];
        this._bins = [];
        this._textEntry = null;
        this._pendingTextStroke = null;

        this._dragToolActive = false;
        this._dragToolStartX = 0;
        this._dragToolStartY = 0;
        this._dragToolCanvas = null;
        this._dragToolGrab = null;
        this._trashButton = null;
        this._brushCursorIndicator = null;

        const self = this;
        this._settings = this.getSettings();

        this._selectionClearer = new SelectionClearer();

        this._ensureScreencastSupported();

        Main.screenshotUI.open = async function (mode = 0, ...rest) {
            self._portalMode = (mode === 2);
            self._ensureScreencastSupported();
            const result = await self._originalOpen(mode, ...rest);
            self._ensureUI();
            return result;
        };

        Main.screenshotUI._saveScreenshot = async function () {
            await self._captureScreenshot({ copyOnly: false });
        };

        this._screencastProgressId = Main.screenshotUI.connect('notify::screencast-in-progress', () => {
            this._handleScreencastProgressChanged();
        });

        this._autoHideSettingId = this._settings?.connect('changed::auto-hide-soft-brightness', () => {
            this._handleScreencastProgressChanged();
        });

        this._toolShortcuts = buildEffectiveToolShortcuts(this._gradiaSettings?.loadToolHotkeys?.() ?? {});
        this._toolHotkeysChangedId = this._settings?.connect('changed::tool-hotkeys', () => {
            this._toolShortcuts = buildEffectiveToolShortcuts(this._gradiaSettings?.loadToolHotkeys?.() ?? {});
        });

        this._closedId = Main.screenshotUI.connect('closed', () => {
            self._portalMode = false;
            self._removeUI();
        });
    }

    disable() {
        if (this._toolHotkeysChangedId) {
            this._settings?.disconnect(this._toolHotkeysChangedId);
            this._toolHotkeysChangedId = null;
        }

        if (this._screencastProgressId) {
            Main.screenshotUI.disconnect(this._screencastProgressId);
            this._screencastProgressId = null;
        }

        if (this._autoHideSettingId) {
            this._settings?.disconnect(this._autoHideSettingId);
            this._autoHideSettingId = null;
        }

        this._restoreDimmingOverlays();

        if (this._originalOpen) {
            Main.screenshotUI.open = this._originalOpen;
            this._originalOpen = null;
        }

        if (this._originalSaveScreenshot) {
            Main.screenshotUI._saveScreenshot = this._originalSaveScreenshot;
            this._originalSaveScreenshot = null;
        }

        if (this._closedId) {
            Main.screenshotUI.disconnect(this._closedId);
            this._closedId = null;
        }

        this._unpatchScreencastProxy();

        this._gradiaSettings.destroy();
        this._gradiaSettings = null;
        this._settings = null;
        destroyActiveToast();

        this._resetCursor();
        if (this._brushCursorIndicator) {
            this._brushCursorIndicator.destroy();
            this._brushCursorIndicator = null;
        }

        this._removeUI();
    }

    _ensureScreencastSupported() {
        const ui = Main.screenshotUI;
        if (!ui)
            return;

        if (ui._screencastSupported && ui._screencastProxy?.g_name_owner) {
            if (!this._patchedProxy && ui._screencastProxy)
                this._patchScreencastProxy(ui._screencastProxy);
            return;
        }

        try {
            const ScreencastIface = loadInterfaceXML('org.gnome.Shell.Screencast');
            const ScreencastProxy = Gio.DBusProxy.makeProxyWrapper(ScreencastIface);

            const proxy = new ScreencastProxy(
                Gio.DBus.session,
                'org.gnome.Shell.Screencast',
                '/org/gnome/Shell/Screencast',
                (_object, error) => {
                    if (error)
                        return;

                    if (proxy.ScreencastSupported) {
                        ui._screencastProxy = proxy;
                        ui._screencastSupported = true;
                        ui._syncCastButton?.();
                        this._patchScreencastProxy(proxy);
                    }
                }
            );

            proxy.connectSignal('Error', (_p, _sender, [errorName, message]) =>
                ui._screencastFailed?.('RECORDING',
                    Gio.DBusError.new_for_dbus_error(errorName, message)));

            proxy.connect('notify::g-name-owner', () => {
                if (proxy.g_name_owner || !ui._screencastInProgress || ui._screencastStarting)
                    return;

                ui._screencastFailed?.('RECORDING',
                    new GLib.Error(Gio.DBusError, Gio.DBusError.FAILED,
                        'Service crashed'));
            });
        } catch (e) {
            // ignore
        }
    }

    _patchScreencastProxy(proxy) {
        if (!proxy || this._patchedProxy === proxy)
            return;

        this._patchedProxy = proxy;
        this._originalScreencastAsync = proxy.ScreencastAsync;
        this._originalScreencastAreaAsync = proxy.ScreencastAreaAsync;

        const self = this;

        proxy.ScreencastAsync = async function (fileTemplate, options, ...rest) {
            if (self._settings?.get_boolean('auto-hide-soft-brightness'))
                self._hideDimmingOverlays();
            const [finalTemplate, finalOptions] = self._transformScreencastArgs(fileTemplate, options);
            try {
                return await self._originalScreencastAsync.call(this, finalTemplate, finalOptions, ...rest);
            } catch (err) {
                const inProgress = Main.screenshotUI?.screencast_in_progress ??
                                   Main.screenshotUI?.['screencast-in-progress'] ?? false;
                if (!inProgress)
                    self._restoreDimmingOverlays();
                throw err;
            }
        };

        proxy.ScreencastAreaAsync = async function (x, y, w, h, fileTemplate, options, ...rest) {
            if (self._settings?.get_boolean('auto-hide-soft-brightness'))
                self._hideDimmingOverlays();
            const [finalTemplate, finalOptions] = self._transformScreencastArgs(fileTemplate, options);
            try {
                return await self._originalScreencastAreaAsync.call(this, x, y, w, h, finalTemplate, finalOptions, ...rest);
            } catch (err) {
                const inProgress = Main.screenshotUI?.screencast_in_progress ??
                                   Main.screenshotUI?.['screencast-in-progress'] ?? false;
                if (!inProgress)
                    self._restoreDimmingOverlays();
                throw err;
            }
        };
    }

    _unpatchScreencastProxy() {
        if (this._patchedProxy) {
            if (this._originalScreencastAsync) {
                this._patchedProxy.ScreencastAsync = this._originalScreencastAsync;
                this._originalScreencastAsync = null;
            }
            if (this._originalScreencastAreaAsync) {
                this._patchedProxy.ScreencastAreaAsync = this._originalScreencastAreaAsync;
                this._originalScreencastAreaAsync = null;
            }
            this._patchedProxy = null;
        }
    }

    _transformScreencastArgs(fileTemplate, options = {}) {
        let finalTemplate = fileTemplate;
        const customDir = this._settings?.get_string('recording-directory');
        if (customDir && customDir.trim().length > 0) {
            const basename = GLib.path_get_basename(fileTemplate);
            finalTemplate = GLib.build_filenamev([customDir.trim(), basename]);
        }

        const fps = this._settings?.get_int('recording-fps') || 60;
        const finalOptions = {
            ...(options || {}),
            'framerate': new GLib.Variant('i', fps),
        };

        return [finalTemplate, finalOptions];
    }

    _handleScreencastProgressChanged() {
        const inProgress = Main.screenshotUI?.screencast_in_progress ??
                           Main.screenshotUI?.['screencast-in-progress'] ?? false;
        if (inProgress) {
            if (this._settings?.get_boolean('auto-hide-soft-brightness'))
                this._hideDimmingOverlays();
            else
                this._restoreDimmingOverlays();
        } else {
            this._restoreDimmingOverlays();
        }
    }

    _hideDimmingOverlays() {
        if (this._dimmingOverlaysSuspended)
            return;

        this._dimmingOverlaysSuspended = true;

        // 1. Hook into soft-brightness-plus extension if active
        try {
            const sbp = Main.extensionManager?.lookup?.('soft-brightness-plus@joelkitching.com')?.stateObj;
            if (sbp) {
                sbp._cursorManager?.setActive?.(false);
                sbp._overlayManager?.hideOverlays?.(false);
                this._sbpSuspended = true;
            }
        } catch (e) {
            // ignore
        }

        // 2. Hide any dimmer overlay actors directly on stage
        try {
            this._suspendedStageActors = [];
            const stageChildren = global.stage?.get_children?.() ?? [];
            for (const child of stageChildren) {
                const name = child.name || '';
                if (name.includes('soft-brightness') || name.includes('dimmer')) {
                    if (child.visible) {
                        child.hide();
                        this._suspendedStageActors.push(child);
                    }
                }
            }
        } catch (e) {
            // ignore
        }
    }

    _restoreDimmingOverlays() {
        if (!this._dimmingOverlaysSuspended)
            return;

        this._dimmingOverlaysSuspended = false;

        // 1. Restore any suspended stage actors
        if (this._suspendedStageActors) {
            for (const actor of this._suspendedStageActors) {
                try {
                    actor.show();
                } catch (e) {
                    // ignore
                }
            }
            this._suspendedStageActors = [];
        }

        // 2. Restore soft-brightness-plus
        if (this._sbpSuspended) {
            this._sbpSuspended = false;
            try {
                const sbp = Main.extensionManager?.lookup?.('soft-brightness-plus@joelkitching.com')?.stateObj;
                if (sbp) {
                    sbp._cursorManager?.setActive?.(true);
                    sbp._on_brightness_change?.(false);
                }
            } catch (e) {
                // ignore
            }
        }
    }

    _buildWindowComposite(ui) {
        const selectedWindow =
            ui._windowSelectors.flatMap(sel => sel.windows())
                .find(win => win.checked);
        if (!selectedWindow)
            return null;

        const allActors = global.get_window_actors();
        const allUIWindows = ui._windowSelectors.flatMap(sel => sel.windows());

        function metaForBoundingBox(bb) {
            for (const actor of allActors) {
                const fr = actor.metaWindow.get_frame_rect();
                if (fr.x === bb.x && fr.y === bb.y &&
                    fr.width === bb.width && fr.height === bb.height)
                    return actor.metaWindow;
            }
            return null;
        }

        function entryForMeta(meta) {
            const fr = meta.get_frame_rect();
            const br = meta.get_buffer_rect();
            const uiWin = allUIWindows.find(w =>
                w.boundingBox.x === fr.x && w.boundingBox.y === fr.y &&
                w.boundingBox.width === fr.width && w.boundingBox.height === fr.height
            );
            if (uiWin) {
                const c = uiWin.windowContent;
                if (!c)
                    return null;
                return {
                    texture: c.get_texture(),
                    scale: uiWin.bufferScale,
                    rect: { x: br.x, y: br.y, width: br.width, height: br.height },
                };
            }
            const actor = allActors.find(a => {
                const afr = a.metaWindow.get_frame_rect();
                return afr.x === fr.x && afr.y === fr.y &&
                       afr.width === fr.width && afr.height === fr.height;
            });
            if (!actor)
                return null;
            const content = actor.paint_to_content(null);
            if (!content)
                return null;
            return {
                texture: content.get_texture(),
                scale: actor.get_resource_scale(),
                rect: { x: br.x, y: br.y, width: br.width, height: br.height },
            };
        }

        const selectedMeta = metaForBoundingBox(selectedWindow.boundingBox);
        const chain = [];
        if (selectedMeta) {
            let cur = selectedMeta.get_transient_for();
            while (cur) {
                chain.push(cur);
                cur = cur.get_transient_for();
            }
        }

        const selContent = selectedWindow.windowContent;
        if (!selContent)
            return null;

        const selBr = selectedMeta?.get_buffer_rect() ?? selectedWindow.boundingBox;

        const entries = [
            {
                texture: selContent.get_texture(),
                scale: selectedWindow.bufferScale,
                rect: { x: selBr.x, y: selBr.y, width: selBr.width, height: selBr.height },
            },
            ...chain.map(entryForMeta).filter(e => e !== null),
        ];

        return { windows: entries };
    }

    async _captureScreenshot({ copyOnly = false, ocr = false, externalSave = false } = {}) {
        const ui = Main.screenshotUI;
        this._commitTextEntry();
        if (ocr)
            copyOnly = false;

        if (!ui._selectionButton.checked && !ui._screenButton.checked && !ui._windowButton.checked)
            return;

        if (ui._selectionButton.checked) {
            const [,, w, h] = ui._areaSelector.getGeometry?.() ?? [0, 0, 0, 0];
            if (w <= 2 || h <= 2)
                return;
        }

        const shouldCopy = !ocr && !externalSave;
        const shouldSave = !copyOnly && !externalSave;
        const format = (this._portalMode || ocr) ? 'png' : this._settings.get_string('screenshot-format');
        const playSound = this._settings.get_boolean('play-sound');
        const customDir = this._settings.get_string('screenshot-directory');

        const _capture = (texture, geometry, scale, cursor, compositeFn, windowComposite = null) => {
            const capturePromise = captureAndStoreScreenshot(
                texture, geometry, scale, cursor, compositeFn, windowComposite,
                { copy: shouldCopy, save: shouldSave, externalSave, format, playSound, customDir }
            );
            // We have to await in portal mode to prevent a race condition where
            // the overlay gets closed before 'screenshot-taken' gets emitted, so the portal doesn't fail.
            // GNOME Shell does the same, but we only await conditionally.
            if (this._portalMode || ocr)
                return capturePromise;
            return true;
        };

        if (ui._windowButton.checked) {
            const selectedWindow =
                ui._windowSelectors.flatMap(sel => sel.windows())
                    .find(win => win.checked);
            if (!selectedWindow)
                return;

            let cursorTexture = selectedWindow.getCursorTexture()?.get_texture();
            if (!ui._cursor.visible)
                cursorTexture = null;

            if (this._settings.get_boolean('composite-window-capture')) {
                const windowComposite = this._buildWindowComposite(ui);
                if (!windowComposite)
                    return;

                windowComposite.cursor = {
                    texture: cursorTexture ?? null,
                    x: selectedWindow.cursorPoint.x + selectedWindow.boundingBox.x,
                    y: selectedWindow.cursorPoint.y + selectedWindow.boundingBox.y,
                    scale: this._getEffectiveCursorScale(ui._cursorScale),
                };
                return await _capture(null, null, 1, null, null, windowComposite);
            }

            const content = selectedWindow.windowContent;
            if (!content)
                return;

            return await _capture(
                content.get_texture(),
                null,
                selectedWindow.bufferScale,
                {
                    texture: cursorTexture ?? null,
                    x: selectedWindow.cursorPoint.x * selectedWindow.bufferScale,
                    y: selectedWindow.cursorPoint.y * selectedWindow.bufferScale,
                    scale: this._getEffectiveCursorScale(ui._cursorScale),
                },
                null
            );
        }

        const content = ui._stageScreenshot.get_content();
        if (!content)
            return;

        let cursorTexture = ui._cursor.content?.get_texture();
        if (!ui._cursor.visible)
            cursorTexture = null;

        const hasStrokes = this._canvases.some(c => c.hasStrokes());
        const strokeData = hasStrokes ? this._buildStrokeData() : null;

        return await _capture(
            content.get_texture(),
            ui._getSelectedGeometry(true),
            ui._scale,
            {
                texture: cursorTexture ?? null,
                x: ui._cursor.x * ui._scale,
                y: ui._cursor.y * ui._scale,
                scale: this._getEffectiveCursorScale(ui._cursorScale),
            },
            strokeData ? (bytes, pixbuf) => this._compositeStrokesOntoPixbuf(bytes, pixbuf, strokeData) : null
        );
    }

    _getEffectiveCursorScale(baseScale) {
        if (this._settings.get_boolean('auto-fix-cursor-scale')) {
            try {
                const interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
                const configuredSize = interfaceSettings.get_int('cursor-size');
                const baseSize = configuredSize > 0 ? configuredSize : 24;
                const ratio = Math.min(1.0, 24 / baseSize);
                return baseScale * ratio;
            } catch (e) {
                return baseScale * 0.5;
            }
        }

        if (this._settings.get_boolean('custom-cursor-scale-enabled')) {
            const factor = Math.max(0.1, this._settings.get_double('custom-cursor-scale'));
            return baseScale * factor;
        }

        return baseScale;
    }

    _binContainsStagePoint(bin, stageX, stageY) {
        const [ok, lx, ly] = bin.transform_stage_point(stageX, stageY);
        if (!ok) return false;
        const alloc = bin.allocation;
        return lx >= 0 && lx < alloc.get_width() && ly >= 0 && ly < alloc.get_height();
    }

    _canvasForStagePoint(stageX, stageY) {
        for (let i = 0; i < this._bins.length; i++) {
            if (this._binContainsStagePoint(this._bins[i], stageX, stageY))
                return this._canvases[i];
        }
        return this._canvases[0] ?? null;
    }

    _getSelectedCanvasAndStroke() {
        for (const canvas of this._canvases) {
            if (canvas.selectedStroke)
                return { canvas, stroke: canvas.selectedStroke };
        }
        return null;
    }

    _clearAllSelections(exceptCanvas = null) {
        for (const canvas of this._canvases) {
            if (canvas !== exceptCanvas)
                canvas.clearSelection();
        }
    }

    _binForStagePoint(stageX, stageY) {
        for (let i = 0; i < this._bins.length; i++) {
            if (this._binContainsStagePoint(this._bins[i], stageX, stageY))
                return this._bins[i];
        }
        return Main.screenshotUI._primaryMonitorBin ?? this._bins[0] ?? null;
    }

    _moveToolbarToMonitor(bin) {
        if (!this._toolbar || !bin || this._toolbar.get_parent() === bin)
            return;
        const curParent = this._toolbar.get_parent();
        if (curParent)
            curParent.remove_child(this._toolbar);
        bin.add_child(this._toolbar);
    }

    _updateTrashButton() {
        const sel = this._getSelectedCanvasAndStroke();
        if (!sel) {
            this._hideTrashButton();
            return;
        }

        const isRect = (sel.stroke.toolId === 'rectangle' || sel.stroke.toolId === 'solid-rectangle');
        const bounds = isRect ? getPaddedSelectionBounds(sel.stroke) : getToolDef(sel.stroke.toolId)?.bounds?.(sel.stroke);
        if (!bounds) {
            this._hideTrashButton();
            return;
        }

        const ui = Main.screenshotUI;
        if (!ui) {
            this._hideTrashButton();
            return;
        }

        const [okTR, localTRX, localTRY] = ui.transform_stage_point(bounds.maxX, bounds.minY);
        if (!okTR) {
            this._hideTrashButton();
            return;
        }

        if (!this._trashButton) {
            this._trashButton = new St.Button({
                style_class: 'gradia-selection-trash gradia-circle-button',
                child: new St.Icon({
                    icon_name: 'user-trash-symbolic',
                    style: 'icon-size: 16px;',
                }),
                reactive: true,
                x_expand: false,
                y_expand: false,
            });
            this._trashButton.connect('clicked', () => {
                const s = this._getSelectedCanvasAndStroke();
                if (s) {
                    s.canvas.deleteSelectedStroke();
                    this._hideTrashButton();
                    this._toolbar?._updateDrawingControlsSensitivity();
                    this._updateCursorForCurrentTool();
                }
            });
            this._trashButton.connect('enter-event', () => {
                this._hideBrushCursor();
                return Clutter.EVENT_PROPAGATE;
            });
            this._trashButton.connect('leave-event', () => {
                this._updateCursorForCurrentTool();
                return Clutter.EVENT_PROPAGATE;
            });
        }

        if (this._trashButton.get_parent() !== ui) {
            const curParent = this._trashButton.get_parent();
            if (curParent)
                curParent.remove_child(this._trashButton);
            if (this._brushCursorIndicator && this._brushCursorIndicator.get_parent() === ui)
                ui.insert_child_below(this._trashButton, this._brushCursorIndicator);
            else if (ui._panel && ui._panel.get_parent() === ui)
                ui.insert_child_below(this._trashButton, ui._panel);
            else
                ui.add_child(this._trashButton);
        }

        const btnX = Math.round(localTRX - TRASH_BUTTON_RADIUS);
        const btnY = Math.round(localTRY - TRASH_BUTTON_RADIUS);
        this._trashButton.set_position(btnX, btnY);
        this._trashButton.show();
    }

    _hideTrashButton() {
        this._trashButton?.hide();
    }

    _destroyTrashButton() {
        if (this._trashButton) {
            this._trashButton.destroy();
            this._trashButton = null;
        }
    }

    _onDragToolPress(stageX, stageY) {
        const sel = this._getSelectedCanvasAndStroke();
        if (sel) {
            const handle = sel.canvas.hitTestHandles(stageX, stageY);
            if (handle) {
                this._dragToolActive = true;
                this._dragToolCanvas = sel.canvas;
                this._dragToolCanvas.startTransform(stageX, stageY, handle, false);
                const idx = this._canvases.indexOf(sel.canvas);
                this._dragToolGrab = global.stage.grab(this._overlays[idx >= 0 ? idx : 0]);
                this._updateTrashButton();
                this._updateCursor(stageX, stageY, sel.canvas, this._overlays[idx >= 0 ? idx : 0]);
                return;
            }

            if (sel.canvas.hitTestSelectedBody(stageX, stageY)) {
                this._dragToolActive = true;
                this._dragToolCanvas = sel.canvas;
                this._dragToolCanvas.startTransform(stageX, stageY, null, false);
                const idx = this._canvases.indexOf(sel.canvas);
                this._dragToolGrab = global.stage.grab(this._overlays[idx >= 0 ? idx : 0]);
                this._updateTrashButton();
                this._updateCursor(stageX, stageY, sel.canvas, this._overlays[idx >= 0 ? idx : 0]);
                return;
            }
        }

        for (let i = this._canvases.length - 1; i >= 0; i--) {
            const stroke = this._canvases[i].selectStrokeAt(stageX, stageY);
            if (stroke) {
                this._clearAllSelections(this._canvases[i]);
                this._updateTrashButton();
                this._toolbar._syncToStroke(stroke);
                this._toolbar._updateDrawingControlsSensitivity();

                this._dragToolActive = true;
                this._dragToolCanvas = this._canvases[i];
                this._dragToolCanvas.startTransform(stageX, stageY, null, false);
                this._dragToolGrab = global.stage.grab(this._overlays[i] ?? this._overlays[0]);
                this._updateCursor(stageX, stageY, this._canvases[i], this._overlays[i]);
                return;
            }
        }

        this._clearAllSelections();
        this._hideTrashButton();
        this._toolbar._updateDrawingControlsSensitivity();
        this._updateCursorForCurrentTool();
        this._dragToolActive = false;
        this._dragToolCanvas = null;
    }

    _onDragToolMotion(stageX, stageY, shiftHeld = false, altHeld = false) {
        if (!this._dragToolActive || !this._dragToolCanvas)
            return;

        const stroke = this._dragToolCanvas.selectedStroke;
        const targetCanvas = this._canvasForStagePoint(stageX, stageY);

        if (this._dragToolCanvas._transformMode === 'move' && targetCanvas && targetCanvas !== this._dragToolCanvas && stroke) {
            this._dragToolCanvas.evictStroke(stroke);
            targetCanvas.adoptStroke(stroke);
            this._dragToolCanvas = targetCanvas;
            this._dragToolCanvas.startTransform(stageX, stageY, null, false);
        }

        this._dragToolCanvas.updateTransform(stageX, stageY, shiftHeld, altHeld);
        this._updateTrashButton();
    }

    _onDragToolRelease() {
        if (this._dragToolCanvas) {
            this._dragToolCanvas.endTransform();
            this._dragToolCanvas = null;
        }

        this._dragToolActive = false;

        if (this._dragToolGrab) {
            this._dragToolGrab.dismiss();
            this._dragToolGrab = null;
        }

        this._updateTrashButton();
        this._toolbar._updateDrawingControlsSensitivity();
        this._updateCursorForCurrentTool();
    }

    _compositeStrokesOntoPixbuf(bytes, pixbuf, data) {
        const { selX, selY, selW, selH, strokes, stageScale } = data;
        if (selW <= 0 || selH <= 0)
            return null;

        const imgWidth = pixbuf.get_width();
        const imgHeight = pixbuf.get_height();
        const scaleX = imgWidth / selW;
        const scaleY = imgHeight / selH;

        const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, imgWidth, imgHeight);
        const cr = new Cairo.Context(surface);
        imports.gi.Gdk.cairo_set_source_pixbuf(cr, pixbuf, 0, 0);
        cr.paint();

        for (const stroke of strokes) {
            const tool = getToolDef(stroke.toolId);
            if (!tool?.render)
                continue;

            const converted = stroke.stagePoints.map(p => ({
                x: (p.x / stageScale - selX) * scaleX,
                y: (p.y / stageScale - selY) * scaleY,
            }));

            const lw = stroke.strokeWidth * ((scaleX + scaleY) / 2);

            tool.render(cr, {
                color: stroke.color,
                points: converted,
                counter: stroke.counter,
                text: stroke.text,
            }, lw);
        }

        cr.$dispose();

        const newPixbuf = imports.gi.Gdk.pixbuf_get_from_surface(surface, 0, 0, imgWidth, imgHeight);
        if (!newPixbuf)
            return null;

        return { pixbuf: newPixbuf };
    }

    _updateTextEntryStyle() {
        if (!this._textEntry)
            return;
        const fs = Math.max(8, Math.round(this._toolbar.lineWidth * 3));
        const col = this._toolbar.selectedColor;
        this._textEntry.style = `
            color: ${col};
            caret-color: ${col};
            font-size: ${fs}px;
            font-family: "Sans";
        `;
    }

    _spawnTextEntry(stageX, stageY) {
        if (this._textEntry) {
            this._commitTextEntry();
            return;
        }

        const ui = Main.screenshotUI;
        const targetBin = this._binForStagePoint(stageX, stageY) ?? ui._primaryMonitorBin;
        if (!targetBin)
            return;

        const [ok, localX, localY] = targetBin.transform_stage_point(stageX, stageY);
        if (!ok)
            return;

        this._textTargetCanvas = this._canvasForStagePoint(stageX, stageY);

        this._pendingTextStroke = {
            color: this._toolbar.selectedColor,
            toolId: 'text',
            strokeWidth: this._toolbar.lineWidth,
            stagePoints: [{ x: stageX, y: stageY }],
            text: '',
        };

        const entry = new St.Entry({
            style_class: 'gradia-text-entry',
            reactive: true,
            can_focus: true,
        });

        entry.set_x_expand(false);
        targetBin.add_child(entry);
        this._textEntry = entry;
        this._updateTextEntryStyle();

        const allocId = entry.connect('notify::allocation', () => {
            entry.disconnect(allocId);

            const node = entry.get_theme_node();
            const paddingTop = node.get_padding(St.Side.TOP);
            const paddingLeft = node.get_padding(St.Side.LEFT);

            entry.set_position(
                Math.round(localX - paddingLeft),
                Math.round(localY - paddingTop)
            );
        });

        const clutterText = entry.get_clutter_text();

        clutterText.connect('text-changed', () => {
            const fs = Math.max(8, Math.round(this._toolbar.lineWidth * 3));
            const [, naturalWidth] = clutterText.get_preferred_width(-1);
            entry.set_width(Math.max(fs * 4, naturalWidth + fs));
        });

        clutterText.connect('key-press-event', (_actor, event) => {
            const sym = event.get_key_symbol();
            if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter)
                return this._commitTextEntry(), Clutter.EVENT_STOP;
            if (sym === Clutter.KEY_Escape)
                return this._cancelTextEntry(), Clutter.EVENT_STOP;
            return Clutter.EVENT_PROPAGATE;
        });

        this._committingText = false;
        clutterText.connect('notify::has-key-focus', () => {
            if (!clutterText.has_key_focus() && !this._committingText)
                this._commitTextEntry();
        });

        entry.grab_key_focus();
    }

    _teardownTextEntry() {
        this._committingText = true;
        this._textEntry.destroy();
        this._textEntry = null;
        this._pendingTextStroke = null;
        this._textTargetCanvas = null;

        if (this._idleSourceId)
            GLib.source_remove(this._idleSourceId);

        this._idleSourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleSourceId = 0;
            this._committingText = false;
            Main.screenshotUI.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    _commitTextEntry() {
        if (!this._textEntry)
            return;

        const text = this._textEntry.get_text()?.trim() ?? '';
        if (text.length > 0 && this._pendingTextStroke) {
            this._pendingTextStroke.text = text;
            this._textTargetCanvas?.commitTextStroke(this._pendingTextStroke);
        }

        this._teardownTextEntry();
    }

    _cancelTextEntry() {
        if (!this._textEntry)
            return;

        this._teardownTextEntry();
    }

    _buildStrokeData() {
        const ui = Main.screenshotUI;

        let selX = 0, selY = 0, selW = 0, selH = 0;

        if (ui._selectionButton.checked) {
            [selX, selY, selW, selH] = ui._areaSelector.getGeometry();
        } else if (ui._screenButton.checked) {
            const index = ui._screenSelectors.findIndex(s => s.checked);
            const monitor = Main.layoutManager.monitors[index];
            selX = monitor.x;
            selY = monitor.y;
            selW = monitor.width;
            selH = monitor.height;
        } else if (ui._windowButton.checked) {
            const window = ui._windowSelectors
                .flatMap(sel => sel.windows())
                .find(win => win.checked);

            if (window) {
                const box = window.boundingBox;
                selX = box.x;
                selY = box.y;
                selW = box.width;
                selH = box.height;
            }
        }

        const strokes = this._canvases.flatMap(c =>
            c.strokes.map(s => ({
                color: s.color,
                toolId: s.toolId,
                counter: s.counter,
                strokeWidth: s.strokeWidth,
                text: s.text,
                stagePoints: s.stagePoints.map(p => ({ x: p.x, y: p.y })),
            }))
        );

        return {
            selX, selY, selW, selH,
            strokes,
            stageScale: global.stage.scale_factor || 1,
        };
    }

    _isDrawingTool(id) {
        return getToolDef(id)?.isDrawing ?? false;
    }

    _cursorForHandle(handle) {
        switch (handle) {
            case 'n':  return Clutter.CursorType.N_RESIZE;
            case 's':  return Clutter.CursorType.S_RESIZE;
            case 'w':  return Clutter.CursorType.W_RESIZE;
            case 'e':  return Clutter.CursorType.E_RESIZE;
            case 'nw': return Clutter.CursorType.NW_RESIZE;
            case 'se': return Clutter.CursorType.SE_RESIZE;
            case 'ne': return Clutter.CursorType.NE_RESIZE;
            case 'sw': return Clutter.CursorType.SW_RESIZE;
            default:   return Clutter.CursorType.DEFAULT;
        }
    }

    _showBrushCursor(stageX, stageY, diameter) {
        if (!this._brushCursorIndicator)
            return;
        this._brushCursorIndicator.setDiameter(diameter);
        this._brushCursorIndicator.setPosition(stageX, stageY);
        if (!this._brushCursorIndicator.visible)
            this._brushCursorIndicator.show();
    }

    _hideBrushCursor() {
        if (this._brushCursorIndicator && this._brushCursorIndicator.visible)
            this._brushCursorIndicator.hide();
    }

    _setActorCursor(overlay, cursorType) {
        if (overlay)
            overlay.set_cursor_type(cursorType);
        for (const ov of this._overlays) {
            if (ov !== overlay)
                ov.set_cursor_type(cursorType);
        }
        for (const c of this._canvases)
            c.set_cursor_type(cursorType);
    }

    _resetCursor() {
        this._hideBrushCursor();
        for (const ov of this._overlays)
            ov.set_cursor_type(Clutter.CursorType.INHERIT);
        for (const c of this._canvases)
            c.set_cursor_type(Clutter.CursorType.INHERIT);
    }

    _onOverlayLeave(overlay) {
        this._hideBrushCursor();
        if (overlay)
            overlay.set_cursor_type(Clutter.CursorType.INHERIT);
    }

    _updateCursor(stageX, stageY, canvas = null, overlay = null) {
        if (!this._toolbar)
            return;

        const toolId = this._toolbar.selectedTool;

        // 1. Transforming (resize or move)
        if (canvas && canvas._transformMode) {
            this._hideBrushCursor();
            if (canvas._transformMode === 'resize' && canvas._transformHandle) {
                const cursor = this._cursorForHandle(canvas._transformHandle);
                this._setActorCursor(overlay, cursor);
            } else {
                this._setActorCursor(overlay, Clutter.CursorType.MOVE);
            }
            return;
        }

        // 2. Drag tool active drag
        if (this._dragToolActive) {
            this._hideBrushCursor();
            this._setActorCursor(overlay, Clutter.CursorType.MOVE);
            return;
        }

        // 3. Hovering over handles or body of selected stroke
        const selCanvas = canvas ?? this._canvasForStagePoint(stageX, stageY);
        if (selCanvas && selCanvas.selectedStroke) {
            const handle = selCanvas.hitTestHandles(stageX, stageY);
            if (handle) {
                this._hideBrushCursor();
                const cursor = this._cursorForHandle(handle);
                this._setActorCursor(overlay, cursor);
                return;
            }

            if (selCanvas.hitTestSelectedBody(stageX, stageY)) {
                this._hideBrushCursor();
                this._setActorCursor(overlay, Clutter.CursorType.MOVE);
                return;
            }
        }

        // 4. Object selection (drag) tool hover
        if (toolId === 'drag') {
            this._hideBrushCursor();
            let overStroke = false;
            for (const c of this._canvases) {
                for (const stroke of c.strokes) {
                    const tool = getToolDef(stroke.toolId);
                    if (tool?.hitTest?.(stroke, stageX, stageY)) {
                        overStroke = true;
                        break;
                    }
                }
                if (overStroke) break;
            }
            this._setActorCursor(overlay, overStroke ? Clutter.CursorType.MOVE : Clutter.CursorType.DEFAULT);
            return;
        }

        // 5. Freehand & Highlighter tool
        if (toolId === 'freehand' || toolId === 'highlighter') {
            const mult = (toolId === 'highlighter') ? 4 : 1;
            const diameter = (this._toolbar.lineWidth ?? 3) * mult;
            this._showBrushCursor(stageX, stageY, diameter);
            this._setActorCursor(overlay, Clutter.CursorType.NONE);
            return;
        }

        this._hideBrushCursor();

        // 6. Drawing tools: Rectangle & Arrow use CROSSHAIR, Text uses TEXT
        if (toolId === 'rectangle' || toolId === 'solid-rectangle' || toolId === 'arrow') {
            this._setActorCursor(overlay, Clutter.CursorType.CROSSHAIR);
        } else if (toolId === 'text') {
            this._setActorCursor(overlay, Clutter.CursorType.TEXT);
        } else if (toolId === 'select') {
            this._setActorCursor(overlay, Clutter.CursorType.INHERIT);
        } else {
            this._setActorCursor(overlay, Clutter.CursorType.DEFAULT);
        }
    }

    _updateCursorForCurrentTool() {
        const [stageX, stageY] = global.get_pointer();
        const canvas = this._canvasForStagePoint(stageX, stageY);
        const idx = this._canvases.indexOf(canvas);
        const overlay = idx >= 0 ? this._overlays[idx] : this._overlays[0];
        this._updateCursor(stageX, stageY, canvas, overlay);
    }

    _setTool(id) {
        if (id !== 'text')
            this._commitTextEntry();

        if (id !== 'drag' && id !== 'rectangle' && id !== 'solid-rectangle') {
            this._clearAllSelections();
            this._hideTrashButton();
        }

        const drawing = this._isDrawingTool(id);
        const dragging = id === 'drag';

        for (const canvas of this._canvases)
            canvas.setTool(id);

        for (const overlay of this._overlays)
            overlay.reactive = drawing || dragging;

        this._updateAreaSelectorState(id);
        this._toolbar?._updateDrawingControlsSensitivity();
        this._updateCursorForCurrentTool();
    }

    _updateAreaSelectorState(id) {
        const selector = Main.screenshotUI?._areaSelector;
        if (!selector)
            return;

        if (!Main.screenshotUI._selectionButton.checked)
            return;

        const drawing = this._isDrawingTool(id);
        const dragging = id === 'drag';

        if (drawing || dragging) {
            selector.reactive = false;
            setAreaSelectorHandlesVisible(selector, false);
        } else {
            selector.reactive = true;
            selector._areaIndicator?.show();
            setAreaSelectorHandlesVisible(selector, true);
        }
    }

    _isWindowMode() {
        return Main.screenshotUI._windowButton.checked;
    }

    _isRecordingMode() {
        return Main.screenshotUI._castButton?.checked ?? false;
    }

    _updateVisibilityForMode() {
        const windowMode = this._isWindowMode();
        const selectionMode = Main.screenshotUI._selectionButton?.checked ?? false;
        const recordingMode = this._isRecordingMode();
        const screenMode = Main.screenshotUI._screenButton?.checked ?? false;
        const show = !windowMode && !recordingMode;

        if (this._toolbar) {
            this._toolbar.visible = show;
            this._toolbar.setSelectionToolVisible(!screenMode);
        }

        for (const canvas of this._canvases)
            canvas.opacity = show ? 255 : 0;

        for (const overlay of this._overlays) {
            overlay.opacity = show ? 255 : 0;
            if (!show)
                overlay.reactive = false;
        }

        if (!show) {
            this._hideTrashButton();
        } else {
            this._updateAreaSelectorState(this._toolbar?.selectedTool ?? 'select');
            this._setTool(this._toolbar?.selectedTool ?? 'select');
        }

        setOcrButtonEnabled(this._ocrButton, !windowMode && !recordingMode && !screenMode && !this._portalMode);

        this._selectionHintLabel?.set({ visible: selectionMode && !recordingMode });
    }

    _connectDragOpacity() {
        const selector = Main.screenshotUI?._areaSelector;
        if (!selector)
            return;

        this._dragStartedId = selector.connect('drag-started', () => {
            this._toolbar?.ease({
                opacity: 100,
                duration: 200,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            this._resolutionOverlay?.onDragStarted();
        });

        this._dragEndedId = selector.connect('drag-ended', () => {
            this._toolbar?.ease({
                opacity: 255,
                duration: 200,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            this._resolutionOverlay?.onDragEnded();

            const [x, y] = selector.getGeometry?.() ?? [0, 0];
            const targetBin = this._binForStagePoint(x, y);
            if (targetBin)
                this._moveToolbarToMonitor(targetBin);
        });
    }

    _disconnectDragOpacity() {
        const selector = Main.screenshotUI?._areaSelector;
        if (!selector)
            return;

        for (const id of ['_dragStartedId', '_dragEndedId']) {
            if (this[id]) {
                selector.disconnect(this[id]);
                this[id] = null;
            }
        }
    }

    _ensureUI() {
        if (this._toolbar)
            return;

        const ui = Main.screenshotUI;

        this._brushCursorIndicator = new BrushCursorIndicator();
        ui.add_child(this._brushCursorIndicator);

        this._canvases = [];
        this._overlays = [];
        this._bins = [];

        const monitorBins = ui._monitorBins ?? [];
        const binsToUse = monitorBins.length > 0
            ? monitorBins
            : (ui._primaryMonitorBin ? [ui._primaryMonitorBin] : []);

        for (const bin of binsToUse) {
            this._bins.push(bin);

            const canvas = new DrawingCanvas({
                style: 'background-color: transparent;',
            });
            canvas.add_constraint(new Clutter.BindConstraint({
                source: bin,
                coordinate: Clutter.BindCoordinate.ALL,
            }));
            if (ui._areaSelector)
                ui.insert_child_above(canvas, ui._areaSelector);
            else
                ui.add_child(canvas);
            this._canvases.push(canvas);

            canvas._onSelectionChanged = (stroke) => {
                this._clearAllSelections(canvas);
                this._updateTrashButton();
                this._toolbar?._syncToStroke(stroke);
                this._toolbar?._updateDrawingControlsSensitivity();
                this._updateCursorForCurrentTool();
            };
            canvas._onStrokeTransformed = (_stroke) => {
                this._updateTrashButton();
                this._updateCursorForCurrentTool();
            };
            canvas._onSelectionCleared = () => {
                this._hideTrashButton();
                this._toolbar?._updateDrawingControlsSensitivity();
                this._updateCursorForCurrentTool();
            };
            canvas._onSelectionActivity = () => {
                this._moveToolbarToMonitor(bin);
            };

            const overlay = new DrawingInputOverlay(canvas, {
                style: 'background-color: transparent;',
            });
            canvas._overlay = overlay;

            overlay.connect('button-press-event', (_actor, event) => {
                this._moveToolbarToMonitor(bin);
                const tool = this._toolbar?.selectedTool;

                if (tool === 'text') {
                    const [stageX, stageY] = event.get_coords();
                    this._spawnTextEntry(stageX, stageY);
                    return Clutter.EVENT_STOP;
                }

                if (tool === 'drag') {
                    const [stageX, stageY] = event.get_coords();
                    this._onDragToolPress(stageX, stageY);
                    return Clutter.EVENT_STOP;
                }

                return Clutter.EVENT_PROPAGATE;
            });

            overlay.connect('motion-event', (_actor, event) => {
                this._moveToolbarToMonitor(bin);
                const [stageX, stageY] = event.get_coords();
                this._updateCursor(stageX, stageY, canvas, overlay);
                if (this._toolbar?.selectedTool === 'drag') {
                    const mods = event.get_state();
                    const shiftHeld = (mods & Clutter.ModifierType.SHIFT_MASK) !== 0;
                    const altHeld = (mods & Clutter.ModifierType.MOD1_MASK) !== 0;
                    this._onDragToolMotion(stageX, stageY, shiftHeld, altHeld);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            overlay.connect('leave-event', () => {
                this._onOverlayLeave(overlay);
                return Clutter.EVENT_PROPAGATE;
            });

            overlay.connect('button-release-event', () => {
                if (this._toolbar?.selectedTool === 'drag') {
                    this._onDragToolRelease();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            bin.add_child(overlay);
            this._overlays.push(overlay);
        }

        const primaryBin = ui._primaryMonitorBin;
        if (!primaryBin)
            return;

        this._toolbar = new Toolbar({ extensionPath: this.path, gradiaSettings: this._gradiaSettings });

        this._toolbar.connect('enter-event', () => {
            this._hideBrushCursor();
            return Clutter.EVENT_PROPAGATE;
        });

        this._toolbar.connect('leave-event', () => {
            this._updateCursorForCurrentTool();
            return Clutter.EVENT_PROPAGATE;
        });

        this._toolbar.connect('tool-changed', (_toolbar, id) => {
            this._setTool(id);
        });

        this._toolbar.connect('color-changed', (_toolbar, hex) => {
            for (const canvas of this._canvases)
                canvas.setColor(hex);

            const sel = this._getSelectedCanvasAndStroke();
            if (sel) {
                sel.stroke.color = hex;
                sel.canvas.queue_repaint();
            }

            if (this._pendingTextStroke) {
                this._pendingTextStroke.color = hex;
                this._updateTextEntryStyle();
            }
        });

        this._toolbar.connect('line-width-changed', (_toolbar, width) => {
            for (const canvas of this._canvases)
                canvas.setStrokeWidth(width);

            const sel = this._getSelectedCanvasAndStroke();
            if (sel) {
                sel.stroke.strokeWidth = width;
                sel.canvas.queue_repaint();
                this._updateTrashButton();
            }

            const curTool = this._toolbar?.selectedTool;
            if (curTool === 'freehand' || curTool === 'highlighter') {
                const mult = (curTool === 'highlighter') ? 4 : 1;
                this._brushCursorIndicator?.setDiameter(width * mult);
            }

            if (this._pendingTextStroke) {
                this._pendingTextStroke.strokeWidth = width;
                this._updateTextEntryStyle();
            }
        });

        this._toolbar._hasSelection = () => !!this._getSelectedCanvasAndStroke();

        this._toolbar.connect('undo', () => {
            if (this._textEntry) {
                this._cancelTextEntry();
                return;
            }
            if (this._toolbar.selectedTool === 'drag') {
                const sel = this._getSelectedCanvasAndStroke();
                if (sel) {
                    sel.canvas.deleteSelectedStroke();
                    this._hideTrashButton();
                    this._toolbar._updateDrawingControlsSensitivity();
                    this._updateCursorForCurrentTool();
                    return;
                }
            }
            for (let i = this._canvases.length - 1; i >= 0; i--) {
                if (this._canvases[i].hasStrokes()) {
                    this._canvases[i].undo();
                    break;
                }
            }
            this._updateTrashButton();
            this._toolbar._updateDrawingControlsSensitivity();
            this._updateCursorForCurrentTool();
        });

        this._toolbar.connect('clear', () => {
            this._cancelTextEntry();
            this._clearAllSelections();
            this._hideTrashButton();
            for (const canvas of this._canvases)
                canvas.clear();
            this._toolbar._updateDrawingControlsSensitivity();
            this._updateCursorForCurrentTool();
        });

        if (isGradiaFlatpakInstalled()) {
            const ui = Main.screenshotUI;
            this._ocrButton = createOcrButton(async () => {
                const file = await this._captureScreenshot({ ocr: true });
                Main.screenshotUI.close();
                launchGradiaOcrForFile(file);
            });
            ui._showPointerButtonContainer.insert_child_below(this._ocrButton, ui._showPointerButton);
        }

        this._settingsButton = createSettingsButton(() => {
            Main.screenshotUI.close();
            this.openPreferences();
        });
        ui._showPointerButtonContainer.insert_child_below(this._settingsButton, ui._showPointerButton);

        for (const canvas of this._canvases) {
            canvas.setColor(this._toolbar.selectedColor);
            canvas.setTool(this._toolbar.selectedTool);
            canvas.setStrokeWidth(this._toolbar.lineWidth);
        }

        primaryBin.add_child(this._toolbar);

        this._resolutionOverlay = new ResolutionOverlay(primaryBin);

        this._keyPressId = Main.screenshotUI.connect('key-press-event', (_actor, event) => {
            const sym = event.get_key_symbol();
            const mods = event.get_state();
            const ctrl = mods & Clutter.ModifierType.CONTROL_MASK;

            if (ctrl && sym === Clutter.KEY_z) {
                this._toolbar.emit('undo');
                return Clutter.EVENT_STOP;
            }

            if (ctrl && sym === Clutter.KEY_c) {
                if (!this._isRecordingMode() && !this._portalMode) {
                    this._captureScreenshot({ copyOnly: true }).then(result => {
                        if (result !== undefined)
                            Main.screenshotUI.close();
                    });
                    return Clutter.EVENT_STOP;
                }
            }

            if (ctrl && sym === Clutter.KEY_s) {
                if (!this._isRecordingMode()) {
                    this._captureScreenshot({ externalSave: true }).then(result => {
                        if (result !== undefined)
                            Main.screenshotUI.close();
                    });
                    return Clutter.EVENT_STOP;
                }
            }

            if (ctrl && sym === Clutter.KEY_e) {
                this._ocrButton?.emit('clicked', 0);
                return Clutter.EVENT_STOP;
            }

            if (sym === Clutter.KEY_Delete || sym === Clutter.KEY_BackSpace) {
                const sel = this._getSelectedCanvasAndStroke();
                if (sel) {
                    sel.canvas.deleteSelectedStroke();
                    this._hideTrashButton();
                    this._toolbar?._updateDrawingControlsSensitivity();
                    return Clutter.EVENT_STOP;
                }
            }

            if (!ctrl && this._toolShortcuts && (sym in this._toolShortcuts)) {
                this._toolbar._onToolClicked(this._toolShortcuts[sym]);
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        });

        for (const [prop, id] of MODE_BUTTONS) {
            this[id] = ui[prop].connect('notify::checked', () => this._updateVisibilityForMode());
        }

        if (this._settings.get_boolean('clear-selection')) {
            this._selectionClearer.patch(ui._areaSelector);

            this._selectionHintLabel = new St.Label({
                text: 'Drag to Make a Selection',
                style_class: 'screenshot-ui-panel gradia-hint-label',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
                y_expand: true,
            });
            primaryBin.add_child(this._selectionHintLabel);

          const hideLabelId = ui._areaSelector.connect('drag-started', () => {
              this._selectionHintLabel?.ease({
                  opacity: 0, duration: 200,
                  mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                  onComplete: () => this._selectionHintLabel?.hide(),
              });
              ui._areaSelector.disconnect(hideLabelId);
          });
        }

        this._connectDragOpacity();

        this._scrollId = Main.screenshotUI.connect('scroll-event', (_actor, event) => {
            this._toolbar.scrollLineWidth(event.get_scroll_direction());
            return Clutter.EVENT_PROPAGATE;
        });

        this._setTool('select');
        this._updateVisibilityForMode();
    }

    _removeUI() {
        this._cancelTextEntry();
        this._destroyTrashButton();

        if (this._idleSourceId) {
            GLib.source_remove(this._idleSourceId);
            this._idleSourceId = 0;
        }

        if (this._ocrButton) {
            this._ocrButton.destroy();
            this._ocrButton = null;
        }

        if (this._settingsButton) {
            this._settingsButton.destroy();
            this._settingsButton = null;
        }

        if (this._dragToolGrab) {
            this._dragToolGrab.dismiss();
            this._dragToolGrab = null;
        }

        const ui = Main.screenshotUI;

        if (this._keyPressId) {
            Main.screenshotUI.disconnect(this._keyPressId);
            this._keyPressId = null;
        }

        for (const [prop, id] of MODE_BUTTONS) {
            if (this[id]) {
                ui[prop].disconnect(this[id]);
                this[id] = null;
            }
        }

        this._disconnectDragOpacity();
        this._selectionClearer.restore();

        const selector = ui._areaSelector;
        if (selector) {
            selector.reactive = true;
            setAreaSelectorHandlesVisible(selector, true);
        }

        for (const overlay of this._overlays)
            overlay.destroy();
        this._overlays = [];

        for (const canvas of this._canvases)
            canvas.destroy();
        this._canvases = [];
        this._bins = [];

        if (this._selectionHintLabel) {
            this._selectionHintLabel.destroy();
            this._selectionHintLabel = null;
        }

        if (this._toolbar) {
            this._toolbar.destroy();
            this._toolbar = null;
        }

        if (this._scrollId) {
            Main.screenshotUI.disconnect(this._scrollId);
            this._scrollId = null;
        }

        if (this._resolutionOverlay) {
            this._resolutionOverlay.destroy();
            this._resolutionOverlay = null;
        }

        this._resetCursor();
        if (this._brushCursorIndicator) {
            this._brushCursorIndicator.destroy();
            this._brushCursorIndicator = null;
        }
    }
}
