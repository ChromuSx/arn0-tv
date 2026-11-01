/* Short-lived Node 4.4 diagnostic and explicitly armed one-shot return trial. */
'use strict';
var http = require('http');
var fs = require('fs');
var child = require('child_process');
var url = require('url');
var Trial = require('./home-trial.js').Trial;
var PORT = 8131;
var LIFETIME = 10 * 60 * 1000;
var IDS = ['Arn0Probe1.Probe', 'Arn0Lnchr0.Launcher', 'com.samsung.tv.csfs',
    'org.tizen.tv-viewer', 'com.samsung.tv.cobalt-yt'];
var READS = [
    ['/usr/bin/vconftool', ['list']],
    ['/usr/bin/vconftool', ['--help']],
    ['/usr/bin/aul_test', ['getallappstatus']],
    ['/usr/bin/dbus-send', ['--system', '--type=method_call', '--print-reply',
        '--dest=org.freedesktop.DBus', '/', 'org.freedesktop.DBus.ListNames']],
    ['/usr/bin/dbus-send', ['--session', '--type=method_call', '--print-reply',
        '--dest=org.freedesktop.DBus', '/', 'org.freedesktop.DBus.ListNames']],
    ['/usr/bin/vconftool', ['get', '-r', 'db/menu/eden']],
    ['/usr/bin/vconftool', ['get', '-r', 'db/appfw']],
    ['/usr/bin/vconftool', ['get', '-r', 'memory/menu']],
    ['/usr/bin/vconftool', ['get', '-r', 'memory/appfw']],
    ['/usr/bin/dbus-send', ['--system', '--type=method_call', '--print-reply',
        '--dest=org.tizen.tv.appfw.appctxmgr', '/', 'org.freedesktop.DBus.Introspectable.Introspect']],
    ['/usr/bin/dbus-send', ['--system', '--type=method_call', '--print-reply',
        '--dest=org.tizen.tv.appfw.appctxmgr', '/org/tizen/tv/appfw/appctxmgr', 'org.freedesktop.DBus.Introspectable.Introspect']],
    ['/usr/bin/vconftool', ['get', 'db/appfw/home_appid']],
    ['/usr/bin/dbus-send', ['--system', '--type=method_call', '--print-reply',
        '--dest=org.tizen.tv.appfw.appctxmgr', '/org/tizen/tv/appfw/appctxmgr', 'org.tizen.tv.appfw.appctxmgr.app_ctxmgr_list_visible']],
    ['/usr/bin/dbus-send', ['--system', '--type=method_call', '--print-reply',
        '--dest=org.tizen.tv.appfw.appctxmgr', '/org/tizen/tv/appfw/appctxmgr', 'org.tizen.tv.appfw.appctxmgr.app_ctxmgr_get_context']]
];

function relevantLines(text) {
    return String(text || '').split(/\r?\n/).filter(function (line) {
        return /(?:^|\s)(?:db|memory|file)\/(?:menu|appfw|setting|display|system)\//.test(line) &&
            /eden|home|foreground|focus|visible|visibility|screen_status/i.test(line);
    }).slice(0, 80).map(function (line) { return line.slice(0, 400); });
}

function readCommand(executable, args, done) {
    if (!READS.some(function (entry) { return entry[0] === executable && JSON.stringify(entry[1]) === JSON.stringify(args); })) {
        done({ error: 'read-command-refused', lines: [] });
        return;
    }
    try { child.execFile(executable, args, { timeout: 1800, maxBuffer: 256 * 1024 }, function (error, stdout, stderr) {
        var lines = executable === '/usr/bin/aul_test' ? String(stdout || '').split(/\r?\n/).filter(function (line) {
            return /pid:\s*\d+\s+appid:\s*[A-Za-z0-9_.-]+.*status:\s*\d+/.test(line);
        }).slice(0, 80).map(function (line) { return line.slice(0, 400); }) : executable === '/usr/bin/dbus-send' ? String(stdout || '').split(/\r?\n/).filter(function (line) {
            return /home|eden|window|wmanager|input|context|appfw|application|com\.samsung\.service/i.test(line);
        }).slice(0, 80).map(function (line) { return line.slice(0, 400); }) : relevantLines(stdout);
        done({ error: error ? String(error.code || error.message).slice(0, 100) : null,
            lines: lines, detail: String(stderr || stdout || '').slice(0, 12000) });
    }); } catch (error) { done({ error: error.code || error.message, lines: [], detail: 'spawn-refused' }); }
}

