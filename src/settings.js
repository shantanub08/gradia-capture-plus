import GLib from 'gi://GLib';

export class GradiaSettings {
    constructor(extension) {
        this._settings = extension.getSettings();
    }

    loadToolSettings() {
        const variant = this._settings.get_value('tool-settings');
        const map = new Map();

        const nChildren = variant.n_children();
        for (let i = 0; i < nChildren; i++) {
            const entry = variant.get_child_value(i);
            const toolId = entry.get_child_value(0).get_string()[0];
            const tuple = entry.get_child_value(1);
            const color = tuple.get_child_value(0).get_string()[0];
            const lineWidth = tuple.get_child_value(1).get_double();
            map.set(toolId, { color, lineWidth });
        }

        return map;
    }

    saveToolSettings(map) {
        const entries = [];

        for (const [toolId, { color, lineWidth }] of map) {
            const tuple = GLib.Variant.new_tuple([
                GLib.Variant.new_string(color),
                GLib.Variant.new_double(lineWidth),
            ]);
            const entry = GLib.Variant.new_dict_entry(
                GLib.Variant.new_string(toolId),
                tuple
            );
            entries.push(entry);
        }

        const variant = GLib.Variant.new_array(
            GLib.VariantType.new('{s(sd)}'),
            entries
        );

        this._settings.set_value('tool-settings', variant);
    }

    saveToolEntry(toolId, color, lineWidth) {
        const map = this.loadToolSettings();
        map.set(toolId, { color, lineWidth });
        this.saveToolSettings(map);
    }

    getToolEntry(toolId, defaultColor, defaultLineWidth) {
        const map = this.loadToolSettings();
        return map.get(toolId) ?? { color: defaultColor, lineWidth: defaultLineWidth };
    }

    loadToolHotkeys() {
        const variant = this._settings.get_value('tool-hotkeys');
        const map = new Map();

        const nChildren = variant.n_children();
        for (let i = 0; i < nChildren; i++) {
            const entry = variant.get_child_value(i);
            const toolId = entry.get_child_value(0).get_string()[0];
            const key = entry.get_child_value(1).get_string()[0];
            map.set(toolId, key);
        }

        return map;
    }

    saveToolHotkeys(map) {
        const entries = [];

        for (const [toolId, key] of map) {
            const entry = GLib.Variant.new_dict_entry(
                GLib.Variant.new_string(toolId),
                GLib.Variant.new_string(key)
            );
            entries.push(entry);
        }

        const variant = GLib.Variant.new_array(
            GLib.VariantType.new('{ss}'),
            entries
        );

        this._settings.set_value('tool-hotkeys', variant);
    }

    saveToolHotkey(toolId, key) {
        const map = this.loadToolHotkeys();
        map.set(toolId, key);
        this.saveToolHotkeys(map);
    }

    getToolHotkey(toolId, defaultKey = '') {
        const map = this.loadToolHotkeys();
        return map.get(toolId) ?? defaultKey;
    }

    destroy() {
        this._settings = null;
    }
}
