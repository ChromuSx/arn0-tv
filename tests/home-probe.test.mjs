import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { parse } from 'acorn';
import url from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';

const root = new URL('../experiments/home-probe/', import.meta.url);
const source = readFileSync(new URL('service.js', root), 'utf8');
const trialSource = readFileSync(new URL('home-trial.js', root), 'utf8');
const trialContext = { module: { exports: {} } };
vm.runInNewContext(trialSource, trialContext);
const { Trial, parseContext } = trialContext.module.exports;

function load(extra = {}) {
    const exports = {};
    const context = { exports, process: { env: { ARN0_HOME_PROBE_TEST: '1' } },
        require: name => name === './home-trial.js' ? { Trial } : ({}), console, setTimeout, clearTimeout, setInterval, clearInterval, ...extra };
    const originalRequire = context.require;
    context.require = name => name === './home-trial.js' ? { Trial } : originalRequire(name);
    vm.runInNewContext(source, context);
    return exports;
}

test('diagnostic service and frontend parse on the older ES5 runtime', () => {
    parse(source, { ecmaVersion: 5 });
    parse(trialSource, { ecmaVersion: 5 });
    const html = readFileSync(new URL('index.html', root), 'utf8');
    parse(html.match(/<script>([\s\S]*?)<\/script>/)[1], { ecmaVersion: 5 });
    const manifest = readFileSync(new URL('config.xml', root), 'utf8');
    assert.match(manifest, /package="Arn0Probe1"/);
    assert.match(manifest, /auto-restart="false" on-boot="false"/);
    assert.doesNotMatch(manifest, /root|filesystem\.write|shell|internal\//);
});

test('only relevant preference lines are retained with a bounded size', () => {
    const probe = load();
    const lines = probe.relevantLines('db/network/ssid = MyHome\ndb/menu/eden/visible = 1\nmemory/appfw/foreground = demo\ndb/setting/volume = 30');
    assert.deepEqual(Array.from(lines), ['db/menu/eden/visible = 1', 'memory/appfw/foreground = demo']);
    assert.equal(probe.relevantLines(('db/menu/eden/visible=' + 'x'.repeat(500) + '\n').repeat(120)).length, 80);
    assert.ok(probe.relevantLines('db/menu/eden/' + 'x'.repeat(500))[0].length <= 400);
});

test('app status preserves identity and completes only once after a timeout', () => {
    let callback, timeout;
    const request = new EventEmitter();
    request.setTimeout = (ms, fn) => { assert.equal(ms, 1800); timeout = fn; };
    request.abort = () => {};
    const probe = load({ require: name => name === 'http' ? { get: (options, cb) => {
        assert.equal(options.host, '127.0.0.1');
        assert.equal(options.port, 8001);
        assert.equal(options.path, '/api/v2/applications/expected');
        callback = cb;
        return request;
    } } : {} });
    const results = [];
    probe.readApp('expected', value => results.push(value));
    const response = new EventEmitter();
    response.setEncoding = () => {};
    response.statusCode = 200;
    callback(response);
    response.emit('data', '{"id":"different","running":true,"visible":true}');
    response.emit('end');
    timeout();
    request.emit('error', { code: 'ECONNRESET' });
    assert.equal(results.length, 1);
    assert.equal(results[0].identityMatches, false);
    assert.equal(results[0].reportedId, 'different');
});

test('oversized app replies are aborted and rejected', () => {
    let callback, aborted = false;
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.abort = () => { aborted = true; };
    const probe = load({ require: name => name === 'http' ? { get: (options, cb) => { callback = cb; return request; } } : {} });
    let result;
    probe.readApp('expected', value => { result = value; });
    const response = new EventEmitter();
    response.setEncoding = () => {};
    callback(response);
    response.emit('data', 'x'.repeat(8193));
    assert.equal(aborted, true);
    assert.equal(result.error, 'response-too-large');
});

test('service binds loopback, schedules ten-minute shutdown and accepts no commands', () => {
    let handler, bind, closed = false, commands = 0;
    const scheduled = [];
    const server = { on() {}, listen(port, host) { bind = { port, host }; }, close() { closed = true; } };
    const probe = load({
        require: name => ({ './probe-token.js': 'a'.repeat(48), url,
            http: { createServer(fn) { handler = fn; return server; } },
            fs: { existsSync(path) { return path === '/usr/bin/aul_test'; } },
            child_process: { execFile(exe, args) { assert.equal(exe, '/usr/bin/aul_test'); assert.deepEqual(Array.from(args), ['getallappstatus']); commands++; } } })[name],
        setTimeout(fn, ms) { scheduled.push({ fn, ms }); return scheduled.length; },
        clearTimeout() {}, setInterval() { return 1; }, clearInterval() {}
    });
    probe.start();
    assert.deepEqual(bind, { port: 8131, host: '127.0.0.1' });
    assert.ok(scheduled.some(t => t.ms === 600000));
    const response = { statusCode: 200, setHeader() {}, end(body) { this.body = body; } };
    handler({ method: 'POST', url: '/exec?command=anything&token=' + 'a'.repeat(48), headers: {} }, response);
    assert.equal(response.statusCode, 404);
    assert.equal(commands, 1); // Fixed read-only preflight only; HTTP added no execution.
    scheduled.find(t => t.ms === 600000).fn();
    assert.equal(closed, true);
});

test('status and stop require the private token, and authorized HTTP stop closes the server', () => {
    let handler, closed = false;
    const token = 'a'.repeat(48);
    const server = { on() {}, listen() {}, close() { closed = true; } };
    const probe = load({ require: name => ({ './probe-token.js': token, url,
        http: { createServer(fn) { handler = fn; return server; } }, fs: { existsSync() { return false; } },
        child_process: { execFile(exe, args, options, cb) { cb({ code: 'ENOENT' }, '', ''); } } })[name],
        setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; }, clearInterval() {} });
    probe.start();
    function request(method, path) {
        const response = { statusCode: 200, headers: {}, setHeader(k,v) { this.headers[k] = v; }, end(body) { this.body = body; } };
        handler({ method, url: path, headers: { origin: 'null' } }, response);
        return response;
    }
    assert.equal(request('GET', '/status').statusCode, 403);
    assert.equal(request('POST', '/stop?token=wrong').statusCode, 403);
    assert.equal(request('POST', '/arm?token=wrong').statusCode, 403);
    assert.equal(closed, false);
    const status = request('GET', '/status?token=' + token);
    assert.equal(status.statusCode, 200);
    assert.equal(status.headers['Cache-Control'], 'no-store');
    assert.equal(JSON.parse(status.body).purpose, 'diagnostic Home-return trial');
    assert.equal(status.body.includes(token), false);
    assert.equal(JSON.parse(request('POST', '/arm?token=' + token).body).armed, true);
    assert.equal(JSON.parse(request('GET', '/status?token=' + token).body).trial.armed, true);
    assert.equal(request('POST', '/stop?token=' + token).body, '{"stopping":true}');
    assert.equal(closed, true);
});

