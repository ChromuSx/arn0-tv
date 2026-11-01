import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import url from 'node:url';
import { parse } from 'acorn';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const core = { exports: {} };
vm.runInNewContext(read('src/services/home-return-core.js'), { exports: core.exports });
const { Monitor } = core.exports;
const reply = value => ({ detail: 'method return\n   int32 ' + value + '\n' });

test('continuous monitor requires fresh stable edges, resets on faults, and does not loop on the open bar', () => {
    let launches = 0;
    const monitor = new Monitor(ok => { launches++; ok(); });
    monitor.enable(true);
    monitor.sample(reply(262432), 1000);
    monitor.sample(reply(262432), 2000);
    assert.equal(launches, 0);
    monitor.sample(reply(262176), 3000);
    monitor.sample(reply(262432), 4000);
    monitor.sample(reply(262432), 4000);
    assert.equal(launches, 0);
    monitor.sample(reply(262432), 5000);
    for (let t = 6000; t < 20000; t += 1000) monitor.sample(reply(262432), t);
    assert.equal(launches, 1);
    monitor.sample(reply(32), 20000);
    monitor.sample({ error: 'denied' }, 21000);
    monitor.sample(reply(262432), 22000);
    monitor.sample(reply(262432), 23000);
    assert.equal(launches, 1);
    monitor.sample(reply(32), 24000);
    monitor.sample(reply(8388640), 25000);
    monitor.sample(reply(262432), 26000);
    monitor.sample(reply(262432), 27000);
    assert.equal(launches, 2);
});

test('pause and disable suppress launches and require a new edge when resumed', () => {
    let launches = 0;
    const monitor = new Monitor(ok => { launches++; ok(); });
    monitor.enable(true);
    monitor.pause(1000);
    monitor.sample(reply(32), 2000);
    monitor.sample(reply(262432), 3000);
    monitor.sample(reply(262432), 122000);
    monitor.sample(reply(262432), 123000);
    assert.equal(launches, 0);
    monitor.sample(reply(32), 124000);
    monitor.sample(reply(262432), 125000);
    monitor.sample(reply(262432), 126000);
    assert.equal(launches, 1);
    monitor.enable(false);
    monitor.sample(reply(32), 140000);
    monitor.sample(reply(262432), 141000);
    monitor.sample(reply(262432), 142000);
    assert.equal(launches, 1);
});

test('a second Home press during cooldown is deferred rather than lost', () => {
    let launches = 0;
    const monitor = new Monitor(ok => { launches++; ok(); });
    monitor.enable(true);
    monitor.sample(reply(32), 1000);
    monitor.sample(reply(262432), 2000);
    monitor.sample(reply(262432), 3000);
    assert.equal(launches, 1);
    monitor.sample(reply(32), 4000); // Arn0 visible, first bar closed.
    for (let t = 5000; t <= 8000; t += 1000) monitor.sample(reply(262432), t);
    assert.equal(launches, 2); // Do not require the user to close and reopen this bar again.
});

function client() {
    const requests = [], timers = [], events = [];
    function XMLHttpRequest() { requests.push(this); }
    XMLHttpRequest.prototype.open = function (method, uri) { this.method = method; this.path = new URL(uri).pathname; };
    XMLHttpRequest.prototype.send = function () { events.push(this.path); };
    const c = { console, Promise, XMLHttpRequest, ARN0_HOME_TOKEN: 'c'.repeat(48),
        setTimeout(fn) { timers.push(fn); }, clearTimeout() {},
        DevLog: { log() {} }, UI: { toast() {} },
        tizen: { application: { launch() {}, getCurrentApplication() { return { exit() { events.push('exit'); } }; } } }
    };
    c.window = c;
    vm.createContext(c);
    for (const path of ['src/js/config.js', 'src/js/home-return.js', 'src/js/device.js']) vm.runInContext(read(path), c);
    function respond(request, body, status = 200) { request.status = status; request.responseText = JSON.stringify(body); request.onload(); }
    return { c, requests, timers, events, respond };
}

