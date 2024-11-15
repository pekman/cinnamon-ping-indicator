"use strict";

const Applet = imports.ui.applet;
const Gio = imports.gi.Gio;
const Mainloop = imports.mainloop;
const Settings = imports.ui.settings;


const SIGTERM = 15;  // as defined by POSIX

const SIGTERM_TIMEOUT = 5000;  // in ms
const SIGKILL_TIMEOUT = 5000;  // in ms


Gio._promisify(Gio.DataInputStream.prototype,
               "read_line_async", "read_line_finish_utf8");
Gio._promisify(Gio.DataInputStream.prototype, "close_async", "close_finish");
Gio._promisify(Gio.Subprocess.prototype, "wait_async", "wait_finish");


async function _wait_proc_with_timeout(proc, timeout) {
  const timeoutCancellable = new Gio.Cancellable();
  const timeoutId = Mainloop.timeout_add(timeout, () => {
    timeoutCancellable.cancel();
    return false;  // don't run again
  });
  try {
    return await proc.wait_async(timeoutCancellable);
  }
  finally {
    Mainloop.source_remove(timeoutId);
  }
}

/**
 * ping:
 * host (string): host to ping
 * interval (int): ping interval in seconds
 *
 * Async generator that yields ping times. Stop by calling return().
 */
async function* ping(host, interval) {
  const proc = Gio.Subprocess.new(
    ["ping", "-n", "-i", interval.toString(), host],
    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);

  const stdout = new Gio.DataInputStream({
    base_stream: proc.get_stdout_pipe(),
    close_base_stream: true,
  });

  const readCancellable = new Gio.Cancellable();
  try {
    for (;;) {
      const [line, ] = await stdout.read_line_async(0, readCancellable);
      if (line == null)  // stdout closed, ping exited on its own
        return;

      global.log(`line: ${line}`);
      const m = /\btime=(\d+(?:\.\d+))\s*ms\b/.exec(line);
      yield m ? m[1] : null;
    }
  }
  finally {
    readCancellable.cancel();
    await stdout.close_async(0, null);

    const pid = proc.get_identifier();
    let terminated = pid == null;

    if (terminated) {
      global.log("ping exited on its own");
      await proc.wait_async(null);
    }
    else {
      global.log(`Terminating ping with SIGTERM (pid=${pid})…`);
      proc.send_signal(SIGTERM);

      terminated = await _wait_proc_with_timeout(proc, SIGTERM_TIMEOUT);
      if (!terminated) {
        global.log(`ping (pid=${pid}) not terminated. Killing it…`);
        proc.force_exit();
        terminated = await _wait_proc_with_timeout(proc, SIGKILL_TIMEOUT);
      }

      if (terminated)
        global.log("ping subprocess terminated");
      else
        global.log("Error killing ping subprocess");
    }
  }
}


class PingIndicatorApplet extends Applet.TextApplet {
  constructor(uuid, orientation, panel_height, instance_id) {
    super(orientation, panel_height, instance_id);

    this._is_in_panel = false;
    this._ping = null;
    this._stoppedPromise = Promise.resolve();

    this.settings = new Settings.AppletSettings(this, uuid, instance_id);
    this.settings.bind("title", "title", this.on_settings_changed);
    this.settings.bind("host", "host", this.on_settings_changed);
    this.settings.bind("interval", "interval", this.on_settings_changed);

    this.set_applet_tooltip(this.host ?? "");
    this._set_ping_val(null);
  }

  _set_ping_val(val) {
    this.set_applet_label(
      (this.title ? `${this.title} ` : "") +
      (val != null ? `${val} ms` : "N/A"));
  }

  async _async_update() {
    try {
      for await (const val of this._ping)
        this._set_ping_val(val);
    }
    catch (err) {
      global.logError(err);
    }
    global.log("update loop stopped");
  }

  _start() {
    // idempotent function
    if (this._ping == null) {
      this._ping = ping(this.host, this.interval);
      this.updater = this._async_update();
    }
  }

  async _stop() {
    // idempotent function
    if (this._ping != null) {
      const ping = this._ping;
      this._ping = null;
      try {
        this._stoppedPromise = ping.return();
        await this._stoppedPromise;
      }
      catch (err) {
        global.logError(err);
        // TODO: Has the subprocess actually stopped or not? Maybe we should
        //       just let the whole applet crash.
      }
    }
    else {
      // If stop has already been called, wait until it finishes.
      // If already stopped or never started, this continues immediately.
      await this._stoppedPromise;
    }
  }

  on_applet_added_to_panel() {
    this._is_in_panel = true;
    this._start();
  }

  on_applet_removed_from_panel() {
    this._is_in_panel = false;
    this._stop();
  }

  async on_settings_changed() {
    this.set_applet_tooltip(this.host ?? "");

    if (this._is_in_panel) {
      if (this._ping != null) {
        global.log("Settings changed. Restarting ping subprocess.");
        await this._stop();
      }
      else {
        global.log("Settings changed. ping not running. Starting it.");
      }
      this._start();
    }
  }
}


function main(metadata, orientation, panel_height, instance_id) {
  return new PingIndicatorApplet(
    metadata.uuid, orientation, panel_height, instance_id);
}