test('missing startup token fails closed without an unauthenticated fallback listener', () => {
    let listeners = 0;
    const process = { env: { ARN0_HOME_PROBE_TEST: '1' } };
    const probe = load({ process, console: { log() {} }, require(name) {
        if (name === './probe-token.js') throw new Error('missing');
        if (name === 'http') return { createServer() { listeners++; } };
        return {};
    } });
    assert.doesNotThrow(() => probe.reportStartupError(new Error('startup failure')));
    assert.equal(process.exitCode, 1);
    assert.equal(listeners, 0);
});

test('an interrupted response releases the sample instead of waiting forever', () => {
    let callback;
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.abort = () => {};
    const probe = load({ require: name => name === 'http' ? { get: (options, cb) => { callback = cb; return request; } } : {} });
    let result;
    probe.readApp('expected', value => { result = value; });
    const response = new EventEmitter();
    response.setEncoding = () => {};
    callback(response);
    response.emit('close');
    assert.equal(result.error, 'response-closed');
});

test('native readers accept only allowlisted read-only commands', () => {
    const calls = [];
    const probe = load({ require: name => name === 'child_process' ? { execFile(exe, args, options, cb) {
        calls.push({ exe, args });
        assert.equal(options.timeout, 1800);
        cb(null, 'pid: 380 appid: com.samsung.tv.csfs status: 3\n', '');
    } } : {} });
    let result;
    probe.readCommand('/usr/bin/aul_test', ['getallappstatus'], value => { result = value; });
    assert.equal(result.lines.length, 1);
    probe.readCommand('/usr/bin/aul_test', ['kill', 'anything'], value => { result = value; });
    assert.equal(result.error, 'read-command-refused');
    probe.readCommand('/bin/sh', ['-c', 'anything'], value => { result = value; });
    assert.equal(result.error, 'read-command-refused');
    assert.equal(calls.length, 1);
});