function readApp(appId, done) {
    var finished = false;
    var deadline = setTimeout(function () { finish({ error: 'timeout' }); if (request) request.abort(); }, 1800);
    function finish(value) { if (!finished) { finished = true; clearTimeout(deadline); done(value); } }
    var request = http.get({ host: '127.0.0.1', port: 8001,
        path: '/api/v2/applications/' + encodeURIComponent(appId) }, function (response) {
        var body = '';
        response.setEncoding('utf8');
        response.on('data', function (chunk) {
            body += chunk;
            if (body.length > 8192) { finish({ error: 'response-too-large' }); request.abort(); }
        });
        response.on('end', function () {
            var value;
            try { value = JSON.parse(body); } catch (error) { value = null; }
            finish({ status: response.statusCode, reportedId: value && value.id,
                identityMatches: !!value && value.id === appId, running: value && value.running,
                visible: value && value.visible });
        });
        response.on('error', function () { finish({ error: 'response-error' }); });
        response.on('close', function () { finish({ error: 'response-closed' }); });
    });
    request.setTimeout(1800, function () { finish({ error: 'timeout' }); request.abort(); });
    request.on('error', function (error) { finish({ error: error.code || 'request-error' }); });
}

function start() {
    // Generated into the unsigned package, never stored in the source tree.
    var token = require('./probe-token.js');
    if (typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token)) throw new Error('Invalid probe token');
    var state = { purpose: 'diagnostic Home-return trial', node: process.version,
        uid: typeof process.getuid === 'function' ? process.getuid() : null,
        startedAt: Date.now(), samples: [], tools: {}, stopped: false };
    var trial = new Trial(function (ok, error) {
        if (typeof tizen === 'undefined' || !tizen.application || typeof tizen.application.launch !== 'function') {
            error({ message: 'Application launch API is not available in this service' });
            return;
        }
        tizen.application.launch('Arn0Lnchr0.Launcher', ok, error);
    });
    state.trial = trial.status;
    state.applicationLaunch = typeof tizen !== 'undefined' && !!tizen.application && typeof tizen.application.launch === 'function';
    ['/usr/bin/vconftool', '/usr/bin/aul_test', '/usr/bin/dbus-send', '/usr/bin/dotnet', '/usr/bin/dotnet-launcher'].forEach(function (path) {
        try { state.tools[path] = fs.existsSync(path); } catch (error) { state.tools[path] = false; }
    });
    state.preflight = { input: {} };
    try { state.preflight.aulLink = fs.readlinkSync('/usr/bin/aul_test'); } catch (error) { state.preflight.aulLinkError = error.code; }
    try {
        state.preflight.tools = fs.readdirSync('/usr/bin').filter(function (name) {
            return /aul|vconf|buxton|dbus|window|wmanager|wm_test|xprop|xwininfo|wayland/.test(name);
        }).slice(0, 60);
    } catch (error) { state.preflight.toolError = error.code || 'not-readable'; }
    try {
        fs.readdirSync('/dev/input').filter(function (name) { return /^event\d+$/.test(name); }).slice(0, 16).forEach(function (name) {
            // Permission probe only: never read events or grab an input device.
            fs.open('/dev/input/' + name, 'r', function (error, descriptor) {
                if (error) { state.preflight.input[name] = error.code; return; }
                fs.close(descriptor, function (closeError) { state.preflight.input[name] = closeError ? closeError.code : 'read-open-allowed'; });
            });
        });
    } catch (error) { state.preflight.inputError = error.code || 'not-readable'; }
    if (state.tools['/usr/bin/vconftool']) readCommand('/usr/bin/vconftool', ['--help'], function (value) { state.preflight.vconfHelp = value; });
    if (state.tools['/usr/bin/dbus-send']) readCommand('/usr/bin/dbus-send', READS[3][1], function (value) { state.preflight.bus = value; });
    // Do not let dbus-send auto-launch a session bus when there is no existing address.
    if (state.tools['/usr/bin/dbus-send'] && process.env.DBUS_SESSION_BUS_ADDRESS) readCommand('/usr/bin/dbus-send', READS[4][1], function (value) { state.preflight.sessionBus = value; });
    if (state.tools['/usr/bin/aul_test']) readCommand('/usr/bin/aul_test', ['getallappstatus'], function (value) { state.preflight.aulStatus = value; });
    if (state.tools['/usr/bin/dbus-send']) {
        readCommand('/usr/bin/dbus-send', READS[9][1], function (value) { state.preflight.appContextRoot = value; });
        readCommand('/usr/bin/dbus-send', READS[10][1], function (value) { state.preflight.appContextInterface = value; });
    }
    if (state.tools['/usr/bin/vconftool']) readCommand('/usr/bin/vconftool', READS[11][1], function (value) { state.preflight.homeAppId = value; });
    var busy = false;
    var server;
    var interval;
    var deadline;
    function stop() {
        if (state.stopped) return;
        state.stopped = true;
        clearInterval(interval);
        clearTimeout(deadline);
        if (server) server.close();
        // No auto-restart/on-boot flags: this ends only the diagnostic service.
        setTimeout(function () { process.exit(0); }, 100);
    }
    function sample() {
        if (busy || state.stopped) return;
        busy = true;
        var value = { at: Date.now(), apps: {} };
        var pending = IDS.length + 7;
        function complete() {
            if (--pending !== 0 || state.stopped) return;
            state.samples.push(value);
            if (state.samples.length > 100) state.samples.shift();
            busy = false;
        }
        IDS.forEach(function (id) { readApp(id, function (result) { value.apps[id] = result; complete(); }); });
        value.preferences = {};
        ['db/menu/eden', 'db/appfw', 'memory/menu', 'memory/appfw'].forEach(function (prefix) {
            if (state.tools['/usr/bin/vconftool']) {
                readCommand('/usr/bin/vconftool', ['get', '-r', prefix], function (result) { value.preferences[prefix] = result; complete(); });
            } else { value.preferences[prefix] = { error: 'vconftool-unavailable', lines: [] }; complete(); }
        });
        if (state.tools['/usr/bin/aul_test']) {
            readCommand('/usr/bin/aul_test', ['getallappstatus'], function (result) { value.appManager = result; complete(); });
        } else { value.appManager = { error: 'aul-test-unavailable', lines: [] }; complete(); }
        value.nativeContext = {};
        [12, 13].forEach(function (index) {
            if (state.tools['/usr/bin/dbus-send']) {
                readCommand('/usr/bin/dbus-send', READS[index][1], function (result) {
                    value.nativeContext[index === 12 ? 'visible' : 'context'] = result;
                    if (index === 13) trial.sample(result, Date.now());
                    complete();
                });
            } else { value.nativeContext[index === 12 ? 'visible' : 'context'] = { error: 'dbus-send-unavailable' }; complete(); }
        });
    }
    server = http.createServer(function (request, response) {
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('Cache-Control', 'no-store');
        var parsed = url.parse(request.url, true);
        if (parsed.query.token !== token) {
            response.statusCode = 403;
            response.end('{"error":"forbidden"}');
            return;
        }
        if (!request.headers.origin || request.headers.origin === 'null') response.setHeader('Access-Control-Allow-Origin', 'null');
        if (request.method === 'GET' && parsed.pathname === '/status') {
            response.end(JSON.stringify(state));
        } else if (request.method === 'POST' && parsed.pathname === '/arm') {
            trial.arm();
            response.end('{"armed":true,"mode":"one-shot"}');
        } else if (request.method === 'POST' && parsed.pathname === '/stop') {
            response.end('{"stopping":true}');
            stop();
        } else { response.statusCode = 404; response.end('{"error":"not-found"}'); }
    });
    server.on('error', function (error) { console.log('ARN0_PROBE_LISTEN_ERROR ' + error.code); stop(); });
    server.listen(PORT, '127.0.0.1', function () { console.log('ARN0_PROBE_READY ' + process.version); sample(); });
    interval = setInterval(sample, 2000);
    deadline = setTimeout(stop, LIFETIME);
    return { stop: stop };
}