test('client fetches current state before toggling and pauses before exiting the app', async () => {
    const t = client();
    const toggling = t.c.HomeReturn.toggle();
    assert.equal(t.requests[0].path, '/status');
    t.respond(t.requests[0], { ready: true, monitor: { enabled: true } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(t.requests[1].method, 'POST');
    assert.equal(t.requests[1].path, '/disable');
    t.respond(t.requests[1], { ready: true, monitor: { enabled: false } });
    await toggling;
    assert.equal(t.c.HomeReturn.summary(), 'Off');
    t.c.Device.exit();
    assert.equal(t.requests[2].path, '/pause');
    assert.equal(t.events.includes('exit'), false);
    t.respond(t.requests[2], { ready: true, monitor: { enabled: false, pausedUntil: Date.now() + 120000 } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(t.events.at(-1), 'exit');
});

test('client startup queries status even when launch of an already-running service has no callback', () => {
    const t = client();
    t.c.HomeReturn.init();
    assert.ok(t.timers.length > 0);
    t.timers[0]();
    assert.equal(t.requests[0].path, '/status');
});

test('client closes the app even when the pause endpoint fails', async () => {
    const t = client();
    t.c.Device.exit();
    t.requests[0].onerror();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(t.events.at(-1), 'exit');
});

function service({ model = 'UE55NU7093', saved, storageError = false, pendingProfile = false } = {}) {
    let handler, poll, at = 10000, context = 262176, launches = 0;
    const writes = [], commands = [], timers = [];
    const token = 'b'.repeat(48);
    const exports = {};
    const fs = {
        statSync() { if (saved === undefined) throw Object.assign(new Error('absent'), { code: 'ENOENT' }); return { size: saved.length }; },
        readFileSync() { return saved; },
        writeFileSync(path, value) { writes.push({ path, value }); },
        renameSync(from, to) { assert.equal(from, to + '.tmp'); }
    };
    const modules = { './home-return-token.js': token, './home-return-core.js': core.exports, url, fs,
        http: { createServer(fn) { handler = fn; return { on() {}, close() {}, listen(port, host) { assert.equal(port, 8133); assert.equal(host, '127.0.0.1'); } }; } },
        child_process: { execFile(exe, args, options, cb) {
            commands.push({ exe, args: Array.from(args) });
            assert.equal(exe, '/usr/bin/dbus-send');
            assert.equal(args.at(-1), 'org.tizen.tv.appfw.appctxmgr.app_ctxmgr_get_context');
            assert.equal(options.timeout, 1000);
            cb(null, reply(context).detail);
        } }
    };
    vm.runInNewContext(read('src/services/home-return-service.js'), {
        exports, require: name => modules[name], console,
        process: { env: { ARN0_HOME_RETURN_TEST: '1' }, version: 'v4.4.3' }, Date: { now: () => at },
        setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {},
        setInterval(fn) { poll = fn; return 1; }, clearInterval() {},
        tizen: {
            application: { launch(id, ok) { assert.equal(id, 'Arn0Lnchr0.Launcher'); launches++; ok(); } },
            systeminfo: { getPropertyValue(kind, ok) {
                assert.equal(kind, 'BUILD');
                if (!pendingProfile) ok({ model, buildVersion: 'TIZEN-4.0-TRUNK2018-KantSU-RELEASE_20260605.1' });
            } },
            filesystem: { resolve(path, ok) {
                assert.equal(path, 'wgt-private');
                if (storageError) throw new Error('denied');
                ok({ toURI: () => 'file:///private/this-widget' });
            } }
        }
    });
    exports.start();
    function request(path, method = 'GET', authorized = true) {
        const response = { statusCode: 200, setHeader() {}, end(body) { this.body = JSON.parse(body); } };
        handler({ url: path + (authorized ? '?token=' + token : ''), method, headers: { origin: 'null' } }, response);
        return response;
    }
    return { request, writes, commands, timers, tick(value, time) { context = value; at = time; poll(); }, launches: () => launches };
}

test('authenticated service drives real getter results into the monitor and persists only private settings', () => {
    const s = service();
    assert.equal(s.request('/status', 'GET', false).statusCode, 403);
    assert.equal(s.request('/disable', 'POST', false).statusCode, 403);
    assert.equal(s.request('/exec', 'POST').statusCode, 404);
    assert.equal(s.request('/status').body.ready, true);
    s.tick(262176, 10000);
    s.tick(262432, 11000);
    s.tick(262432, 12000);
    assert.equal(s.launches(), 1);
    s.request('/disable', 'POST');
    assert.equal(s.writes[0].path, '/private/this-widget/arn0-home-return.json.tmp');
    assert.deepEqual(JSON.parse(s.writes[0].value), { enabled: false });
    const calls = s.commands.length;
    s.tick(32, 20000);
    assert.equal(s.commands.length, calls);
    s.request('/enable', 'POST');
    s.request('/pause', 'POST');
    s.tick(262432, 21000);
    assert.equal(s.launches(), 1);
});

test('stored opt-out survives service restart; profile, storage and initialization failures fail closed', () => {
    assert.equal(service({ saved: '{"enabled":false}' }).request('/status').body.monitor.enabled, false);
    for (const options of [{ model: 'OTHER' }, { storageError: true }, { saved: 'broken' }]) {
        const s = service(options);
        assert.equal(s.request('/status').body.ready, false);
        assert.equal(s.request('/enable', 'POST').statusCode, 503);
        s.tick(262432, 10000);
        assert.equal(s.commands.length, 0);
        assert.equal(s.launches(), 0);
    }
    const s = service({ pendingProfile: true });
    s.timers.find(t => t.ms === 10000).fn();
    assert.equal(s.request('/status').body.error, 'Home service initialization timed out');
});

test('all service code uses Node 4 compatible syntax', () => {
    for (const path of ['src/services/home-return-core.js', 'src/services/home-return-service.js']) parse(read(path), { ecmaVersion: 5 });
});

test('the installed background service is hidden from the ordinary app picker', () => {
    const manifest = read('src/config.xml');
    const name = manifest.match(/<tizen:name>([^<]+)<\/tizen:name>/)[1];
    const context = { window: {} };
    vm.runInNewContext(read('src/js/apps.js'), context);
    assert.equal(context.window.Apps.allSorted([{ id: 'Arn0Lnchr0.HomeWatch', name, show: true }], false).length, 0);
});

test('production builder injects matching fresh private tokens without modifying source', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'arn0-home-production-'));
    try {
        for (const path of ['scripts', 'src/js', 'src/services']) mkdirSync(join(sandbox, path), { recursive: true });
        copyFileSync(new URL('scripts/build.py', root), join(sandbox, 'scripts/build.py'));
        copyFileSync(new URL('src/config.xml', root), join(sandbox, 'src/config.xml'));
        writeFileSync(join(sandbox, 'scripts/build-marks.mjs'), '// fixture');
        writeFileSync(join(sandbox, 'src/icon.png'), 'fixture');
        writeFileSync(join(sandbox, 'src/index.html'), '<script>/* HOME_RETURN_TOKEN */</script>');
        writeFileSync(join(sandbox, 'src/private.key'), 'excluded');
        const tokens = [];
        for (let i = 0; i < 2; i++) {
            execFileSync('python', [join(sandbox, 'scripts/build.py')]);
            const result = JSON.parse(execFileSync('python', ['-c', "from zipfile import ZipFile;import sys,json;z=ZipFile(sys.argv[1]);assert 'private.key' not in z.namelist();print(json.dumps([z.read('services/home-return-token.js').decode(),z.read('index.html').decode()]))", join(sandbox, 'dist/arn0-launcher.wgt')], { encoding: 'utf8' }));
            const token = result[0].match(/[a-f0-9]{48}/)[0];
            assert.ok(result[1].includes(token));
            assert.equal(readFileSync(join(sandbox, 'src/index.html'), 'utf8'), '<script>/* HOME_RETURN_TOKEN */</script>');
            tokens.push(token);
        }
        assert.notEqual(tokens[0], tokens[1]);
    } finally {
        assert.equal(dirname(resolve(sandbox)), resolve(tmpdir()));
        assert.ok(basename(sandbox).startsWith('arn0-home-production-'));
        rmSync(sandbox, { recursive: true, force: true });
    }
});