test('the builder packages a fresh token at the expected path without exporting it into source', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'arn0-home-build-'));
    try {
        const repo = join(sandbox, 'repo');
        const probe = join(repo, 'experiments', 'home-probe');
        mkdirSync(probe, { recursive: true });
        mkdirSync(join(repo, 'src'));
        for (const name of ['build.py', 'config.xml', 'index.html', 'service.js', 'home-trial.js']) copyFileSync(new URL(name, root), join(probe, name));
        writeFileSync(join(repo, 'src', 'icon.png'), 'fixture');
        writeFileSync(join(probe, 'private.key'), 'must not be packaged');
        const tokens = [];
        for (let i = 0; i < 2; i++) {
            execFileSync('python', [join(probe, 'build.py')]);
            const tokenModule = execFileSync('python', ['-c', "from zipfile import ZipFile;import sys;z=ZipFile(sys.argv[1]);assert sorted(z.namelist())==['config.xml','home-trial.js','icon.png','index.html','probe-token.js','service.js'];print(z.read('probe-token.js').decode())", join(repo, 'dist', 'arn0-home-probe.wgt')], { encoding: 'utf8' });
            parse(tokenModule, { ecmaVersion: 5 });
            const context = { module: { exports: {} } };
            vm.runInNewContext(tokenModule, context);
            assert.match(context.module.exports, /^[a-f0-9]{48}$/);
            tokens.push(context.module.exports);
            assert.equal(existsSync(join(probe, 'probe-token.js')), false);
        }
        assert.notEqual(tokens[0], tokens[1]);
    } finally {
        assert.equal(dirname(resolve(sandbox)), resolve(tmpdir()));
        assert.ok(basename(sandbox).startsWith('arn0-home-build-'));
        rmSync(sandbox, { recursive: true, force: true });
    }
});

function contextReply(value) { return { detail: 'method return\n   int32 ' + value + '\n', error: null }; }
test('Home trial rejects unknown/error states and does not react to volume or unarmed input', () => {
    let launches = 0;
    const trial = new Trial(() => { launches++; });
    trial.sample(contextReply(262432), 1);
    trial.arm();
    for (const [value, at] of [[262176, 2], [8388640, 3], [32, 4], [262176, 5]]) trial.sample(contextReply(value), at);
    trial.sample({ error: 'denied', detail: 'int32 262432' }, 6);
    trial.sample(contextReply(262432), 7);
    trial.sample(contextReply(262432), 8);
    assert.equal(launches, 0);
    assert.equal(parseContext({ detail: 'int32 2\nint32 3' }), null);
    assert.equal(parseContext({ detail: 'int32 -1' }), null);
});

test('Home trial requires a fresh clear-to-Home edge and launches only once', () => {
    let launches = 0;
    const trial = new Trial(ok => { launches++; ok(); });
    trial.arm();
    trial.sample(contextReply(262432), 1);
    trial.sample(contextReply(262432), 2);
    assert.equal(launches, 0);
    trial.sample(contextReply(262176), 3);
    trial.sample(contextReply(262432), 4);
    trial.sample(contextReply(262432), 4); // Duplicate reading must not count twice.
    assert.equal(launches, 0);
    trial.sample(contextReply(262432), 5);
    trial.sample(contextReply(262432), 6);
    assert.equal(launches, 1);
    assert.equal(trial.status.launched, true);
    assert.equal(trial.status.armed, false);
});

test('a long gap resets the Home trial and launch failures remain disarmed', () => {
    const trial = new Trial((ok, error) => error({ message: 'denied' }));
    trial.arm();
    trial.sample(contextReply(262176), 1);
    trial.sample(contextReply(262432), 20000);
    trial.sample(contextReply(262432), 20001);
    assert.equal(trial.status.attempts, 0);
    trial.sample(contextReply(262176), 20002);
    trial.sample(contextReply(262432), 20003);
    trial.sample(contextReply(262432), 20004);
    assert.equal(trial.status.attempts, 1);
    assert.equal(trial.status.error, 'denied');
    assert.equal(trial.status.armed, false);
});
