# NU7093 Home signal probe

Experimental, separate application (`Arn0Probe1.Probe`) and Node 4.4 service
(`Arn0Probe1.Watch`). This is a diagnostic and explicitly armed one-shot return trial,
not an always-active replacement for the Home button.

It reads TV-local app status, `aul_test getallappstatus` and selected Home-related lines
from the fixed `vconftool get -r` prefixes `db/menu/eden`, `db/appfw`, `memory/menu` and
`memory/appfw` (the TV's usage output establishes this read-only syntax).
No settings setters, root, custom native helpers or input interception are used.
External commands are fixed, read-only and explicitly allowlisted;
caller data never reaches a command. Errors and unavailable permissions are reported as observations.
Preflight also reads the tool directory, requests `vconftool --help` and the system/session bus name lists,
and checks whether input event devices can be opened read-only, immediately closing them without
reading any key events or grabbing a device.
It also reads the application-context manager's introspection metadata and its two getters
(`app_ctxmgr_get_context` and `app_ctxmgr_list_visible`), without invoking any setters.

## One-shot return trial

Only an authenticated `POST /arm` enables the trial. After observing Home closed and two
subsequent valid Home-open readings, it asks the public application API to open the fixed
`Arn0Lnchr0.Launcher` ID once and disarms. Errors, unknown data and long gaps do not trigger it.
The user has accepted Home and SOURCE both returning to Arn0 if the original SOURCE menu cannot
be preserved. On this NU7093 both add the same `0x100` context bit; volume does not.
This is device-specific measured behavior, not a compatibility claim for other models.

To arm from the probe GUI's Web Inspector console, run:

```js
var r = new XMLHttpRequest();
r.open('POST', 'http://127.0.0.1:8131/arm?token=' + window.ARN0_PROBE_TOKEN);
r.send();
```

Leave the Samsung bar closed for at least two seconds, then press Home. The service
launches Arn0 at most once per arm; repeat the command for another trial. This requires
a temporary development/debug connection, not a permanent server. Do not publish the token.
If the generated token is missing or invalid, startup fails closed with a console marker;
no unauthenticated fallback server is opened.

On the tested NU7093, physical Home successfully returned to Arn0 from this probe,
terrestrial TV, another application, and Arn0 itself. This does not verify startup after reboot.

The HTTP listener binds only to `127.0.0.1:8131`, retains at most 100 in-memory samples and
automatically terminates after ten minutes. It does not start at boot or restart itself.
Requests require a random per-build token generated only inside the package; no token is tracked.
Back requests service shutdown and closes the UI. Uninstall the probe after testing.
Treat collected diagnostic output as private; do not commit device output.

Build from this directory with `python build.py`. Sign the resulting unsigned widget using
the existing Samsung TV profile before installing. Production Arn0 keeps its existing ID,
version and preferences.

Source of the older-runtime lead: [Vetro PR #75](https://github.com/andrearicci93/vetro/pull/75).
The reported working service on a NU7090 does not prove Home handling or NU7093 compatibility.
