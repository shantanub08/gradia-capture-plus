import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GdkPixbuf from 'gi://GdkPixbuf';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const FORMAT_INFO = [
    { id: 'png',  label: 'PNG'  },
    { id: 'webp', label: 'WebP' },
    { id: 'avif', label: 'AVIF' },
];

const GRADIA_FLATPAK_ID = 'be.alexandervanhee.gradia';
const GRADIA_DESKTOP_ID = `${GRADIA_FLATPAK_ID}.desktop`;

function isGradiaInstalled() {
    const appInfo = Gio.DesktopAppInfo.new(GRADIA_DESKTOP_ID);
    if (!appInfo)
        return false;
    return !!appInfo.get_string('X-Flatpak');
}

const AboutPage = GObject.registerClass(
    class AboutPage extends Adw.PreferencesPage {
        constructor(settings, window = null) {
            super({
                title: 'Preferences',
                icon_name: 'org.gnome.Settings-symbolic',
            });
            this._settings = settings;
            this._window = window;
            this._setupCss();
            this._buildTextRecognitionGroup();
            this._buildScreenshotGroup();
            this._buildScreenRecordingGroup();
            this._buildCursorGroup();
        }

        _setupCss() {
            const cssProvider = new Gtk.CssProvider();
            cssProvider.load_from_string(`
            .donation-card {
                background: linear-gradient(to bottom left, #1b5fc0, #159eff);
                border-radius: 12px;
                padding: 16px;
                color: white;
            }
        `);
            Gtk.StyleContext.add_provider_for_display(
                Gdk.Display.get_default(),
                cssProvider,
                Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
            );
        }
        _buildTextRecognitionGroup() {
            this._ocrGroup = new Adw.PreferencesGroup({ title: 'Text Recognition' });
            this.add(this._ocrGroup);
            this._ocrRow = null;
            this._refreshOcrRow();

            const monitor = Gio.AppInfoMonitor.get();
            this._appInfoMonitor = monitor;
            this._appInfoChangedId = monitor.connect('changed', () => this._refreshOcrRow());
        }

        _refreshOcrRow() {
            const installed = isGradiaInstalled();

            if (this._ocrRow) {
                this._ocrGroup.remove(this._ocrRow);
                this._ocrRow = null;
            }

            const row = new Adw.ActionRow(installed ? {
                title: 'Gradia Installed',
                subtitle: 'OCR text extraction is available in the screenshot UI',
            } : {
                title: 'Get the Gradia Flatpak',
                subtitle: 'Install the app via Flathub to enable the OCR text extraction feature',
                activatable: true,
            });

            row.add_suffix(new Gtk.Image({
                icon_name: installed ? 'object-select-symbolic' : 'go-next-symbolic',
                css_classes: installed ? ['success'] : [],
                valign: Gtk.Align.CENTER,
            }));

            if (!installed)
              row.connect('activated', () =>
                  Gtk.show_uri(null, `appstream://${GRADIA_FLATPAK_ID}`, Gdk.CURRENT_TIME));

            this._ocrGroup.add(row);
            this._ocrRow = row;
        }

        _buildScreenshotGroup() {
            const group = new Adw.PreferencesGroup({ title: 'Screenshot' });

            const availableIds = new Set(
                GdkPixbuf.Pixbuf.get_formats()
                    .filter(f => f.is_writable())
                    .map(f => f.get_name())
            );

            const formats = FORMAT_INFO.filter(f => availableIds.has(f.id));

            const formatRow = new Adw.ComboRow({
                title: 'File Format',
                subtitle: 'Changing this may slow down saving',
            });

            const model = new Gtk.StringList();
            for (const fmt of formats)
                model.append(fmt.label);

            formatRow.set_model(model);

            const currentFormat = this._settings.get_string('screenshot-format');
            const currentIndex = formats.findIndex(f => f.id === currentFormat);
            formatRow.set_selected(currentIndex >= 0 ? currentIndex : formats.findIndex(f => f.id === 'png'));

            formatRow.connect('notify::selected', () => {
                const selected = formats[formatRow.get_selected()];
                if (selected)
                    this._settings.set_string('screenshot-format', selected.id);
            });

            const clearSelectionRow = new Adw.SwitchRow({
                title: 'Disable Initial Selection',
                subtitle: 'Hide the default or last pre-selected area when the overlay opens',
            });

            this._settings.bind('clear-selection', clearSelectionRow, 'active', Gio.SettingsBindFlags.DEFAULT);

            const compositeWindowRow = new Adw.SwitchRow({
                title: 'Include Parent Windows',
                subtitle: 'Also capture parent windows when a transient window is selected',
            });

            this._settings.bind('composite-window-capture', compositeWindowRow, 'active', Gio.SettingsBindFlags.DEFAULT);

            const soundRow = new Adw.SwitchRow({
                title: 'Sound',
                subtitle: 'Play a shutter sound effect on capture',
            });

            this._settings.bind('play-sound', soundRow, 'active', Gio.SettingsBindFlags.DEFAULT);

            const defaultPicturesDir = GLib.build_filenamev([
                GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) || GLib.get_home_dir(),
                'Screenshots',
            ]);

            const screenshotDirRow = this._createDirectoryRow({
                title: 'Save Folder',
                settingsKey: 'screenshot-directory',
                defaultPath: defaultPicturesDir,
            });

            group.add(formatRow);
            group.add(screenshotDirRow);
            group.add(clearSelectionRow);
            group.add(compositeWindowRow);
            group.add(soundRow);
            this.add(group);
        }

        _buildScreenRecordingGroup() {
            const group = new Adw.PreferencesGroup({ title: 'Screen Recording' });

            const fpsRow = new Adw.ComboRow({
                title: 'Frame Rate',
                subtitle: 'Smoother recordings (60 FPS) require more CPU and storage',
            });

            const fpsOptions = [
                { label: '30 FPS', value: 30 },
                { label: '60 FPS', value: 60 },
            ];

            const model = new Gtk.StringList();
            for (const opt of fpsOptions)
                model.append(opt.label);

            fpsRow.set_model(model);

            const currentFps = this._settings.get_int('recording-fps');
            const currentIndex = fpsOptions.findIndex(opt => opt.value === currentFps);
            fpsRow.set_selected(currentIndex >= 0 ? currentIndex : 1);

            fpsRow.connect('notify::selected', () => {
                const selected = fpsOptions[fpsRow.get_selected()];
                if (selected)
                    this._settings.set_int('recording-fps', selected.value);
            });

            const defaultVideosDir = GLib.build_filenamev([
                GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS) || GLib.get_home_dir(),
                'Screencasts',
            ]);

            const recordingDirRow = this._createDirectoryRow({
                title: 'Save Folder',
                settingsKey: 'recording-directory',
                defaultPath: defaultVideosDir,
            });

            const autoHideDimmingRow = new Adw.SwitchRow({
                title: 'Auto-Un-dim Screen',
                subtitle: 'Temporarily hide software brightness dimming (e.g. Soft Brightness Plus) while recording',
            });

            this._settings.bind('auto-hide-soft-brightness', autoHideDimmingRow, 'active', Gio.SettingsBindFlags.DEFAULT);

            group.add(fpsRow);
            group.add(recordingDirRow);
            group.add(autoHideDimmingRow);
            this.add(group);
        }

        _createDirectoryRow({ title, settingsKey, defaultPath }) {
            const row = new Adw.ActionRow({
                title,
            });

            const updateSubtitle = () => {
                const custom = this._settings.get_string(settingsKey);
                if (custom && custom.trim().length > 0)
                    row.subtitle = custom;
                else
                    row.subtitle = `Default: ${defaultPath}`;
            };
            updateSubtitle();

            const resetButton = new Gtk.Button({
                icon_name: 'edit-clear-symbolic',
                valign: Gtk.Align.CENTER,
                tooltip_text: 'Reset to default folder',
                css_classes: ['flat'],
            });

            const updateResetSensitivity = () => {
                const custom = this._settings.get_string(settingsKey);
                resetButton.sensitive = Boolean(custom && custom.trim().length > 0);
            };
            updateResetSensitivity();

            resetButton.connect('clicked', () => {
                this._settings.set_string(settingsKey, '');
                updateSubtitle();
                updateResetSensitivity();
            });

            const chooseButton = new Gtk.Button({
                icon_name: 'folder-open-symbolic',
                valign: Gtk.Align.CENTER,
                tooltip_text: 'Choose custom folder',
                css_classes: ['flat'],
            });

            chooseButton.connect('clicked', () => {
                const parentWindow = this._window ?? this.get_root();
                if (Gtk.FileDialog) {
                    const dialog = new Gtk.FileDialog({
                        title: `Select ${title}`,
                        modal: true,
                    });

                    const currentPath = this._settings.get_string(settingsKey);
                    if (currentPath && currentPath.trim().length > 0) {
                        try {
                            dialog.set_initial_folder(Gio.File.new_for_path(currentPath));
                        } catch (e) {
                            // ignore invalid path
                        }
                    }

                    dialog.select_folder(parentWindow, null, (dlg, res) => {
                        try {
                            const folder = dlg.select_folder_finish(res);
                            if (folder) {
                                const path = folder.get_path();
                                if (path) {
                                    this._settings.set_string(settingsKey, path);
                                    updateSubtitle();
                                    updateResetSensitivity();
                                }
                            }
                        } catch (e) {
                            // Cancelled by user
                        }
                    });
                }
            });

            row.add_suffix(resetButton);
            row.add_suffix(chooseButton);

            return row;
        }

        _buildCursorGroup() {
            const group = new Adw.PreferencesGroup({
                title: 'Cursor Scaling',
                description: 'Fix or adjust pointer size in screenshots (useful for HiDPI / fractional scaling)',
            });

            const autoFixRow = new Adw.SwitchRow({
                title: 'Auto-Fix Cursor Scale',
                subtitle: 'Automatically normalize pointer size to standard 24px proportion',
            });

            const customScaleSwitchRow = new Adw.SwitchRow({
                title: 'Custom Cursor Scale',
                subtitle: 'Manually scale pointer size in screenshots',
            });

            const customScaleAdjustment = new Gtk.Adjustment({
                lower: 0.25,
                upper: 2.0,
                step_increment: 0.05,
                page_increment: 0.25,
                value: this._settings.get_double('custom-cursor-scale'),
            });

            const customScaleSpinRow = new Adw.SpinRow({
                title: 'Cursor Scale Factor',
                subtitle: 'Multiplier applied to cursor size (e.g. 0.50 = 50%)',
                adjustment: customScaleAdjustment,
                digits: 2,
            });

            this._settings.bind('auto-fix-cursor-scale', autoFixRow, 'active', Gio.SettingsBindFlags.DEFAULT);
            this._settings.bind('custom-cursor-scale-enabled', customScaleSwitchRow, 'active', Gio.SettingsBindFlags.DEFAULT);
            this._settings.bind('custom-cursor-scale', customScaleAdjustment, 'value', Gio.SettingsBindFlags.DEFAULT);

            autoFixRow.connect('notify::active', () => {
                if (autoFixRow.active && customScaleSwitchRow.active)
                    customScaleSwitchRow.active = false;
            });

            const updateCustomSensitivity = () => {
                customScaleSpinRow.sensitive = customScaleSwitchRow.active;
            };

            customScaleSwitchRow.connect('notify::active', () => {
                if (customScaleSwitchRow.active && autoFixRow.active)
                    autoFixRow.active = false;
                updateCustomSensitivity();
            });

            updateCustomSensitivity();

            group.add(autoFixRow);
            group.add(customScaleSwitchRow);
            group.add(customScaleSpinRow);
            this.add(group);
        }
    });

