"use strict";

const Applet = imports.ui.applet;
const Gio = imports.gi.Gio;
const Mainloop = imports.mainloop;


const SIGTERM = 15;  // as defined by POSIX

const SIGTERM_TIMEOUT = 5000;  // in ms


Gio._promisify(Gio.DataInputStream.prototype,
               "read_line_async", "read_line_finish_utf8");
Gio._promisify(Gio.DataInputStream.prototype, "close_async", "close_finish");
Gio._promisify(Gio.Subprocess.prototype, "wait_async", "wait_finish");


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
      if (line == null) {
        global.log("ping exited on its own. This shouldn't happen.");
        return;
      }

      global.log(`line: ${line}`);
      const m = /\btime=(\d+(?:\.\d+))\s*ms\b/.exec(line);
      yield m ? m[1] : null;
    }
  }
  finally {
    readCancellable.cancel();
    await stdout.close_async(0, null);

    global.log(
      `Terminating ping with SIGTERM (pid=${proc.get_identifier()})...`);
    proc.send_signal(SIGTERM);

    const timeoutCancellable = new Gio.Cancellable();
    const timeoutId = Mainloop.timeout_add(SIGTERM_TIMEOUT, () => {
      timeoutCancellable.cancel();
      return false;  // don't run again
    });
    const terminated = await proc.wait_async(timeoutCancellable);
    Mainloop.source_remove(timeoutId);

    if (!terminated) {
      global.log(
        `ping (pid=${proc.get_identifier()}) not terminated. Killing it...`);
      proc.force_exit();
      if (! await proc.wait_async(new Gio.Cancellable())) {
        global.log("error killing ping subprocess");
        return;
      }
    }
    global.log("ping subprocess terminated");
  }
}


class PingIndicatorApplet extends Applet.TextApplet {
  constructor(...args) {
    super(...args);

    this.set_applet_label("N/A");

    this.ping = null;
  }

  async _async_update() {
    try {
      for await (const val of this.ping)
        this.set_applet_label(val != null ? `${val} ms` : "N/A");
    }
    catch (err) {
      global.logError(err);
    }
    global.log("update loop stopped");
  }

  on_applet_added_to_panel() {
    if (this.ping != null) {
      global.log(
        "Applet added to panel twice. This shouldn't happen. Cleaning up.");
      this.on_applet_removed_from_panel();
    }

    this.ping = ping("1.1.1.1", 5);
    this.updater = this._async_update();
  }

  on_applet_removed_from_panel() {
    if (this.ping != null) {
      // async function; let it run in the background
      this.ping.return().catch(global.logError);
      this.ping = null;
    }
  }
}


function main(metadata, orientation, panel_height, instance_id) {
  return new PingIndicatorApplet(orientation, panel_height, instance_id);
}
