/* ===========================================================================
   Start this machine, get a handle on it, stop it again.
   ---------------------------------------------------------------------------
   Two ways to run: against the source tree (the default, what you want while
   developing) or against a built portable exe in a throwaway directory, which is
   the only way to exercise the first-run path -- and the first run of a packaged
   build is where a whole boot failure hid until it shipped. See specs/boot.
   =========================================================================== */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, evaluate, targets, until, sleep } from './cdp.mjs';

export const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

/* Ports are per-run so two suites, or a suite and a hand-driven app, do not
   fight over one. */
let nextPort = 9600 + Math.floor(Math.random() * 200);

export function freePort() {
  return nextPort++;
}

/**
 * A port this machine will actually let Chromium bind.
 *
 * Windows keeps ranges of ports reserved for Hyper-V and WinNAT, and the
 * ranges move after a reboot. A port inside one fails with
 * "bind() returned an error: 嘗試存取通訊端被拒絕" in a stderr nobody reads
 * (stdio is ignored below), the DevTools server never starts, and the launch
 * times out sixty seconds later reporting that the renderer never appeared --
 * which reads as the application being broken. Two runs in a row did exactly
 * that, on 9591 and on whatever 9600+random landed on. So the port is tried
 * from here first; a failed bind moves on to the next one.
 */
export async function usablePort(start = freePort(), tries = 200) {
  // 200, because a reserved range is a hundred ports wide and the start may
  // sit at its bottom: 40 from 9621 were all inside 9573-9672.
  const net = await import('node:net');
  for (let port = start, i = 0; i < tries; port++, i++) {
    const ok = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  throw new Error(`從 ${start} 起 ${tries} 個埠都綁不到，看 netsh interface ipv4 show excludedportrange protocol=tcp`);
}

/**
 * Launch and wait until the renderer has finished booting.
 *
 * `ELECTRON_RUN_AS_NODE` is cleared first. Inherited from an IDE terminal it
 * makes `require('electron')` return a path string instead of the API, and the
 * app refuses to start with an error seventy lines from the cause.
 */
export async function launch({ exe = null, dataDir = null, port = null,
  args = [], waitForBoot = true, timeout = 60000, profile = null } = {}) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (dataDir) env.PORTABLE_EXECUTABLE_DIR = dataDir;
  // A requested port is still checked: the caller cannot know the reserved ranges.
  port = await usablePort(port || freePort());

  const bin = exe || path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  /* A profile of its own, so a run cannot inherit what the last one left.
     Without it the suite reads the developer's saved session -- and a restored
     document carrying a change from an earlier run made a spec pass or fail
     depending on what had been done to the machine by hand. Tests that depend
     on history are the thing this suite exists to catch. */
  const profileArgs = profile ? [`--user-data-dir=${profile}`] : [];
  const argv = exe
    ? ['--windowed', `--remote-debugging-port=${port}`, ...profileArgs, ...args]
    : ['.', '--windowed', `--remote-debugging-port=${port}`, ...profileArgs, ...args];

  const child = spawn(bin, argv, { cwd: ROOT, env, stdio: 'ignore', detached: false });
  let exited = null;
  child.on('exit', (code) => { exited = code; });

  // The port opens before the renderer is useful, so wait for the shell itself.
  const page = await until(async () => {
    if (exited !== null) throw new Error(`app 在啟動途中結束了（exit ${exited}）`);
    const list = await targets(port).catch(() => []);
    return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null;
  }, { timeout, what: 'renderer 視窗出現' });

  const cdp = await connect(page.webSocketDebuggerUrl);

  await until(() => evaluate(cdp, 'typeof (window.AIOS && window.AIOS.apps) === "object"'),
    { timeout, what: 'AIOS 載入' });

  if (waitForBoot) {
    /* Booted, not connected: a machine with no model still finishes booting and
       is still worth testing. `sandboxRoot` is the last thing the boot reply
       sets, so it is the honest signal that the sequence completed. */
    await until(() => evaluate(cdp, '!!(window.AIOS.state && window.AIOS.state.sandboxRoot)'),
      { timeout, what: '開機序列完成' });
  }

  return {
    cdp,
    port,
    pid: child.pid,
    dataDir,
    async close() {
      try { cdp.close(); } catch { /* already gone */ }
      /* The whole tree, not the process we spawned. A portable exe is an NSIS
         stub that unpacks the application and runs it as a child; killing the
         stub left the application running -- two of them were found hours
         later, holding app.asar in the fixed unpack directory, so the next
         build's stub could not overwrite it and the packaged suite tested the
         previous version's code while reporting on the new exe. */
      await killTree(child.pid);
      // Electron leaves helper processes for a moment; give them room so the
      // next launch does not inherit a half-released profile directory.
      await sleep(700);
    }
  };
}