const TOOL_DEFINITIONS = [
    { id: 'select', name: 'Crop Tool', defaultKey: 'q', numKey: '1' },
    { id: 'drag', name: 'Object Selection Tool', defaultKey: 'd', numKey: '2' },
    { id: 'freehand', name: 'Freehand Tool', defaultKey: 'f', numKey: '3' },
    { id: 'rectangle', name: 'Rectangle Tool', defaultKey: 'r', numKey: '4' },
    { id: 'solid-rectangle', name: 'Solid Rectangle Tool', defaultKey: 'b', numKey: '5' },
    { id: 'highlighter', name: 'Highlighter Tool', defaultKey: 'h', numKey: '6' },
    { id: 'arrow', name: 'Arrow Tool', defaultKey: 'a', numKey: '7' },
    { id: 'text', name: 'Text Tool', defaultKey: 't', numKey: '8' },
    { id: 'stamp', name: 'Number Stamp Tool', defaultKey: 'n', numKey: '9' },
];

const ShortcutsPage = GObject.registerClass(
    class ShortcutsPage extends Adw.PreferencesPage {
        constructor(settings = null) {
            super({
                title: 'Shortcuts',
                icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
            });
            this._settings = settings;

            this._addGroup('Screenshot Mode', [
                ['Take Screenshot / Capture',  'Return space'],
                ['Copy to Clipboard',          '<Control>c'],
                ['Save As…',                   '<Control>s'],
                ['Extract Text (OCR)',         '<Control>e'],
                ['Area Selection',             's'],
                ['Screen Selection',           'c'],
                ['Window Selection',           'w'],
                ['Toggle Pointer Visibility',  'p'],
                ['Toggle Screen Recording',    'v'],
            ]);

            this._addGroup('General Annotation', [
                ['Undo Last Stroke',     '<Control>z'],
                ['Delete Selected',      'Delete BackSpace'],
            ]);

            this._buildToolHotkeysGroup();
            this._addSystemKeybindingsGroup();
        }

        _loadToolHotkeys() {
            if (!this._settings) return new Map();
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

        _saveToolHotkey(toolId, key) {
            if (!this._settings) return;
            const map = this._loadToolHotkeys();
            map.set(toolId, key.toLowerCase());
            const entries = [];
            for (const [tId, k] of map) {
                entries.push(GLib.Variant.new_dict_entry(
                    GLib.Variant.new_string(tId),
                    GLib.Variant.new_string(k)
                ));
            }
            this._settings.set_value('tool-hotkeys', GLib.Variant.new_array(
                GLib.VariantType.new('{ss}'),
                entries
            ));
        }

        _buildToolHotkeysGroup() {
            const group = new Adw.PreferencesGroup({
                title: 'Tool Hotkeys',
                description: 'Customize single-key shortcuts for each tool. Number keys (1–9) remain available as alternates.',
            });

            const currentMap = this._loadToolHotkeys();

            for (const tool of TOOL_DEFINITIONS) {
                const row = new Adw.ActionRow({
                    title: tool.name,
                    subtitle: `Alternate shortcut: ${tool.numKey}`,
                });

                const entry = new Gtk.Entry({
                    max_length: 1,
                    width_chars: 2,
                    xalign: 0.5,
                    valign: Gtk.Align.CENTER,
                    tooltip_text: 'Type a single key to activate this tool',
                });

                const currentKey = currentMap.get(tool.id) ?? tool.defaultKey;
                entry.set_text(currentKey.toUpperCase());

                entry.connect('changed', () => {
                    const text = entry.get_text().trim();
                    if (text.length > 0) {
                        const char = text[text.length - 1];
                        if (/^[a-zA-Z0-9]$/.test(char)) {
                            entry.set_text(char.toUpperCase());
                            this._saveToolHotkey(tool.id, char.toLowerCase());
                        } else {
                            const prev = this._loadToolHotkeys().get(tool.id) ?? tool.defaultKey;
                            entry.set_text(prev.toUpperCase());
                        }
                    }
                });

                const resetBtn = new Gtk.Button({
                    icon_name: 'edit-undo-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: `Reset to default (${tool.defaultKey.toUpperCase()})`,
                    css_classes: ['flat'],
                });
                resetBtn.connect('clicked', () => {
                    entry.set_text(tool.defaultKey.toUpperCase());
                    this._saveToolHotkey(tool.id, tool.defaultKey);
                });

                row.add_suffix(entry);
                row.add_suffix(resetBtn);
                group.add(row);
            }

            this.add(group);
        }

        _addGroup(title, entries, note = null) {
            const group = new Adw.PreferencesGroup({ title });
            if (note)
                group.set_description(note);
            for (const [label, accel] of entries) {
                const row = new Adw.ActionRow({ title: label });
                const shortcut = new Adw.ShortcutLabel({ accelerator: accel });
                shortcut.set_valign(Gtk.Align.CENTER);
                row.add_suffix(shortcut);
                group.add(row);
            }
            this.add(group);
        }

        _addSystemKeybindingsGroup() {
            const shellSettings = new Gio.Settings({
                schema_id: 'org.gnome.shell.keybindings',
            });

            const entries = [
                ['Take a screenshot interactively', 'show-screenshot-ui'],
                ['Take a screencast interactively', 'show-screen-recording-ui'],
                ['Take a screenshot of a window', 'screenshot-window'],
                ['Take a screenshot', 'screenshot'],
            ];

            const group = new Adw.PreferencesGroup({ title: 'System Keybindings' });
            group.set_description('Configurable in Settings → Keyboard.');

            for (const [label, key] of entries) {
                const row = new Adw.ActionRow({ title: label });
                const accels = shellSettings.get_strv(key);
                const shortcut = new Adw.ShortcutLabel({ accelerator: accels[0] ?? '' });
                shortcut.set_valign(Gtk.Align.CENTER);
                row.add_suffix(shortcut);
                group.add(row);
            }

            this.add(group);
        }
    });

export default class GradiaPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.add(new AboutPage(settings, window));
        window.add(new ShortcutsPage(settings));
    }
}
