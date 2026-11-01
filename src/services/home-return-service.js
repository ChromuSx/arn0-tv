/* TV-local Node 4.4 service. No shell, root, input hooks or system-setting writes. */
'use strict';
var http = require('http');
var url = require('url');
var fs = require('fs');
var child = require('child_process');
var Monitor = require('./home-return-core.js').Monitor;
var PROFILE = { model: 'UE55NU7093', build: 'TIZEN-4.0-TRUNK2018-KantSU-RELEASE_20260605.1' };
var ARGS = ['--system', '--type=method_call', '--print-reply',
    '--dest=org.tizen.tv.appfw.appctxmgr', '/org/tizen/tv/appfw/appctxmgr',
    'org.tizen.tv.appfw.appctxmgr.app_ctxmgr_get_context'];

function start() {
    var token;
    try { token = require('./home-return-token.js'); } catch (error) { console.log('ARN0_HOME_TOKEN_UNAVAILABLE'); return; }
    if (typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token)) { console.log('ARN0_HOME_TOKEN_INVALID'); return; }
    var monitor = new Monitor(function (ok, fail) {
        var finished = false;
        var timer = setTimeout(function () { finish(new Error('Launch timed out')); }, 5000);
        function finish(error) { if (finished) return; finished = true; clearTimeout(timer); if (error) fail(error); else ok(); }
        try { tizen.application.launch('Arn0Lnchr0.Launcher', function () { finish(); }, finish); }
        catch (error) { finish(error); }
    });
    var state = { ready: false, compatible: false, storageReady: false, error: null, monitor: monitor.state };
    var settingsPath = null;
    var savedEnabled = true;
    var polling = false;
    var interval;
    var server;
    var initialized = false;
    var initTimer = setTimeout(function () { fail('Home service initialization timed out'); }, 10000);
    function ready() {
        if (initialized) return;
        state.ready = state.compatible && state.storageReady;
        if (!state.ready) return;
        initialized = true;
        clearTimeout(initTimer);
        monitor.enable(state.ready && savedEnabled);
    }
    function fail(message) { initialized = true; clearTimeout(initTimer); state.error = message; state.ready = false; monitor.enable(false); }
    // Only this widget's private directory is writable. Existing launcher preferences are separate.
    function initStorage() {
        tizen.filesystem.resolve('wgt-private', function (directory) {
            if (initialized) return;
            try {
                var uri = directory.toURI();
                if (!/^file:\/\//.test(uri)) throw new Error('Private storage URI is unavailable');
                var base = decodeURIComponent(uri.slice(7)).replace(/\/$/, '');
                if (!base || base.charAt(0) !== '/' || /\x00/.test(base)) throw new Error('Invalid private storage');
                settingsPath = base + '/arn0-home-return.json';
                try {
                    if (fs.statSync(settingsPath).size > 4096) throw new Error('Settings too large');
                    var saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                    if (typeof saved.enabled !== 'boolean') throw new Error('Invalid settings');
                    savedEnabled = saved.enabled;
                } catch (error) { if (error.code !== 'ENOENT') throw error; }
                state.storageReady = true;
                ready();
            } catch (error) { fail('Home settings could not be read'); }
        }, function () { if (!initialized) fail('Private storage is unavailable'); }, 'rw');
    }
    function setEnabled(enabled) {
        if (!state.ready || !settingsPath) throw new Error('Home service is unavailable');
        var pending = settingsPath + '.tmp';
        fs.writeFileSync(pending, JSON.stringify({ enabled: enabled }), { encoding: 'utf8', mode: 384 });
        fs.renameSync(pending, settingsPath);
        savedEnabled = enabled;
        monitor.enable(enabled);
    }
    function poll() {
        if (polling || !state.ready || !monitor.state.enabled || Date.now() < monitor.state.pausedUntil) return;
        polling = true;
        try {
            child.execFile('/usr/bin/dbus-send', ARGS, { timeout: 1000, maxBuffer: 8192 }, function (error, stdout) {
                polling = false;
                monitor.sample({ error: error ? 'read-failed' : null, detail: String(stdout || '') }, Date.now());
            });
        } catch (error) { polling = false; monitor.sample({ error: 'read-failed' }, Date.now()); }
    }
    function stop() { clearInterval(interval); if (server) server.close(); setTimeout(function () { process.exit(0); }, 100); }
    server = http.createServer(function (request, response) {
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('Cache-Control', 'no-store');
        var parsed = url.parse(request.url, true);
        if (parsed.query.token !== token) { response.statusCode = 403; response.end('{"error":"forbidden"}'); return; }
        if (!request.headers.origin || request.headers.origin === 'null') response.setHeader('Access-Control-Allow-Origin', 'null');
        try {
            if (request.method === 'GET' && parsed.pathname === '/status') response.end(JSON.stringify(state));
            else if (request.method === 'POST' && (parsed.pathname === '/enable' || parsed.pathname === '/disable')) {
                setEnabled(parsed.pathname === '/enable'); response.end(JSON.stringify(state));
            } else if (request.method === 'POST' && parsed.pathname === '/pause') {
                monitor.pause(Date.now()); response.end(JSON.stringify(state));
            } else if (request.method === 'POST' && parsed.pathname === '/stop') {
                response.end('{"stopping":true}'); stop();
            } else { response.statusCode = 404; response.end('{"error":"not-found"}'); }
        } catch (error) { response.statusCode = 503; response.end('{"error":"Home settings could not be saved"}'); }
    });
    server.on('error', function () { clearInterval(interval); process.exit(1); });
    server.listen(8133, '127.0.0.1');
    interval = setInterval(poll, 1000);
    try {
        tizen.systeminfo.getPropertyValue('BUILD', function (build) {
            if (initialized) return;
            state.compatible = build.model === PROFILE.model && build.buildVersion === PROFILE.build && /^v4\.4\./.test(process.version);
            if (!state.compatible) { fail('Untested TV model, firmware build or Node runtime'); return; }
            try { initStorage(); } catch (error) { fail('Private storage is unavailable'); }
        }, function () { if (!initialized) fail('Device profile is unavailable'); });
    } catch (error) { fail('Required TV APIs are unavailable'); }
    return { stop: stop };
}
exports.start = start;
if (process.env.ARN0_HOME_RETURN_TEST !== '1') start();