/** Kill a process and everything it started. */
export async function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      k.on('exit', resolve);
      k.on('error', resolve);
    });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
}

/* The portable target unpacks into a fixed directory under TEMP
   (electron-builder.yml: unpackDirName), so a leftover from an earlier run --
   a process still holding the files, or the files themselves -- is what the
   next launch would run. A first run has to start from nothing. */
export const UNPACK_DIR_NAME = 'AI-OS';

export async function clearUnpackDir() {
  const dir = path.join(os.tmpdir(), UNPACK_DIR_NAME);
  if (process.platform === 'win32') {
    /* Anything running out of that directory, whoever started it. */
    const list = await new Promise((resolve) => {
      let out = '';
      const p = spawn('powershell', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${dir.replace(/'/g, "''")}\\*' } | ForEach-Object { $_.ProcessId }`],
      { stdio: ['ignore', 'pipe', 'ignore'] });
      p.stdout.on('data', (d) => { out += d; });
      p.on('exit', () => resolve(out));
      p.on('error', () => resolve(''));
    });
    for (const pid of list.split(/\s+/).filter(Boolean)) await killTree(Number(pid));
  }
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  return dir;
}

/**
 * The source tree, in a throwaway profile.
 *
 * The sandbox still points at the repository's own `sandbox/` -- that is what
 * `dataHome()` returns when not packaged, and there is no flag to move it -- so
 * specs clean up the files they write. Everything else (session, policy,
 * memory, installed apps, provider settings) is fresh.
 */
export async function launchClean(opts = {}) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'aios-e2e-profile-'));
  const app = await launch({ profile, ...opts });
  const close = app.close;
  app.close = async () => {
    await close();
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  };
  return app;
}

/** A packaged build in a directory of its own, for the first-run path. */
export async function launchPortable(exePath, opts = {}) {
  await clearUnpackDir();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aios-e2e-'));
  const exe = path.join(dir, 'AI-OS.exe');
  await fs.copyFile(exePath, exe);
  const app = await launch({ exe, dataDir: dir, ...opts });
  const close = app.close;
  app.close = async () => {
    await close();
    // The application the stub unpacked is not the stub's child once the stub
    // has handed over; reach it by where it runs from.
    await clearUnpackDir();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  return app;
}

/** The newest portable build, or null when nothing has been built. */
export async function newestPortable() {
  const dist = path.join(ROOT, 'dist');
  const names = await fs.readdir(dist).catch(() => []);
  const hits = names.filter((n) => /portable\.exe$/i.test(n));
  if (!hits.length) return null;
  const stats = await Promise.all(hits.map(async (n) => {
    const p = path.join(dist, n);
    return { p, mtime: (await fs.stat(p)).mtimeMs };
  }));
  stats.sort((a, b) => b.mtime - a.mtime);
  return stats[0].p;
}

/**
 * Source files changed since a build was made.
 *
 * Testing an artifact older than the source produces failures that look like
 * product faults and are not: a build from before a feature existed will fail
 * that feature's spec, and the message says the feature is broken rather than
 * that the exe is stale. Worth naming explicitly.
 */
export async function newerThanBuild(exePath) {
  const built = (await fs.stat(exePath)).mtimeMs;
  const out = [];
  async function walk(dir) {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if ((await fs.stat(p)).mtimeMs > built) out.push(path.relative(ROOT, p));
    }
  }
  await walk(path.join(ROOT, 'app'));
  return out;
}
