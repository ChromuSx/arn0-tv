/* NU7093-only, explicitly armed, one-shot foreground-return experiment. */
'use strict';
function parseContext(reply) {
    if (!reply || reply.error || typeof reply.detail !== 'string') return null;
    var values = reply.detail.match(/^\s*int32\s+\d+\s*$/gm);
    if (!values || values.length !== 1) return null;
    var value = Number(values[0].replace(/^\s*int32\s+/, '').trim());
    return isFinite(value) && value >= 0 && value <= 2147483647 ? value : null;
}
function Trial(launch) {
    this.launch = launch;
    this.status = { armed: false, attempts: 0, launched: false, error: null, context: null };
    this.clearSeen = false;
    this.streak = 0;
    this.last = 0;
}
Trial.prototype.arm = function () {
    this.status.armed = true;
    this.status.launched = false;
    this.status.error = null;
    this.clearSeen = false;
    this.streak = 0;
    this.last = 0;
};
Trial.prototype.sample = function (reply, at) {
    if (!this.status.armed || (this.last && at <= this.last)) return;
    var value = parseContext(reply);
    this.status.context = value;
    if (value === null) { this.clearSeen = false; this.streak = 0; return; }
    if (this.last && at - this.last > 10000) { this.clearSeen = false; this.streak = 0; }
    this.last = at;
    // Measured on this NU7093: Home and SOURCE both add 0x100. Volume does not.
    if (!(value & 256)) { this.clearSeen = true; this.streak = 0; return; }
    if (!this.clearSeen || ++this.streak < 2) return;
    this.status.armed = false;
    this.status.attempts++;
    var self = this;
    try {
        this.launch(function () { self.status.launched = true; }, function (error) {
            self.status.error = String(error && (error.message || error.name) || error).slice(0, 250);
        });
    } catch (error) { self.status.error = String(error.message || error).slice(0, 250); }
};
module.exports = { Trial: Trial, parseContext: parseContext };