exports.relevantLines = relevantLines;
exports.readApp = readApp;
exports.readCommand = readCommand;
exports.start = start;
function reportStartupError(error) {
        var failureToken;
        try { failureToken = require('./probe-token.js'); } catch (tokenError) {
            console.log('ARN0_PROBE_TOKEN_UNAVAILABLE'); process.exitCode = 1; return;
        }
        if (typeof failureToken !== 'string' || !/^[a-f0-9]{48}$/.test(failureToken)) {
            console.log('ARN0_PROBE_TOKEN_INVALID'); process.exitCode = 1; return;
        }
        var failure = { fatalStartupError: error.message, stack: String(error.stack).slice(0, 1800) };
        var failureServer = http.createServer(function (request, response) {
            response.setHeader('Content-Type', 'application/json');
            response.setHeader('Cache-Control', 'no-store');
            var parsed = url.parse(request.url, true);
            if (parsed.query.token !== failureToken) { response.statusCode = 403; response.end('{}'); return; }
            if (!request.headers.origin || request.headers.origin === 'null') response.setHeader('Access-Control-Allow-Origin', 'null');
            if (request.method === 'POST' && parsed.pathname === '/stop') {
                response.end('{"stopping":true}');
                failureServer.close();
                setTimeout(function () { process.exit(1); }, 100);
            } else if (request.method === 'GET' && parsed.pathname === '/status') response.end(JSON.stringify(failure));
            else { response.statusCode = 404; response.end('{}'); }
        });
        failureServer.on('error', function () { process.exit(1); });
        failureServer.listen(PORT, '127.0.0.1');
        setTimeout(function () { failureServer.close(); process.exit(1); }, LIFETIME);
}
exports.reportStartupError = reportStartupError;
// Tizen may require the entry module through its own launcher.
if (process.env.ARN0_HOME_PROBE_TEST !== '1') {
    try { start(); } catch (error) { reportStartupError(error); }
}
