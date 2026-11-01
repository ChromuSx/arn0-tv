/* NU7093 app-only profile. No native helpers or platform preference writes. */
(function () {
    'use strict';

    var profile = window.LAUNCHER_CONFIG.device || {};

    function supports(property, value) {
        try { return !!(window.CSS && CSS.supports && CSS.supports(property, value)); }
        catch (e) { return false; }
    }

    function report() {
        var firmware = null;
        try {
            if (window.webapis && webapis.productinfo) firmware = webapis.productinfo.getFirmware();
        } catch (e) { /* Optional Samsung extension; absence must not prevent startup. */ }
        return {
            targetModel: profile.model,
            expectedFirmware: profile.expectedFirmware,
            reportedFirmware: firmware,
            firmwareMatches: firmware ? firmware === profile.expectedFirmware : null,
            // The target model is configuration, not a detected/verified device identity.
            userAgent: navigator.userAgent,
            preview: !!window.__TIZEN_MOCK__,
            appList: !!(window.tizen && tizen.application && tizen.application.getAppsInfo),
            hdmiRead: !!(window.tizen && tizen.systeminfo && tizen.systeminfo.getPropertyValue),
            hdmiSwitch: !!(window.tizen && tizen.tvwindow && tizen.tvwindow.setSource),
            cssGrid: supports('display', 'grid'),
            legacyLayout: document.documentElement.classList.contains('legacy-layout'),
            manualLaunchOnly: profile.manualLaunchOnly === true
        };
    }

    function exit() {
        // Close this app through the public API. The physical Home key retains Samsung Home.
        // Do not assume the Q70B's internal Smart Hub app id exists on a 2018 TV.
        try { tizen.application.getCurrentApplication().exit(); }
        catch (e) { UI.toast('Premi Home sul telecomando per tornare alla TV Samsung.'); }
    }

    function init() {
        var root = document.documentElement;
        root.classList.toggle('legacy-layout', profile.legacyLayout === true || !supports('display', 'grid'));
        root.classList.toggle('reduced-motion', profile.reducedMotion === true);
        // Translate the main static headings only; the upstream settings remain in English.
        document.querySelector('#inputs-section h2').textContent = 'Ingressi HDMI';
        document.querySelector('#all h1').textContent = 'Tutte le app';
        document.querySelector('#settings h1').textContent = 'Impostazioni';
        document.querySelector('#consoles h1').textContent = 'Ingressi HDMI';
        document.title = 'Arn0 NU7093';
        DevLog.log('Profilo ' + profile.model + ': avvio manuale, Home Samsung invariata');
    }

    window.Device = { init: init, report: report, exit: exit };
})();
