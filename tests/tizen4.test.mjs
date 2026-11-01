import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import vm from 'node:vm';
import { parse } from 'acorn';

const root = fileURLToPath(new URL('../', import.meta.url));
const js = join(root, 'src/js');

function browser(files, extra = {}) {
    const store = {};
    const context = vm.createContext({
        setTimeout, clearTimeout,
        console: { log() {} },
        localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } },
        DevLog: { log() {}, errorText: e => e.message },
        ...extra
    });
    context.window = context;
    vm.runInContext('String.prototype.padStart = undefined;', context);
    for (const file of files) vm.runInContext(readFileSync(join(js, file), 'utf8'), context, { filename: file });
    return context;
}

test('all packaged runtime JS parses as ES5 (Tizen 4 compatible syntax)', () => {
    for (const file of readdirSync(js).filter(f => f.endsWith('.js'))) {
        const source = readFileSync(join(js, file), 'utf8');
        assert.doesNotThrow(() => parse(source, { ecmaVersion: 5 }), file);
        assert.doesNotMatch(source, /\.padStart\s*\(/, file + ' must not require ES2017 padStart');
    }
});

test('cold start clock and Italian defaults work without padStart', () => {
    const c = browser(['config.js', 'prefs.js', 'appearance.js']);
    const date = new Date(2026, 10, 1, 7, 3);
    assert.equal(c.Appearance.time(date).time, '07:03');
    c.Prefs.get().appearance.clock = '12h';
    assert.equal(c.Appearance.time(new Date(2026, 10, 1, 0, 9)).time, '12:09');
    assert.equal(c.Appearance.time(new Date(2026, 10, 1, 13, 9)).suffix, 'PM');
    assert.equal(c.Prefs.get().appearance.locale, 'it-IT');
    assert.equal(c.Prefs.get().appearance.font, 'system');
    assert.equal(c.Prefs.get().sound.enabled, false);
    assert.deepEqual(Array.from(c.LAUNCHER_CONFIG.hdmiPorts), [1, 2]);
    assert.deepEqual(Array.from(c.LAUNCHER_CONFIG.inputs, i => i.hdmi), [1, 2]);
});

test('native 2018 YouTube and regional streaming ids appear and can be pinned', () => {
    const c = browser(['config.js', 'brands.js', 'apps.js']);
    const apps = [
        { id: 'com.samsung.tv.cobalt-yt', name: 'YouTube', show: true },
        { id: 'old.native.spotify', name: 'Spotify', show: true },
        { id: 'italian.rai', name: 'RaiPlay', show: true },
        { id: 'italian.mediaset', name: 'Mediaset Infinity', show: true },
        { id: 'adplatform.ADPlayer', name: 'ADPlayer', show: true },
        { id: 'com.samsung.tv.ep-service', name: 'YouTube service', show: true }
    ];
    const pinned = c.Apps.curated(apps, c.LAUNCHER_CONFIG);
    assert.deepEqual(Array.from(pinned, a => a.label), ['YouTube', 'Spotify', 'RaiPlay', 'Mediaset Infinity']);
    assert.deepEqual(Array.from(c.Apps.allSorted(apps, false), a => a.id).sort(), apps.slice(0, 4).map(a => a.id).sort());
});

test('successful HDMI selection survives a missing Samsung viewer app', async () => {
    let selected;
    const c = browser(['apps.js', 'inputs.js'], {
        tizen: {
            application: { launch(id, ok, error) { error({ message: 'Not found' }); } },
            systeminfo: { getPropertyValue(kind, ok) { ok({ connected: [{ type: 'HDMI', number: 2 }] }); } },
            tvwindow: { setSource(source, ok) { selected = source; ok(); } }
        }
    });
    assert.equal(await c.Inputs.open(2, 'switch+viewer'), 'source-selected');
    assert.equal(selected.number, 2);
});

test('unavailable or failed HDMI APIs reject cleanly instead of claiming success', async () => {
    const c = browser(['apps.js', 'inputs.js'], { tizen: { systeminfo: {} } });
    await assert.rejects(c.Inputs.open(2, 'switch'), /getPropertyValue/);
    c.tizen.systeminfo.getPropertyValue = (kind, ok) => ok({ connected: [{ type: 'HDMI', number: 2 }] });
    c.tizen.tvwindow = { setSource(source, ok, err) { err({ message: 'Denied' }); } };
    await assert.rejects(c.Inputs.open(2, 'switch+viewer'), e => e.message === 'Denied');
});

test('diagnostics distinguish the configured profile from actual firmware evidence', () => {
    let exited = false;
    const c = browser(['config.js', 'device.js'], {
        navigator: { userAgent: 'Tizen 4 test' },
        document: { documentElement: { classList: { contains: () => true } } },
        tizen: { application: { getCurrentApplication: () => ({ exit() { exited = true; } }) } }
    });
    const unavailable = c.Device.report();
    assert.equal(unavailable.targetModel, 'UE55NU7093UXXH');
    assert.equal(unavailable.reportedFirmware, null);
    assert.equal(unavailable.firmwareMatches, null);
    c.webapis = { productinfo: { getFirmware: () => 'different-firmware' } };
    assert.equal(c.Device.report().firmwareMatches, false);
    c.Device.exit();
    assert.equal(exited, true);
});


test('live TV selects the reported tuner, preserves its number and opens the native viewer', async () => {
    const calls = [];
    const tuner = { type: 'TV', number: 7 };
    const c = browser(['apps.js', 'inputs.js'], {
        tizen: {
            application: { launch(id, ok) { calls.push(id); ok(); } },
            systeminfo: { getPropertyValue(kind, ok) { ok({ connected: [{ type: 'HDMI', number: 1 }, tuner] }); } },
            tvwindow: { setSource(source, ok) { calls.push(source); ok(); } }
        }
    });
    assert.equal(await c.Inputs.openTv(), 'external');
    assert.equal(calls[0], tuner);
    assert.equal(calls[1], 'org.tizen.tv-viewer');
});

test('live TV opens the video plane when the firmware lacks the native viewer id', async () => {
    const calls = [];
    const c = browser(['apps.js', 'inputs.js'], {
        tizen: {
            application: { launch(id, ok, error) { calls.push('viewer'); error({ message: 'Not found' }); } },
            systeminfo: { getPropertyValue(kind, ok) { ok({ disconnected: [{ type: 'TV', number: 0 }] }); } },
            tvwindow: {
                setSource(source, ok) { calls.push(source.type); ok(); },
                show(ok, error, rectangle) { calls.push(Array.from(rectangle)); ok(); }
            }
        }
    });
    assert.equal(await c.Inputs.openTv(), 'inapp');
    assert.deepEqual(calls, ['TV', 'viewer', ['0px', '0px', '1920px', '1080px']]);
    c.tizen.tvwindow.show = (ok, err) => err({ message: 'Video plane denied' });
    await assert.rejects(c.Inputs.openTv(), e => e.message === 'Video plane denied');
});

test('live TV refuses an absent tuner or denied source without launching another input', async () => {
    let changed = false;
    let launched = false;
    const c = browser(['apps.js', 'inputs.js'], {
        tizen: {
            application: { launch() { launched = true; } },
            systeminfo: { getPropertyValue(kind, ok) { ok({ connected: [{ type: 'HDMI', number: 1 }] }); } },
            tvwindow: { setSource() { changed = true; } }
        }
    });
    await assert.rejects(c.Inputs.openTv(), /sintonizzatore TV/);
    assert.equal(changed, false);
    assert.equal(launched, false);
    c.tizen.systeminfo.getPropertyValue = (kind, ok) => ok({ connected: [{ type: 'TV', number: 1 }] });
    c.tizen.tvwindow.setSource = (source, ok, err) => err({ message: 'Source denied' });
    await assert.rejects(c.Inputs.openTv(), e => e.message === 'Source denied');
    assert.equal(launched, false);
});
