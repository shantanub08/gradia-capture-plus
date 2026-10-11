import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MIN_W = 100;
const MIN_H = 50;
const FADE_DURATION = 400;

export class ResolutionOverlay {
    constructor(primaryBin, settings = null) {
        this._primaryBin = primaryBin;
        this._settings = settings;
        this._visible = false;
        this._motionId = null;

        this._label = new St.Label({
            style_class: 'gradia-resolution-label',
            opacity: 0,
            visible: false,
        });
        this._primaryBin.add_child(this._label);
    }

    onDragStarted() {
        this._fadeIn();
        const selector = Main.screenshotUI?._areaSelector;
        if (selector) {
            this._motionId = selector.connect('motion-event', () => {
                this._update();
                return Clutter.EVENT_PROPAGATE;
            });
        }
        this._update();
    }

    onDragEnded() {
        this._disconnectMotion();
        this._fadeOut();
    }

    _disconnectMotion() {
        const selector = Main.screenshotUI?._areaSelector;
        if (selector && this._motionId) {
            selector.disconnect(this._motionId);
            this._motionId = null;
        }
    }

    _getScaleForPoint(stageX, stageY) {
        if (this._settings && !this._settings.get_boolean('match-native-resolution'))
            return this._settings.get_double('custom-resolution-scale') || 1.0;

        const monitors = Main.layoutManager.monitors ?? [];
        for (const mon of monitors) {
            if (stageX >= mon.x && stageX < mon.x + mon.width &&
                stageY >= mon.y && stageY < mon.y + mon.height) {
                return mon.geometry_scale ?? global.stage.scale_factor ?? 1.0;
            }
        }

        return Main.layoutManager.primaryMonitor?.geometry_scale ??
               global.stage.scale_factor ?? 1.0;
    }

    _fadeIn() {
        if (this._visible)
            return;
        this._visible = true;
        this._label.remove_all_transitions();
        this._label.visible = true;
        this._label.ease({
            opacity: 255,
            duration: FADE_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _fadeOut() {
        if (!this._visible)
            return;
        this._visible = false;
        this._label.remove_all_transitions();
        this._label.ease({
            opacity: 0,
            duration: FADE_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (!this._visible)
                    this._label.visible = false;
            },
        });
    }

    _update() {
        const selector = Main.screenshotUI?._areaSelector;
        if (!selector)
            return;

        const [x, y, w, h] = selector.getGeometry();

        if (w < MIN_W || h < MIN_H) {
            this._fadeOut();
            return;
        }

        if (!this._visible)
            this._fadeIn();

        const scale = this._getScaleForPoint(x + w / 2, y + h / 2);
        const physW = Math.round(w * scale);
        const physH = Math.round(h * scale);
        const logW = Math.round(w);
        const logH = Math.round(h);

        const [ok, localX, localY] = this._primaryBin.transform_stage_point(
            x + w / 2,
            y + h / 2,
        );

        if (!ok)
            return;

        if (physW !== logW || physH !== logH)
            this._label.set_text(`${physW}×${physH} (${logW}×${logH})`);
        else
            this._label.set_text(`${physW}×${physH}`);

        const [, natW] = this._label.get_preferred_width(-1);
        const [, natH] = this._label.get_preferred_height(-1);

        this._label.set_position(
            Math.round(localX - natW / 2),
            Math.round(localY - natH / 2),
        );
    }

    destroy() {
        this._disconnectMotion();
        if (this._label) {
            this._label.destroy();
            this._label = null;
        }
        this._primaryBin = null;
    }
}
