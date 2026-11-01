/* Node 4.4: measured NU7093 Home/SOURCE context transitions. */
'use strict';
function parseContext(reply) {
    if (!reply || reply.error || typeof reply.detail !== 'string') return null;
    var values = reply.detail.match(/^\s*int32\s+\d+\s*$/gm);
    if (!values || values.length !== 1) return null;
    var value = Number(values[0].replace(/^\s*int32\s+/, '').trim());
    return isFinite(value) && value >= 0 && value <= 2147483647 ? value : null;
}
function Monitor(launch) {
    this.launch = launch;
    this.state = { enabled: false, pausedUntil: 0, attempts: 0, lastError: null, hdmiProtected: false };
    this.reset();
    this.busy = false;
    this.cooldown = 0;
}
Monitor.prototype.reset = function () { this.clearSeen = false; this.streak = 0; this.last = 0; };
Monitor.prototype.enable = function (enabled) { this.state.enabled = enabled === true; this.state.hdmiProtected = false; this.reset(); };
Monitor.prototype.pause = function (at) { this.state.pausedUntil = at + 120000; this.state.hdmiProtected = false; this.reset(); };
Monitor.prototype.sample = function (reply, at) {
    if (!this.state.enabled || at < this.state.pausedUntil || this.busy) { this.reset(); return; }
    if (this.last && at <= this.last) return;
    var value = parseContext(reply);
    this.state.hdmiProtected = false;
    if (value === null) { this.reset(); this.state.lastError = 'Context unavailable'; return; }
    // Measured on the guarded NU7093 build: native HDMI Home=0x40103, tuner=0x40101.
    // A foreground web app has 0x20 (e.g. 0x40122 with HDMI underneath).
    // A CEC device can open the same Hub as the Samsung remote: preserve it on HDMI.
    this.state.hdmiProtected = !!(value & 2) && !(value & 32);
    if (this.state.hdmiProtected) { this.reset(); return; }
    if (this.last && at - this.last > 5000) this.reset();
    this.last = at;
    if (!(value & 256)) { this.clearSeen = true; this.streak = 0; return; }
    if (!this.clearSeen || ++this.streak < 2 || at < this.cooldown) return;
    this.reset();
    this.busy = true;
    this.cooldown = at + 5000;
    this.state.attempts++;
    var self = this;
    var completed = false;
    function done(error) {
        if (completed) return;
        completed = true;
        self.busy = false;
        self.reset();
        self.state.lastError = error ? String(error.message || error.name || error).slice(0, 160) : null;
    }
    try { this.launch(function () { done(null); }, done); } catch (error) { done(error); }
};
exports.Monitor = Monitor;
exports.parseContext = parseContext;
