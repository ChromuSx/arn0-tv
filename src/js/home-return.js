/* Public UI controls for the TV-local Home/SOURCE return service. */
(function () {
    'use strict';
    var state = null;
    function request(path) {
        return new Promise(function (resolve, reject) {
            if (window.__TIZEN_MOCK__ || !window.ARN0_HOME_TOKEN) { reject(new Error('Available on the TV only')); return; }
            var xhr = new XMLHttpRequest();
            xhr.open(path === '/status' ? 'GET' : 'POST', 'http://127.0.0.1:8133' + path + '?token=' + window.ARN0_HOME_TOKEN, true);
            xhr.timeout = 2000;
            xhr.onload = function () {
                if (xhr.status !== 200) { reject(new Error('Home service is unavailable')); return; }
                try { state = JSON.parse(xhr.responseText); resolve(state); } catch (error) { reject(error); }
            };
            xhr.onerror = xhr.ontimeout = function () { reject(new Error('Home service is unavailable')); };
            xhr.send();
        });
    }
    function init() {
        if (window.__TIZEN_MOCK__) return;
        try {
            tizen.application.launch('Arn0Lnchr0.HomeWatch', function () {}, function () { DevLog.log('Home service could not be started'); });
        } catch (error) { DevLog.log('Home service is unavailable'); }
        // An already-running service may not complete the launch callback on older TVs.
        var remaining = 8;
        function again() {
            if (--remaining > 0) setTimeout(check, 1000);
            else state = { ready: false, error: 'Home service is unavailable' };
        }
        function check() { refresh().then(function (value) { if (!value.ready && !value.error) again(); }, again); }
        setTimeout(check, 500);
    }
    function refresh() { return request('/status'); }
    function toggle() {
        return refresh().then(function (value) {
            if (!value.ready) throw new Error(value.error || 'Home service is starting');
            return request(value.monitor.enabled ? '/disable' : '/enable');
        });
    }
    function summary() {
        if (window.__TIZEN_MOCK__) return 'TV only';
        if (!state) return 'Checking…';
        if (!state.ready) return state.error || 'Starting…';
        if (!state.monitor.enabled) return 'Off';
        return Date.now() < state.monitor.pausedUntil ? 'Paused for Samsung Home' : 'On · Home + SOURCE';
    }
    window.HomeReturn = { init: init, refresh: refresh, toggle: toggle, summary: summary,
        pause: function () { return request('/pause'); } };
})();
