const { app, BrowserWindow, Menu, shell, ipcMain, screen, clipboard, dialog, desktopCapturer, Notification, Tray, globalShortcut, powerSaveBlocker, nativeImage, powerMonitor } = require("electron");
const { execFile, spawn } = require("child_process");
const netmod = require("net");
const https = require("https");
const path = require("path");
const fs = require("fs");
const os = require("os");
const dns = require("dns");
const stateFile = () => path.join(app.getPath("userData"), "relaunch-state.json");

const ICON = path.join(__dirname, process.platform === "win32" ? "icon.ico" : "icon.png");
const GAP = 12;          // space between the two panels
const CW = 320;          // console width
const MW = 730, MH = 620; // main panel default size

let main = null, con = null, conReady = false, restore = null;
let history = []; // console lines, kept so the console survives an in-place update

// Fingerprint of the files that can only change with a full restart.
function coreStamp() {
  try { return ["main.js", "preload.js"].map(f => fs.readFileSync(path.join(__dirname, f), "utf8")).join("\u0000"); }
  catch (e) { return null; }
}
const startStamp = coreStamp();

function pairStart() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: Math.round(wa.x + (wa.width - (MW + GAP + CW)) / 2), y: Math.round(wa.y + (wa.height - MH) / 2) };
}

// Keep the console glued to the right edge of the main panel, same height.
function sync() {
  if (!main || main.isDestroyed() || !con || con.isDestroyed()) return;
  const b = main.getBounds();
  const t = { x: b.x + b.width + GAP, y: b.y, width: CW, height: b.height };
  const c = con.getBounds();
  if (c.x !== t.x || c.y !== t.y || c.width !== t.width || c.height !== t.height) con.setBounds(t);
}

function createWindows() {
  const startHidden = (process.argv.includes("--startup") || settings.startTray) && settings.tray;
  const web = { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true };
  let start = pairStart(), size = { width: MW, height: MH }, showConsole = true;
  try {
    const st = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    fs.unlinkSync(stateFile());
    start = { x: st.bounds.x, y: st.bounds.y }; size = { width: st.bounds.width, height: st.bounds.height };
    showConsole = st.console !== false;
  } catch (e) {}
  main = new BrowserWindow({
    x: start.x, y: start.y, width: size.width, height: size.height, minWidth: 700, minHeight: 600,
    show: !startHidden, titleBarStyle: "hidden", maximizable: false, icon: ICON, backgroundColor: "#15191d", title: "Nightdeck Utility", webPreferences: web
  });
  con = new BrowserWindow({
    parent: main, x: start.x + size.width + GAP, y: start.y, width: CW, height: size.height,
    icon: ICON, frame: false, resizable: false, minimizable: false, maximizable: false, skipTaskbar: true, show: false,
    backgroundColor: "#15191d", title: "Nightdeck Utility Console", webPreferences: web
  });
  Menu.setApplicationMenu(null);
  applyWin();
  main.loadFile(path.join(__dirname, "index.html"));
  con.loadFile(path.join(__dirname, "console.html"));

  con.webContents.on("did-finish-load", () => {
    conReady = true;
    history.forEach(m => con.webContents.send("nd-log", m));
  });
  conWanted = showConsole;
  con.once("ready-to-show", () => { sync(); if (showConsole && !startHidden) { con.show(); main.focus(); } });
  main.on("close", e => { if (settings.tray && tray && !quitting) { e.preventDefault(); hideAll(); } });

  main.on("move", sync);
  main.on("resize", sync);
  main.on("restore", sync);
  // Dragging the console moves the main panel too, so they stay aligned.
  con.on("move", () => {
    if (!main || main.isDestroyed()) return;
    const c = con.getBounds(), b = main.getBounds();
    const x = c.x - GAP - b.width, y = c.y;
    if (b.x !== x || b.y !== y) main.setPosition(x, y);
  });
  main.on("closed", () => { main = null; con = null; });

  for (const w of [main, con])
    w.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
}

ipcMain.on("nd-window", (event, action) => {
  if (!main || main.isDestroyed()) return;
  if (action === "minimize") main.minimize();
  else if (action === "close") main.close();
  else if (action === "maximize") {
    // Fill the screen while leaving room for the console beside it.
    if (restore) { main.setBounds(restore); restore = null; }
    else {
      restore = main.getBounds();
      const wa = screen.getDisplayMatching(restore).workArea;
      const side = con && !con.isDestroyed() && con.isVisible() ? GAP + CW : 0;
      main.setBounds({ x: wa.x, y: wa.y, width: wa.width - side, height: wa.height });
    }
    sync();
  } else if (action === "toggleConsole") {
    if (!con || con.isDestroyed()) return;
    if (con.isVisible()) { con.hide(); conWanted = false; }
    else { conWanted = true; sync(); con.showInactive(); }
  } else if (action === "update") {
    // Normal case: reload both panels in place, the windows never close.
    if (coreStamp() === startStamp) {
      pushLog("updated - reloaded in place");
      conReady = false;
      main.webContents.reloadIgnoringCache();
      if (con && !con.isDestroyed()) con.webContents.reloadIgnoringCache();
      return;
    }
    // The app's core files changed: only a restart can load those.
    try { fs.writeFileSync(stateFile(), JSON.stringify({ bounds: main.getBounds(), console: con && !con.isDestroyed() && con.isVisible() })); } catch (e) {}
    app.relaunch();
    app.exit(0);
  } else if (action === "resetSize") {
    restore = null;
    const s = pairStart();
    main.setBounds({ x: s.x, y: s.y, width: MW, height: MH });
    sync();
  }
});

function pushLog(text) {
  const m = { t: new Date().toTimeString().slice(0, 8), text };
  history.push(m); if (history.length > 500) history.shift();
  if (conReady && con && !con.isDestroyed()) con.webContents.send("nd-log", m);
}

// ---- System monitor: CPU use is measured between two calls ----
let lastCpu = null;
function cpuPercent() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) { for (const k in c.times) total += c.times[k]; idle += c.times.idle; }
  let pct = 0;
  if (lastCpu && total > lastCpu.total) pct = (1 - (idle - lastCpu.idle) / (total - lastCpu.total)) * 100;
  lastCpu = { idle, total };
  return pct;
}
const WIN = process.platform === "win32";
function run(cmd, args, timeout = 8000) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout || ""), err: String(stderr || (err && err.message) || "") }));
  });
}

// ---- Running programs ----
const PROTECTED = new Set(["system", "idle", "registry", "smss", "csrss", "wininit", "winlogon", "services", "lsass", "lsaiso",
  "svchost", "dwm", "fontdrvhost", "memory compression", "secure system", "explorer", "sihost", "ctfmon", "audiodg", "spoolsv",
  "systemd", "init", "xorg", "xvfb"]);
const isProtected = n => { n = String(n).toLowerCase(); return PROTECTED.has(n) || n.startsWith("nightdeck") || n === "electron"; };
let prevProc = null;
// Program icons, read from the .exe once and then remembered ("" = no icon available).
const iconCache = new Map();
async function fileIcon(file) {
  if (iconCache.has(file)) return iconCache.get(file);
  let url = "";
  try { const img = await app.getFileIcon(file, { size: "small" }); if (img && !img.isEmpty()) url = img.toDataURL(); } catch (e) {}
  iconCache.set(file, url);
  return url;
}
async function listProcs() {
  let rows = [];
  if (WIN) {
    const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-Process | Select-Object Name,Id,CPU,WorkingSet64,Path,MainWindowTitle | ConvertTo-Json -Compress"], 20000);
    if (!r.out.trim()) throw new Error("could not read the program list");
    let data = JSON.parse(r.out); if (!Array.isArray(data)) data = [data];
    rows = data.map(p => ({ name: String(p.Name), cpu: Number(p.CPU) || 0, mem: Number(p.WorkingSet64) || 0, path: p.Path ? String(p.Path) : "", title: p.MainWindowTitle ? String(p.MainWindowTitle) : "" }));
  } else {
    const r = await run("ps", ["-eo", "comm=,cputimes=,rss="]);
    for (const line of r.out.split("\n")) {
      const m = /^(.*\S)\s+(\d+)\s+(\d+)\s*$/.exec(line);
      if (m) rows.push({ name: m[1].trim(), cpu: Number(m[2]), mem: Number(m[3]) * 1024 });
    }
  }
  const map = new Map();
  for (const p of rows) {
    const g = map.get(p.name) || { name: p.name, count: 0, cpuSec: 0, mem: 0 };
    g.count++; g.cpuSec += p.cpu; g.mem += p.mem; if (!g.path && p.path) g.path = p.path; if (!g.title && p.title) g.title = p.title; map.set(p.name, g);
  }
  const now = Date.now(), cores = os.cpus().length || 1, out = [];
  for (const g of map.values()) {
    let cpu = null;
    if (prevProc && prevProc.map.has(g.name) && now > prevProc.t)
      cpu = Math.max(0, g.cpuSec - prevProc.map.get(g.name)) / ((now - prevProc.t) / 1000) / cores * 100;
    out.push({ name: g.name, count: g.count, cpu, mem: g.mem, protected: isProtected(g.name), win: !!g.title, title: g.title || "", path: g.path || "" });
  }
  prevProc = { t: now, map: new Map([...map].map(([k, v]) => [k, v.cpuSec])) };
  procPaths = new Set(out.map(p => p.path).filter(Boolean));
  await Promise.all(out.map(async p => { const g = map.get(p.name); p.icon = g && g.path ? await fileIcon(g.path) : ""; }));
  return out;
}
// ---- Programs that start with Windows (the "Run" lists of this user and of the whole PC) ----
function psEnv(script, env, timeout) {
  return new Promise(resolve => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: timeout || 20000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: Object.assign({}, process.env, env || {}) },
      (err, out, serr) => resolve({ ok: !err, out: String(out || ""), err: String(serr || (err && err.message) || "") }));
  });
}
async function startupList() {
  if (!WIN) return { items: [], msg: "only available on Windows" };
  const ps = "$ErrorActionPreference='SilentlyContinue'; $out=@(); foreach($h in 'HKCU','HKLM'){" +
    " $k=$h+':\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; $a=$h+':\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';" +
    " $p=Get-ItemProperty -Path $k; $ap=Get-ItemProperty -Path $a; if($p){ foreach($x in $p.PSObject.Properties){ if($x.Name -like 'PS*'){continue};" +
    " $s=$null; if($ap){$s=$ap.($x.Name)}; $on=$true; if($s -and ($s[0] -band 1)){$on=$false};" +
    " $out+=[pscustomobject]@{name=$x.Name;cmd=[string]$x.Value;hive=$h;on=$on} } } }; ConvertTo-Json -Compress -InputObject @($out)";
  const r = await psEnv(ps, null, 20000);
  let items = []; try { items = [].concat(JSON.parse(r.out || "[]") || []).filter(x => x && x.name); } catch (e) { throw new Error("could not read the startup list"); }
  for (const it of items) {
    const m = /^\s*"([^"]+)"/.exec(it.cmd) || /^\s*(.+?\.exe)/i.exec(it.cmd);
    let file = m ? m[1].replace(/%([^%]+)%/g, (all, v) => process.env[v] || all) : "";
    it.icon = file && fs.existsSync(file) ? await fileIcon(file) : "";
    it.on = !!it.on;
  }
  return { items: items.sort((a, b) => a.name.localeCompare(b.name)) };
}
async function startupSet(hive, name, on) {
  if (!WIN) throw new Error("only available on Windows");
  if (hive !== "HKCU" && hive !== "HKLM") throw new Error("unexpected request");
  name = String(name); if (!name || name.length > 200) throw new Error("unexpected name");
  // Windows keeps the on/off state of a startup entry in "StartupApproved"; the entry itself is left alone
  const ps = "$ErrorActionPreference='Stop'; try { $a='" + hive + ":\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';" +
    " if(-not (Test-Path $a)){ New-Item -Path $a -Force | Out-Null };" +
    " $v=[byte[]](" + (on ? 2 : 3) + ",0,0,0,0,0,0,0,0,0,0,0); Set-ItemProperty -Path $a -Name $env:ND_NAME -Value $v -Type Binary; exit 0 } catch { exit 5 }";
  const r = await psEnv(ps, { ND_NAME: name }, 20000);
  return { ok: r.ok, msg: r.ok ? "" : (hive === "HKLM" ? "this entry is for all users - windows needs administrator rights to change it" : "windows did not accept the change") };
}
let procPaths = new Set();
function showFile(file) {
  file = String(file);
  if (!procPaths.has(file)) throw new Error("that program is no longer running");
  shell.showItemInFolder(file); return true;
}

async function killProc(name, force) {
  name = String(name);
  if (!/^[\w .+\-()]{1,80}$/.test(name)) throw new Error("unexpected program name");
  if (isProtected(name)) throw new Error("that is a system program");
  if (WIN) {
    const r = await run("taskkill.exe", (force ? ["/F"] : []).concat(["/IM", name + ".exe"]));
    return { ok: r.ok, msg: (r.out || r.err).trim().split(/\r?\n/)[0] || "" };
  }
  const r = await run("pkill", [force ? "-9" : "-15", "-x", name]);
  return { ok: r.ok, msg: r.ok ? "signal sent" : "not found" };
}

// ---- Network ----
function tcpTime(host, port = 443, timeout = 3000) {
  return new Promise(resolve => {
    const t = Date.now(), sock = netmod.connect({ host, port });
    const done = ok => { sock.destroy(); resolve(ok ? Date.now() - t : null); };
    sock.setTimeout(timeout, () => done(false));
    sock.on("connect", () => done(true));
    sock.on("error", () => done(false));
  });
}
function publicIp() {
  return new Promise(resolve => {
    const req = https.get("https://api.ipify.org", { timeout: 4000 }, res => {
      let d = ""; res.on("data", c => { d += c; });
      res.on("end", () => resolve(/^[\da-f.:]{3,45}$/i.test(d.trim()) ? d.trim() : null));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

// ---- Network extras: live traffic, connection details, speed test, quick fixes, devices ----
// Live traffic on Windows: one small helper reports the byte counters of the physical network
// adapter once a second. (netstat was used before; with virtual adapters such as Hyper-V it counts
// the same traffic several times and showed about four times the real speed.)
let netPs = null, netCur = null, netPrev = null, netIdle = null;
function netWatch() {
  clearTimeout(netIdle);
  netIdle = setTimeout(() => { if (netPs) { try { netPs.kill(); } catch (e) {} } }, 8000); // stops once the network tab is closed
  if (netPs) return;
  const ps = "$ErrorActionPreference='SilentlyContinue'; $i=0; while (Get-Process -Id " + process.pid + ") {" +
    " if ($i % 30 -eq 0) { $n=@(Get-NetAdapter -Physical | Where-Object {$_.Status -eq 'Up'} | ForEach-Object {$_.Name}) }; $i++;" +
    " [uint64]$rx=0; [uint64]$tx=0; if ($n.Count) { foreach ($s in @(Get-NetAdapterStatistics -Name $n)) { $rx+=$s.ReceivedBytes; $tx+=$s.SentBytes } };" +
    " [Console]::Out.WriteLine(\"$rx $tx\"); Start-Sleep -Milliseconds 1000 }";
  const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  netPs = p; let buf = "";
  p.stdout.on("data", d => {
    buf += d; let k;
    while ((k = buf.indexOf("\n")) >= 0) {
      const m = /^(\d+) (\d+)/.exec(buf.slice(0, k).trim()); buf = buf.slice(k + 1);
      if (m) { netPrev = netCur; netCur = { t: Date.now(), rx: Number(m[1]), tx: Number(m[2]) }; }
    }
  });
  const gone = () => { if (netPs === p) { netPs = null; netCur = netPrev = null; } };
  p.on("exit", gone); p.on("error", gone);
}
function netBytes() { // other systems: total bytes received / sent
  try {
    let rx = 0, tx = 0;
    for (const line of fs.readFileSync("/proc/net/dev", "utf8").split("\n").slice(2)) { const p = line.trim().split(/[:\s]+/); if (p.length > 9 && p[0] !== "lo") { rx += Number(p[1]); tx += Number(p[9]); } }
    return { rx, tx };
  } catch (e) { return null; }
}
let lastNet = null;
async function netRate() { // bytes per second
  if (WIN) {
    netWatch();
    const a = netPrev, b = netCur;
    if (!a || !b || Date.now() - b.t > 4000 || b.t <= a.t || b.rx < a.rx || b.tx < a.tx) return { down: null, up: null };
    const s = (b.t - a.t) / 1000;
    return { down: (b.rx - a.rx) / s, up: (b.tx - a.tx) / s };
  }
  const b = netBytes(), now = Date.now();
  let out = { down: null, up: null };
  if (b && lastNet && now > lastNet.t && now - lastNet.t < 15000 && b.rx >= lastNet.rx && b.tx >= lastNet.tx) {
    const s = (now - lastNet.t) / 1000; out = { down: (b.rx - lastNet.rx) / s, up: (b.tx - lastNet.tx) / s };
  }
  if (b) lastNet = { t: now, rx: b.rx, tx: b.tx };
  return out;
}
let lastGateway = "";
async function netDetails() {
  if (!WIN) return { adapters: [], msg: "only available on Windows" };
  const ps = "$ErrorActionPreference='SilentlyContinue';" +
    "$a=@(Get-NetAdapter -Physical | Where-Object {$_.Status -eq 'Up'} | Select-Object Name,InterfaceDescription,LinkSpeed,PhysicalMediaType,ifIndex);" +
    "$c=@(Get-NetIPConfiguration | Where-Object {$_.IPv4DefaultGateway} | ForEach-Object {[pscustomobject]@{ifIndex=$_.InterfaceIndex;gateway=(@($_.IPv4DefaultGateway | ForEach-Object {$_.NextHop}) -join ', ');dns=(@($_.DNSServer | Where-Object {$_.AddressFamily -eq 2} | ForEach-Object {$_.ServerAddresses}) -join ', ')}});" +
    "$w=(netsh wlan show interfaces | Out-String);" +
    "[pscustomobject]@{adapters=$a;config=$c;wlan=$w} | ConvertTo-Json -Compress -Depth 4";
  const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], 20000);
  let j; try { j = JSON.parse(r.out); } catch (e) { throw new Error("could not read the connection details"); }
  const conf = [].concat(j.config || []), wlan = String(j.wlan || "");
  const ssid = (/^\s*SSID\s*:\s*(.+?)\s*$/m.exec(wlan) || [])[1] || "", signal = (/^\s*Signal\s*:\s*(\d+)\s*%/m.exec(wlan) || [])[1];
  const adapters = [].concat(j.adapters || []).filter(Boolean).map(a => {
    const media = String(a.PhysicalMediaType || ""), wifi = /802\.11|wireless|wi-?fi/i.test(media + " " + a.Name);
    const c = conf.find(x => x && x.ifIndex === a.ifIndex) || {};
    return { name: String(a.Name || ""), device: String(a.InterfaceDescription || ""), kind: wifi ? "wi-fi" : /802\.3/.test(media) ? "cable (ethernet)" : (media || "unknown"),
      speed: String(a.LinkSpeed || ""), gateway: String(c.gateway || ""), dns: String(c.dns || ""), ssid: wifi ? ssid : "", signal: wifi && signal != null ? Number(signal) : null };
  });
  lastGateway = adapters.map(a => a.gateway).filter(Boolean).join(", ");
  return { adapters };
}
const SPEED_HOST = "https://speed.cloudflare.com";
function speedDown(limitMs, bytes) {
  return new Promise((resolve, reject) => {
    let got = 0, t0 = 0, done = false, timer = null, req = null;
    const finish = err => {
      if (done) return; done = true; clearTimeout(timer); if (req) req.destroy();
      const s = t0 ? (Date.now() - t0) / 1000 : 0;
      if (got < 100000 || s <= 0) reject(new Error(err || "no data received")); else resolve({ bps: got * 8 / s, bytes: got });
    };
    req = https.get(SPEED_HOST + "/__down?bytes=" + bytes, { timeout: 8000 }, res => {
      if (res.statusCode !== 200) { res.resume(); finish("the test server answered " + res.statusCode); return; }
      res.on("data", c => { if (!t0) t0 = Date.now(); else got += c.length; });
      res.on("end", () => finish()); res.on("error", e => finish(e.message));
    });
    req.on("error", e => finish(e.message)); req.on("timeout", () => finish("timed out"));
    timer = setTimeout(() => finish(), limitMs);
  });
}
function speedUp(limitMs, bytes) {
  return new Promise(resolve => {
    let done = false, t0 = 0, sent = 0, timer = null, base = 0;
    const chunk = Buffer.alloc(65536, 97);
    const req = https.request(SPEED_HOST + "/__up", { method: "POST", timeout: 8000, headers: { "Content-Type": "application/octet-stream", "Content-Length": bytes } }, res => { res.resume(); res.on("end", () => finish()); });
    const finish = () => {
      if (done) return; done = true; clearTimeout(timer);
      const s = t0 ? (Date.now() - t0) / 1000 : 0, n = req.socket ? req.socket.bytesWritten - base : 0;
      req.destroy(); resolve(n > 100000 && s > 0 ? { bps: n * 8 / s, bytes: n } : null);
    };
    const pump = () => {
      while (!done && sent < bytes) { const n = Math.min(chunk.length, bytes - sent); sent += n; if (!req.write(n === chunk.length ? chunk : chunk.subarray(0, n))) { req.once("drain", pump); return; } }
      if (!done) req.end();
    };
    req.on("socket", s => { const go = () => { if (t0) return; t0 = Date.now(); base = s.bytesWritten; pump(); }; if (s.connecting) s.once(s.encrypted ? "secureConnect" : "connect", go); else go(); });
    req.on("error", () => finish()); req.on("timeout", () => finish());
    timer = setTimeout(finish, limitMs + 4000);
  });
}
let speedBusy = false;
async function speedTest() {
  if (speedBusy) throw new Error("a speed test is already running");
  speedBusy = true;
  try {
    const down = await speedDown(8000, 50000000);
    const up = await speedUp(6000, 20000000);
    return { down: down.bps, up: up ? up.bps : null, bytes: down.bytes + (up ? up.bytes : 0) };
  } finally { speedBusy = false; }
}
async function netFix(kind) {
  if (!WIN) return { ok: false, msg: "only available on Windows" };
  if (kind === "flushdns") { const r = await run("ipconfig.exe", ["/flushdns"], 15000); return { ok: r.ok, msg: r.ok ? "" : (r.out || r.err).trim().slice(0, 200) }; }
  if (kind === "renew") {
    let r = await run("ipconfig.exe", ["/renew"], 60000);
    if (r.ok) return { ok: true, msg: "" };
    // Windows wants administrator rights for this: ask with its own permission prompt
    r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "try { $p = Start-Process ipconfig.exe -ArgumentList '/renew' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode } catch { exit 1223 }"], 90000);
    return { ok: r.ok, msg: r.ok ? "" : "not renewed - the windows permission was declined, or the adapter did not answer" };
  }
  return { ok: false, msg: "unknown request" };
}
function parseArp(text) {
  const seen = new Map(), gw = lastGateway.split(", ");
  for (const line of String(text).split(/\r?\n/)) {
    const ip = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(line), mac = /([0-9a-f]{2}(?:[-:][0-9a-f]{2}){5})/i.exec(line);
    if (!ip || !mac) continue;
    const m = mac[1].toLowerCase().replace(/-/g, ":"), first = Number(ip[1].split(".")[0]);
    if (m === "ff:ff:ff:ff:ff:ff" || m === "00:00:00:00:00:00" || m.startsWith("01:00:5e") || first >= 224 || /\.255$/.test(ip[1])) continue;
    if (!seen.has(ip[1])) seen.set(ip[1], { ip: ip[1], mac: m, name: "", note: gw.includes(ip[1]) ? "router" : "" });
  }
  return [...seen.values()].slice(0, 300);
}
const ip4num = ip => ip.split(".").reduce((a, b) => a * 256 + Number(b), 0) >>> 0;
const numip4 = n => [n >>> 24, n >>> 16 & 255, n >>> 8 & 255, n & 255].join(".");
function localNets() { // home-size networks this PC is on (254 addresses at most); prefers the one with the router
  const nets = [], ifs = os.networkInterfaces(), gw = lastGateway.split(", ").filter(Boolean);
  for (const name in ifs) for (const a of ifs[name]) {
    if (a.family !== "IPv4" || a.internal) continue;
    const mask = ip4num(a.netmask), ip = ip4num(a.address);
    if (mask < 0xFFFFFF00 || mask === 0xFFFFFFFF) continue;
    nets.push({ name, ip, mask, base: (ip & mask) >>> 0, address: a.address, mac: a.mac });
  }
  const withRouter = nets.filter(n => gw.some(g => ((ip4num(g) & n.mask) >>> 0) === n.base));
  return withRouter.length ? withRouter : nets;
}
function wakeNeighbours(nets) {
  return new Promise(resolve => {
    const socks = [];
    for (const n of nets) {
      const size = (~n.mask) >>> 0;
      for (let i = 1; i < size; i++) {
        const t = (n.base + i) >>> 0; if (t === n.ip) continue;
        try { const s = netmod.connect({ host: numip4(t), port: 80 }); s.on("error", () => {}); socks.push(s); } catch (e) {}
      }
    }
    setTimeout(() => { for (const s of socks) s.destroy(); resolve(); }, 2500);
  });
}
async function netDevices() {
  // 1. knock on every address of the home network, so Windows looks each device up
  // 2. read the list of devices Windows now knows
  const nets = localNets();
  if (nets.length) await wakeNeighbours(nets);
  const r = await run(WIN ? "arp.exe" : "arp", ["-a"], 8000);
  if (!r.out.trim() && !nets.length) throw new Error("could not read the device list");
  let list = parseArp(r.out);
  if (nets.length) list = list.filter(d => nets.some(n => ((ip4num(d.ip) & n.mask) >>> 0) === n.base));
  await Promise.all(list.map(async d => {
    try { const n = await Promise.race([dns.promises.reverse(d.ip), new Promise(res => setTimeout(() => res(null), 1500))]); if (n && n[0]) d.name = String(n[0]); } catch (e) {}
  }));
  for (const n of nets) if (!list.some(d => d.ip === n.address)) list.push({ ip: n.address, mac: String(n.mac || "").toLowerCase(), name: os.hostname(), note: "this pc" });
  return list.sort((a, b) => ip4num(a.ip) - ip4num(b.ip));
}

// ---- Clipboard history ----
// Kept in memory. Written to disk only for pinned text, and for the whole text history when
// "keep after restart" is switched on. Pictures are never written to disk.
const clipFile = () => path.join(app.getPath("userData"), "clipboard.json");
let clips = [], lastClip = null, lastImg = "", clipSeq = 1, clipTick = 0, clipSaveT = null;
let clipCfg = { max: 25, keep: false, paused: false };
function clipLoad() {
  try {
    const j = JSON.parse(fs.readFileSync(clipFile(), "utf8"));
    if (j.cfg) clipCfg = { max: [25, 50, 100].includes(j.cfg.max) ? j.cfg.max : 25, keep: !!j.cfg.keep, paused: false };
    for (const c of [].concat(j.items || [])) if (c && typeof c.text === "string" && c.text)
      clips.push({ id: clipSeq++, kind: "text", text: c.text.slice(0, 20000), time: Number(c.time) || Date.now(), pinned: !!c.pinned });
  } catch (e) {}
}
function clipSave() {
  clearTimeout(clipSaveT);
  clipSaveT = setTimeout(() => {
    try {
      const items = clips.filter(c => c.kind === "text" && (c.pinned || clipCfg.keep)).map(c => ({ text: c.text, time: c.time, pinned: c.pinned }));
      fs.writeFileSync(clipFile(), JSON.stringify({ cfg: { max: clipCfg.max, keep: clipCfg.keep }, items }));
    } catch (e) {}
  }, 500);
}
function clipTrim() { // pinned entries do not count against the limit; at most 10 pictures are kept
  let n = 0, imgs = 0;
  clips = clips.filter(c => { if (c.pinned) return true; if (c.kind === "image" && ++imgs > 10) return false; return ++n <= clipCfg.max; });
}
function clipImgSig(img) {
  try { const s = img.getSize(); return s.width + "x" + s.height + ":" + require("crypto").createHash("md5").update(img.resize({ width: 24 }).toBitmap()).digest("hex"); } catch (e) { return ""; }
}
function clipReadImg() {
  try { if (!clipboard.availableFormats().some(f => /^image\//i.test(f))) return null; const img = clipboard.readImage(); return img.isEmpty() ? null : img; } catch (e) { return null; }
}
function clipAddText(t) {
  const old = clips.find(c => c.kind === "text" && c.text === t);
  clips = clips.filter(c => c !== old);
  clips.unshift({ id: clipSeq++, kind: "text", text: t.slice(0, 20000), time: Date.now(), pinned: !!(old && old.pinned) });
  clipTrim(); clipSave();
}
function pollClipboard() {
  let t = ""; try { t = clipboard.readText(); } catch (e) { return; }
  if (lastClip === null) { // ignore what was already there at launch
    lastClip = t; const img = t ? null : clipReadImg(); lastImg = img ? clipImgSig(img) : ""; return;
  }
  if (!t && ++clipTick % 3 === 0) { // pictures are bigger to read, so they are looked at every third second
    const img = clipReadImg(), sig = img ? clipImgSig(img) : "";
    if (sig && sig !== lastImg && !clipCfg.paused) {
      const s = img.getSize();
      clips = clips.filter(c => c.sig !== sig);
      clips.unshift({ id: clipSeq++, kind: "image", text: "", img, sig, thumb: img.resize({ height: 44 }).toDataURL(), w: s.width, h: s.height, time: Date.now(), pinned: false });
      clipTrim();
    }
    lastImg = sig;
  }
  if (!t || t === lastClip) { if (!t) lastClip = ""; return; }
  lastClip = t;
  if (!clipCfg.paused) clipAddText(t);
}

// ---- Screenshot and screen recording ----
const capCfgFile = () => path.join(app.getPath("userData"), "capture.json");
let capCfg = { dir: "", format: "png", copy: false, hotkey: false, accel: "Control+Alt+P", screen: "" }, capKeyOn = "";
function capLoad() {
  try {
    const j = JSON.parse(fs.readFileSync(capCfgFile(), "utf8"));
    capCfg = { dir: typeof j.dir === "string" ? j.dir : "", format: j.format === "jpg" ? "jpg" : "png", copy: !!j.copy, hotkey: !!j.hotkey,
      accel: typeof j.accel === "string" && LACCEL.test(j.accel) ? j.accel : "Control+Alt+P", screen: String(j.screen || "") };
  } catch (e) {}
}
const shotsDir = () => (capCfg.dir && fs.existsSync(capCfg.dir)) ? capCfg.dir : path.join(app.getPath("pictures"), "Nightdeck Screenshots");
const capStamp = () => { const n = new Date(), p = x => String(x).padStart(2, "0"); return n.getFullYear() + p(n.getMonth() + 1) + p(n.getDate()) + "-" + p(n.getHours()) + p(n.getMinutes()) + p(n.getSeconds()); };
function capWrite(img, copy) { // saves a picture in the chosen format, and puts it on the clipboard when asked
  fs.mkdirSync(shotsDir(), { recursive: true });
  let file = path.join(shotsDir(), "shot-" + capStamp() + "." + capCfg.format), n = 1;
  while (fs.existsSync(file)) file = path.join(shotsDir(), "shot-" + capStamp() + "-" + (++n) + "." + capCfg.format);
  fs.writeFileSync(file, capCfg.format === "jpg" ? img.toJPEG(92) : img.toPNG());
  if (copy) { try { clipboard.writeImage(img); } catch (e) {} }
  const s = img.getSize();
  return { file, width: s.width, height: s.height, copied: !!copy };
}
async function capHide(hide, fn) { // runs fn with the Nightdeck windows out of the picture
  const mainVis = main && !main.isDestroyed() && main.isVisible(), conVis = con && !con.isDestroyed() && con.isVisible();
  if (hide && mainVis) { if (conVis) con.hide(); main.hide(); await new Promise(r => setTimeout(r, 400)); }
  try { return await fn(); }
  finally { if (hide && mainVis && main && !main.isDestroyed()) { main.show(); if (conVis && con && !con.isDestroyed()) { sync(); con.showInactive(); } } }
}
async function capScreens() { // one picture per screen, in real pixels
  const ds = screen.getAllDisplays(), prim = screen.getPrimaryDisplay().id;
  const phys = d => ({ width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) });
  const max = ds.reduce((m, d) => ({ width: Math.max(m.width, phys(d).width), height: Math.max(m.height, phys(d).height) }), { width: 1, height: 1 });
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: max });
  return ds.map(d => {
    const src = sources.find(x => String(x.display_id) === String(d.id)) || (ds.length === 1 ? sources[0] : null);
    if (!src || src.thumbnail.isEmpty()) return null;
    const p = phys(d); let img = src.thumbnail; const s = img.getSize();
    if (s.width !== p.width || s.height !== p.height) img = img.resize({ width: p.width, height: p.height });
    return { id: String(d.id), img, x: Math.round(d.bounds.x * d.scaleFactor), y: Math.round(d.bounds.y * d.scaleFactor), w: p.width, h: p.height, primary: d.id === prim };
  }).filter(Boolean);
}
async function capWindow(sid) {
  const srcs = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 3840, height: 2160 } });
  const s = srcs.find(x => x.id === sid);
  if (!s || s.thumbnail.isEmpty()) throw new Error("that window could not be captured - it may be closed or minimised");
  return s.thumbnail;
}
async function capOne(o) {
  if (o.kind === "window") return capWindow(String(o.id));
  const all = await capScreens(), s = all.find(x => x.id === String(o.id)) || all.find(x => x.primary) || all[0];
  if (!s) throw new Error("the screen could not be captured");
  return s.img;
}
// straight to a file: one screen or one window
function capShot(o) { o = o || {}; return capHide(!!o.hide, async () => capWrite(await capOne(o), o.copy == null ? capCfg.copy : !!o.copy)); }
// pictures handed to the window, for "all screens", cutting out a region and drawing on a capture
function capGrab(o) {
  o = o || {};
  return capHide(!!o.hide, async () => {
    if (o.kind !== "all") { const img = await capOne(o), z = img.getSize(); return { images: [{ url: img.toDataURL(), x: 0, y: 0, w: z.width, h: z.height }] }; }
    const all = await capScreens(); if (!all.length) throw new Error("the screens could not be captured");
    return { images: all.map(s => ({ url: s.img.toDataURL(), x: s.x, y: s.y, w: s.w, h: s.h })) };
  });
}
function capSave(url, copy) {
  const img = nativeImage.createFromDataURL(String(url));
  if (img.isEmpty()) throw new Error("the picture could not be saved");
  return capWrite(img, copy == null ? capCfg.copy : !!copy);
}
async function capSources(withWindows) {
  const ds = screen.getAllDisplays(), prim = screen.getPrimaryDisplay().id;
  const scr = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } });
  const out = { windows: [], screens: ds.map((d, i) => {
    const s = scr.find(x => String(x.display_id) === String(d.id)) || scr[i];
    return { id: String(d.id), sid: s ? s.id : "", label: "screen " + (i + 1) + (d.id === prim ? " (main)" : "") + "   " + Math.round(d.size.width * d.scaleFactor) + " x " + Math.round(d.size.height * d.scaleFactor) };
  }) };
  if (withWindows) {
    const win = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 240, height: 150 } });
    out.windows = win.filter(w => w.name && !/^Nightdeck Utility/.test(w.name) && !w.thumbnail.isEmpty()).slice(0, 24)
      .map(w => ({ sid: w.id, name: String(w.name).slice(0, 80), thumb: w.thumbnail.toDataURL() }));
  }
  return out;
}
const capThumbs = new Map();
function capList() { // the newest captures with small previews
  let files = [];
  try {
    files = fs.readdirSync(shotsDir()).filter(f => /\.(png|jpe?g|webm)$/i.test(f)).map(f => { const p = path.join(shotsDir(), f), st = fs.statSync(p); return { file: p, name: f, time: st.mtimeMs, size: st.size }; });
  } catch (e) {}
  files.sort((a, b) => b.time - a.time); files = files.slice(0, 12);
  for (const f of files) {
    f.video = /\.webm$/i.test(f.name); f.thumb = "";
    if (f.video) continue;
    const key = f.file + "|" + f.time;
    if (!capThumbs.has(key)) {
      let t = ""; try { const im = nativeImage.createFromPath(f.file); if (!im.isEmpty()) t = im.resize({ height: 64 }).toDataURL(); } catch (e) {}
      capThumbs.set(key, t); if (capThumbs.size > 60) capThumbs.delete(capThumbs.keys().next().value);
    }
    f.thumb = capThumbs.get(key);
  }
  return { dir: shotsDir(), files };
}
async function capDo(action, file) { // open, show in folder, copy or delete one capture; only files in the capture folder are touched
  file = path.resolve(String(file));
  if (path.dirname(file).toLowerCase() !== path.resolve(shotsDir()).toLowerCase() || !/\.(png|jpe?g|webm)$/i.test(file) || !fs.existsSync(file))
    throw new Error("that file is not in the capture folder any more");
  if (action === "open") { const e = await shell.openPath(file); if (e) throw new Error(e); }
  else if (action === "show") shell.showItemInFolder(file);
  else if (action === "copy") { const im = nativeImage.createFromPath(file); if (im.isEmpty()) throw new Error("only pictures can be copied"); clipboard.writeImage(im); }
  else if (action === "delete") await shell.trashItem(file); // goes to the recycle bin
  else throw new Error("unexpected request");
  return true;
}
function registerCapKey() {
  if (capKeyOn) { try { globalShortcut.unregister(capKeyOn); } catch (e) {} capKeyOn = ""; }
  if (!capCfg.hotkey || !LACCEL.test(capCfg.accel)) return false;
  try {
    if (!globalShortcut.isRegistered(capCfg.accel) && globalShortcut.register(capCfg.accel, () => {
      capShot({ kind: "screen", id: capCfg.screen, hide: false }).then(r => {
        try { new Notification({ title: "Nightdeck", body: "Screenshot saved: " + path.basename(r.file) }).show(); } catch (e) {}
      }).catch(() => {});
    })) { capKeyOn = capCfg.accel; return true; }
  } catch (e) {}
  return false;
}
async function capSet(o) { // changes the capture settings; called with nothing it just reports them
  o = o || {};
  if (o.pickDir) {
    const r = await dialog.showOpenDialog(main, { properties: ["openDirectory", "createDirectory"], defaultPath: shotsDir() });
    if (!r.canceled && r.filePaths[0]) capCfg.dir = r.filePaths[0];
  }
  if (o.resetDir) capCfg.dir = "";
  if (o.format === "png" || o.format === "jpg") capCfg.format = o.format;
  if (typeof o.copy === "boolean") capCfg.copy = o.copy;
  if (typeof o.screen === "string") capCfg.screen = o.screen;
  if (typeof o.accel === "string") { if (!LACCEL.test(o.accel)) throw new Error("a hotkey must look like Control+Alt+P"); capCfg.accel = o.accel; }
  if (typeof o.hotkey === "boolean") capCfg.hotkey = o.hotkey;
  try { fs.writeFileSync(capCfgFile(), JSON.stringify(capCfg)); } catch (e) {}
  const ok = registerCapKey();
  return Object.assign({}, capCfg, { dirShown: shotsDir(), hotkeyOk: ok });
}
// screen recording: the window records, the video arrives here in pieces and is written straight to the file
let recStream = null, recPath = "";
function recStart() {
  if (recStream) throw new Error("a recording is already running");
  fs.mkdirSync(shotsDir(), { recursive: true });
  recPath = path.join(shotsDir(), "recording-" + capStamp() + ".webm"); recStream = fs.createWriteStream(recPath); return recPath;
}
function recChunk(buf) { if (!recStream) return false; recStream.write(Buffer.from(buf)); return true; }
function recStop() {
  return new Promise(resolve => {
    if (!recStream) return resolve(null);
    const s = recStream, p = recPath; recStream = null;
    s.end(() => { let size = 0; try { size = fs.statSync(p).size; } catch (e) {} resolve({ file: p, size }); });
  });
}

// ---- Temperatures (best effort: Windows only exposes these on some PCs) ----
let tempCache = { t: 0, val: { system: null, gpu: null, gpuName: "" } }, tempBusy = false;
async function readTemps() {
  if (tempBusy || Date.now() - tempCache.t < 4000) return tempCache.val;
  tempBusy = true;
  const val = { system: null, gpu: null, gpuName: "" };
  try {
    const sane = c => isFinite(c) && c > 0 && c < 125;
    // nvidia-smi ships with the NVIDIA driver; look in the usual places, not just the PATH
    const smiPaths = ["nvidia-smi"];
    if (WIN) {
      const root = process.env.SystemRoot || "C:\\Windows", pf = process.env.ProgramFiles || "C:\\Program Files";
      smiPaths.push(path.join(root, "System32", "nvidia-smi.exe"), path.join(root, "Sysnative", "nvidia-smi.exe"),
        path.join(pf, "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe"));
      // newer drivers keep it only inside the Windows driver store
      try {
        const repo = path.join(root, "System32", "DriverStore", "FileRepository");
        for (const d of fs.readdirSync(repo)) {
          if (!/^nv/i.test(d)) continue;
          const exe = path.join(repo, d, "nvidia-smi.exe");
          if (fs.existsSync(exe)) smiPaths.push(exe);
        }
      } catch (e) {}
    }
    const smi = (async () => {
      let last = { ok: false, out: "", err: "nvidia-smi not found" };
      for (const exe of smiPaths) {
        last = await run(exe, ["--query-gpu=temperature.gpu,utilization.gpu,memory.used,memory.total,name", "--format=csv,noheader,nounits"], 10000);
        if (last.ok) { smiExe = exe; break; }
      }
      return last;
    })();
    const jobs = [smi];
    if (WIN) jobs.push(run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_PerfFormattedData_Counters_ThermalZoneInformation -ErrorAction SilentlyContinue | " +
      "Select-Object Name,HighPrecisionTemperature,Temperature | ConvertTo-Json -Compress"], 15000));
    const [gpu, zone] = await Promise.all(jobs);
    if (gpu.ok) {
      // the reading can be whole ("49") or decimal ("49.47" / "49,47")
      // temperature, usage %, memory used MiB, memory total MiB, name (a value can be "[N/A]")
      const m = /^\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*(.+?)\s*$/m.exec(gpu.out);
      const num = t => { const n = Number(String(t).trim()); return isFinite(n) && /\d/.test(t) ? n : null; };
      const deg = m ? num(m[1]) : null;
      if (m) {
        val.gpuName = m[5].trim();
        const use = num(m[2]), used = num(m[3]), total = num(m[4]);
        if (use != null && use >= 0 && use <= 100) val.gpuUse = use;
        if (used != null && total) { val.vramUsed = used; val.vramTotal = total; }
      }
      if (m && deg != null && sane(deg)) val.gpu = deg;
      else val.gpuError = "unexpected reply: " + gpu.out.trim().slice(0, 80);
    } else val.gpuError = (gpu.err || "nvidia-smi failed").trim().split(/\r?\n/)[0].slice(0, 120);
    if (zone && zone.out.trim()) {
      let d = JSON.parse(zone.out); if (!Array.isArray(d)) d = [d];
      const temps = d.map(z => z.HighPrecisionTemperature ? z.HighPrecisionTemperature / 10 - 273.15 : Number(z.Temperature) - 273.15).filter(sane);
      if (temps.length) val.system = Math.max(...temps);
    }
    if (!WIN) { // Linux, used for testing
      try {
        const dir = "/sys/class/thermal";
        const temps = fs.readdirSync(dir).filter(n => n.startsWith("thermal_zone"))
          .map(n => Number(fs.readFileSync(path.join(dir, n, "temp"), "utf8")) / 1000).filter(sane);
        if (temps.length) val.system = Math.max(...temps);
      } catch (e) {}
    }
  } catch (e) {}
  tempCache = { t: Date.now(), val }; tempBusy = false;
  return val;
}

// ---- Currency rates (fetched on demand, kept for 6 hours) ----
function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 7000, headers: { "User-Agent": "Nightdeck-Utility" } }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error("HTTP " + res.statusCode)); return; }
      let d = ""; res.setEncoding("utf8");
      res.on("data", c => { d += c; if (d.length > 2000000) req.destroy(new Error("reply too large")); });
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}
let rateCache = null;
async function currencyRates() {
  if (rateCache && Date.now() - rateCache.t < 6 * 3600 * 1000) return rateCache.val;
  const clean = r => { const o = {}; for (const k in r) if (/^[A-Z]{3}$/.test(k) && isFinite(r[k]) && r[k] > 0) o[k] = Number(r[k]); return o; };
  let val = null;
  try {
    const j = await getJson("https://open.er-api.com/v6/latest/EUR");
    if (j && j.result === "success" && j.rates) val = { rates: clean(j.rates), updated: String(j.time_last_update_utc || "").replace(/ \d\d:\d\d:\d\d.*$/, ""), source: "open.er-api.com" };
  } catch (e) {}
  if (!val) {
    const j = await getJson("https://api.frankfurter.dev/v1/latest?from=EUR");
    if (j && j.rates) val = { rates: Object.assign({ EUR: 1 }, clean(j.rates)), updated: String(j.date || ""), source: "frankfurter.dev" };
  }
  if (!val || !Object.keys(val.rates).length) throw new Error("rates not available");
  rateCache = { t: Date.now(), val };
  return val;
}

// ---- Windows controls: volume, brightness, Windows switches, cleanup ----
function ps(script, timeout = 20000) {
  const enc = Buffer.from("$ProgressPreference='SilentlyContinue';" + script, "utf16le").toString("base64");
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc], timeout);
}
const AUDIO_CS = `Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float fLevel, System.Guid pguidEventContext);
  int j();
  int GetMasterVolumeLevelScalar(out float pfLevel);
  int k(); int l(); int m(); int n();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, System.Guid pguidEventContext);
  int GetMute(out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref System.Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public class NdAudio {
  static IAudioEndpointVolume Vol() {
    var en = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
    IMMDevice dev = null; Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 1, out dev));
    IAudioEndpointVolume epv = null; var id = typeof(IAudioEndpointVolume).GUID;
    Marshal.ThrowExceptionForHR(dev.Activate(ref id, 23, 0, out epv)); return epv;
  }
  public static float Volume {
    get { float v = -1; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v)); return v; }
    set { Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(value, System.Guid.Empty)); } }
  public static bool Mute {
    get { bool m; Marshal.ThrowExceptionForHR(Vol().GetMute(out m)); return m; }
    set { Marshal.ThrowExceptionForHR(Vol().SetMute(value, System.Guid.Empty)); } }
}
'@
`;
const MON_CS = `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class NdMon {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct PM { public IntPtr h; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string d; }
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
  [DllImport("dxva2.dll")] static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr hMon, out uint n);
  [DllImport("dxva2.dll")] static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr hMon, uint n, [Out] PM[] arr);
  [DllImport("dxva2.dll")] static extern bool GetMonitorBrightness(IntPtr h, out uint min, out uint cur, out uint max);
  [DllImport("dxva2.dll")] static extern bool SetMonitorBrightness(IntPtr h, uint v);
  [DllImport("dxva2.dll")] static extern bool DestroyPhysicalMonitors(uint n, PM[] arr);
  public static int Run(int set) {
    IntPtr hm = MonitorFromWindow(GetDesktopWindow(), 1); uint n;
    if (!GetNumberOfPhysicalMonitorsFromHMONITOR(hm, out n) || n == 0) return -1;
    var arr = new PM[n]; if (!GetPhysicalMonitorsFromHMONITOR(hm, n, arr)) return -1;
    int res = -1;
    try {
      uint mn, cur, mx;
      if (GetMonitorBrightness(arr[0].h, out mn, out cur, out mx) && mx > mn) {
        if (set >= 0) { uint v = (uint)(mn + (mx - mn) * set / 100); if (SetMonitorBrightness(arr[0].h, v)) res = set; }
        else res = (int)((cur - mn) * 100 / (mx - mn));
      }
    } finally { DestroyPhysicalMonitors(n, arr); }
    return res;
  }
}
'@
`;
const pct = v => Math.max(0, Math.min(100, Math.round(Number(v))));
async function volume(set, mute) {
  if (!WIN) return { ok: false, msg: "only available on Windows" };
  let s = AUDIO_CS;
  if (set != null && isFinite(set)) s += "[NdAudio]::Volume = " + (pct(set) / 100).toFixed(2) + ";";
  if (mute === true || mute === false) s += "[NdAudio]::Mute = $" + mute + ";";
  s += "[string][math]::Round([NdAudio]::Volume * 100) + ';' + [NdAudio]::Mute";
  const r = await ps(s), m = /(\d+);(True|False)/i.exec(r.out);
  return m ? { ok: true, level: Number(m[1]), mute: /true/i.test(m[2]) } : { ok: false, msg: "the sound device could not be read" };
}
async function brightness(set) {
  if (!WIN) return { ok: false, msg: "only available on Windows" };
  const v = set != null && isFinite(set) ? pct(set) : -1;
  const s = "$set = " + v + ";" +
    "$b = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction SilentlyContinue | Select-Object -First 1;" +
    "if ($b) { if ($set -ge 0) { Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods | Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{Timeout=[uint32]1;Brightness=[byte]$set} | Out-Null; 'nd:' + $set } else { 'nd:' + $b.CurrentBrightness } }" +
    " else {\n" + MON_CS + "\n'nd:' + [NdMon]::Run($set) }";
  const r = await ps(s), m = /nd:(-?\d+)/.exec(r.out);
  return m && Number(m[1]) >= 0 ? { ok: true, level: Number(m[1]) } : { ok: false, msg: "this screen does not allow brightness control from Windows" };
}
const HKCU = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\";
const SWITCHES = {
  appsDark: { key: HKCU + "Themes\\Personalize", name: "AppsUseLightTheme", on: 0, off: 1 },
  sysDark: { key: HKCU + "Themes\\Personalize", name: "SystemUsesLightTheme", on: 0, off: 1 },
  showExt: { key: HKCU + "Explorer\\Advanced", name: "HideFileExt", on: 0, off: 1 },
  showHidden: { key: HKCU + "Explorer\\Advanced", name: "Hidden", on: 1, off: 2 },
  transparency: { key: HKCU + "Themes\\Personalize", name: "EnableTransparency", on: 1, off: 0, dflt: true },
  toasts: { key: HKCU + "PushNotifications", name: "ToastEnabled", on: 1, off: 0, dflt: true }
};
async function iconsShown() {
  const r = await run("reg.exe", ["query", HKCU + "Explorer\\Advanced", "/v", "HideIcons"]), m = /REG_DWORD\s+0x([0-9a-f]+)/i.exec(r.out);
  return !(m && parseInt(m[1], 16) === 1);
}
async function switchesGet() {
  if (!WIN) return { ok: false, msg: "only available on Windows" };
  const out = { ok: true };
  for (const id in SWITCHES) {
    const sw = SWITCHES[id], r = await run("reg.exe", ["query", sw.key, "/v", sw.name]);
    const m = /REG_DWORD\s+0x([0-9a-f]+)/i.exec(r.out);
    out[id] = m ? parseInt(m[1], 16) === sw.on : !!sw.dflt;
  }
  out.icons = await iconsShown();
  const a = await psCtl("'nd:' + [NdC.Ctl]::AutoHide(-1)"), m = /nd:(\d)/.exec(a.out); out.autoHide = !!(m && m[1] === "1");
  return out;
}
async function switchSet(id, on) {
  if (!WIN) return { ok: false, msg: "only available on Windows" };
  if (id === "icons") {
    if ((await iconsShown()) !== !!on) { const r = await psCtl("'nd:' + [NdC.Ctl]::ToggleIcons()"); if (!/nd:True/i.test(r.out)) return { ok: false, msg: "the desktop did not answer" }; }
    return { ok: true, msg: "" };
  }
  if (id === "autoHide") {
    const r = await psCtl("'nd:' + [NdC.Ctl]::AutoHide(" + (on ? 1 : 0) + ")"), m = /nd:(\d)/.exec(r.out);
    return m && (m[1] === "1") === !!on ? { ok: true, msg: "" } : { ok: false, msg: "windows did not accept the change" };
  }
  const sw = SWITCHES[id]; if (!sw) return { ok: false, msg: "unknown switch" };
  const r = await run("reg.exe", ["add", sw.key, "/v", sw.name, "/t", "REG_DWORD", "/d", String(on ? sw.on : sw.off), "/f"]);
  return { ok: r.ok, msg: r.ok ? "" : r.err.trim().split(/\r?\n/)[0] };
}
// size of a folder tree, without following links; gives up after a time/entry budget
async function treeSize(start, budget) {
  let bytes = 0, count = 0; const stack = [start];
  while (stack.length && count < budget.max && Date.now() < budget.until) {
    const dir = stack.pop(); let items;
    try { items = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const it of items) {
      const p = path.join(dir, it.name); count++;
      if (it.isSymbolicLink()) continue;
      if (it.isDirectory()) stack.push(p);
      else { try { bytes += (await fs.promises.lstat(p)).size; } catch (e) {} }
    }
  }
  return { bytes, count };
}
function tempDir() {
  const t = path.resolve(os.tmpdir());
  if (t === path.parse(t).root || t.length < 8 || !/te?mp/i.test(t) || t === path.resolve(os.homedir())) throw new Error("temp folder looks unusual - not touching it");
  return t;
}
async function cleanScan() {
  const temp = await treeSize(tempDir(), { max: 150000, until: Date.now() + 10000 });
  let bin = null;
  if (WIN) {
    const r = await ps("$s=(New-Object -ComObject Shell.Application).NameSpace(10);$n=0;$z=0;foreach($i in $s.Items()){$n++;$z+=[double]$i.ExtendedProperty('Size')};'nd:'+$n+';'+$z", 25000);
    const m = /nd:(\d+);([\d.eE+,]+)/.exec(r.out);
    if (m) bin = { count: Number(m[1]), bytes: Number(m[2].replace(",", ".")) || 0 };
  }
  return { temp, tempPath: tempDir(), bin };
}
async function cleanTemp() {
  const dir = tempDir(), cutoff = Date.now() - 24 * 3600 * 1000;
  let removed = 0, freed = 0, kept = 0, items;
  try { items = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { throw new Error("temp folder could not be read"); }
  const until = Date.now() + 60000;
  for (const it of items) {
    if (Date.now() > until) { kept++; continue; }
    const p = path.join(dir, it.name);
    try {
      const st = await fs.promises.lstat(p);
      if (st.mtimeMs > cutoff) { kept++; continue; }          // used in the last day: leave it
      const sz = it.isDirectory() && !it.isSymbolicLink() ? (await treeSize(p, { max: 50000, until: Date.now() + 3000 })).bytes : st.size;
      await fs.promises.rm(p, { recursive: true, force: true, maxRetries: 0 });
      removed++; freed += sz;
    } catch (e) { kept++; }                                    // in use by a running program: leave it
  }
  return { removed, freed, kept };
}
async function cleanBin() {
  if (!WIN) return { ok: false, msg: "only available on Windows" };
  const r = await ps("Clear-RecycleBin -Force -ErrorAction SilentlyContinue; 'nd:done'", 60000);
  return { ok: /nd:done/.test(r.out), msg: r.err.trim().split(/\r?\n/)[0] || "" };
}

// ---- App behaviour: tray icon, global hotkey, start with Windows ----
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
let settings = { tray: false, hotkey: false, accel: "Control+Alt+N" };
function loadSettings() { try { Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile(), "utf8"))); } catch (e) {} }
function saveSettings() { try { fs.writeFileSync(settingsFile(), JSON.stringify(settings)); } catch (e) {} }
let tray = null, hotkeyOk = false, quitting = false, conWanted = true;
function hideAll() { if (con && !con.isDestroyed()) con.hide(); if (main && !main.isDestroyed()) main.hide(); }
function showAll() {
  if (!main || main.isDestroyed()) return;
  main.show(); if (main.isMinimized()) main.restore();
  if (conWanted && con && !con.isDestroyed()) { sync(); con.showInactive(); }
  main.focus();
}
function toggleAll() { if (main && !main.isDestroyed() && main.isVisible() && !main.isMinimized() && main.isFocused()) hideAll(); else showAll(); }
function applyTray() {
  if (settings.tray && !tray) {
    try {
      tray = new Tray(ICON); tray.setToolTip("Nightdeck Utility");
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: "Show Nightdeck", click: showAll }, { label: "Hide", click: hideAll }, { type: "separator" },
        { label: "Quit", click: () => { quitting = true; app.quit(); } }]));
      tray.on("click", () => { if (main && !main.isDestroyed() && main.isVisible()) hideAll(); else showAll(); });
    } catch (e) { tray = null; }
  } else if (!settings.tray && tray) { tray.destroy(); tray = null; }
}
const ACCEL = /^((Control|Ctrl|Alt|Shift|Super)\+){1,3}([A-Z0-9]|F([1-9]|1[0-2])|Space)$/i;
function applyHotkey() {
  globalShortcut.unregisterAll(); hotkeyOk = false; setTimeout(() => { registerCapKey(); registerLaunchKeys(); registerPalKey(); }, 0); // the shortcut hotkeys are put back right after
  if (settings.hotkey && ACCEL.test(settings.accel)) { try { hotkeyOk = globalShortcut.register(settings.accel, toggleAll); } catch (e) { hotkeyOk = false; } }
}
// ---- Control extras: audio devices, volume per program, night light, desktop, radios, wallpaper, cleanup, backup ----
// The C# helper is compiled once into the app's data folder and reused (a new version gets a new file name).
const CTL_CS = String.raw`using System; using System.Text; using System.Runtime.InteropServices;
namespace NdC {
[StructLayout(LayoutKind.Sequential)] public struct PK { public Guid f; public int p; }
[StructLayout(LayoutKind.Sequential)] public struct PV { public ushort vt; public ushort a, b, c; public IntPtr p; public IntPtr q; }
[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPS { [PreserveSig] int GetCount(out int c); [PreserveSig] int GetAt(int i, out PK k); [PreserveSig] int GetValue(ref PK k, out PV v); }
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDev { [PreserveSig] int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); [PreserveSig] int OpenPropertyStore(int acc, out IPS ps); [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id); [PreserveSig] int GetState(out int s); }
[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDevCol { [PreserveSig] int GetCount(out int c); [PreserveSig] int Item(int i, out IDev d); }
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IEnum { [PreserveSig] int EnumAudioEndpoints(int flow, int mask, out IDevCol c); [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IDev d); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class EnumObj { }
[ComImport, Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPolicy { [PreserveSig] int a(); [PreserveSig] int b(); [PreserveSig] int c(); [PreserveSig] int d(); [PreserveSig] int e(); [PreserveSig] int f(); [PreserveSig] int g(); [PreserveSig] int h(); [PreserveSig] int i(); [PreserveSig] int j();
  [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role); }
[ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")] class PolicyObj { }
[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IEpVol { [PreserveSig] int a(); [PreserveSig] int b(); [PreserveSig] int c(); [PreserveSig] int d(); [PreserveSig] int SetMasterVolumeLevelScalar(float l, ref Guid g); [PreserveSig] int e();
  [PreserveSig] int GetMasterVolumeLevelScalar(out float l); [PreserveSig] int f(); [PreserveSig] int g(); [PreserveSig] int h(); [PreserveSig] int i();
  [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool m, ref Guid g); [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool m); }
[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISesMgr2 { [PreserveSig] int a(); [PreserveSig] int b(); [PreserveSig] int GetSessionEnumerator(out ISesEnum e); }
[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISesEnum { [PreserveSig] int GetCount(out int c); [PreserveSig] int GetSession(int i, out ISesCtl2 s); }
[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISesCtl2 { [PreserveSig] int GetState(out int s); [PreserveSig] int a(); [PreserveSig] int b(); [PreserveSig] int c(); [PreserveSig] int d(); [PreserveSig] int e(); [PreserveSig] int f(); [PreserveSig] int g(); [PreserveSig] int h();
  [PreserveSig] int i(); [PreserveSig] int j(); [PreserveSig] int GetProcessId(out uint pid); [PreserveSig] int IsSystemSoundsSession(); }
[ComImport, Guid("87CE5498-68D6-44E5-9215-6F4BAB6A8B0E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISimpleVol { [PreserveSig] int SetMasterVolume(float l, ref Guid g); [PreserveSig] int GetMasterVolume(out float l); [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool m, ref Guid g); [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool m); }

public static class Ctl {
  static IEnum En() { return (IEnum)(new EnumObj()); }
  static string Name(IDev d) {
    IPS ps; if (d.OpenPropertyStore(0, out ps) != 0 || ps == null) return "?";
    var k = new PK(); k.f = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"); k.p = 14; PV v;
    if (ps.GetValue(ref k, out v) != 0 || v.vt != 31 || v.p == IntPtr.Zero) return "?";
    return Marshal.PtrToStringUni(v.p);
  }
  // one line per active device: default flag, id, name
  public static string Devices(int flow) {
    var sb = new StringBuilder(); var en = En(); IDev def; string defId = "";
    if (en.GetDefaultAudioEndpoint(flow, 1, out def) == 0 && def != null) def.GetId(out defId);
    IDevCol col; if (en.EnumAudioEndpoints(flow, 1, out col) != 0 || col == null) return "";
    int n; col.GetCount(out n);
    for (int i = 0; i < n; i++) { IDev d; if (col.Item(i, out d) != 0 || d == null) continue; string id; d.GetId(out id); sb.Append((id == defId ? "1" : "0") + "\t" + id + "\t" + Name(d).Replace("\t", " ") + "\n"); }
    return sb.ToString();
  }
  public static string SetDefault(string id) { var p = (IPolicy)(new PolicyObj()); for (int r = 0; r < 3; r++) { int hr = p.SetDefaultEndpoint(id, r); if (hr != 0) return "nd:err " + hr; } return "nd:ok"; }
  static IEpVol Ep(int flow) {
    IDev d; Marshal.ThrowExceptionForHR(En().GetDefaultAudioEndpoint(flow, 1, out d)); object o; var iid = typeof(IEpVol).GUID;
    Marshal.ThrowExceptionForHR(d.Activate(ref iid, 23, IntPtr.Zero, out o)); return (IEpVol)o;
  }
  // microphone mute: set 1 or 0, -1 to only read; returns -1 when there is no microphone
  public static int MicMute(int set) {
    try { var v = Ep(1); var g = Guid.Empty; if (set >= 0) Marshal.ThrowExceptionForHR(v.SetMute(set == 1, ref g)); bool m; v.GetMute(out m); return m ? 1 : 0; }
    catch (Exception) { return -1; }
  }
  // one line per program playing sound: pid, name, volume 0-100, mute. pidSet >= 0 changes that program first
  public static string Sessions(int pidSet, float vol, int mute) {
    IDev d; Marshal.ThrowExceptionForHR(En().GetDefaultAudioEndpoint(0, 1, out d)); object o; var iid = typeof(ISesMgr2).GUID;
    Marshal.ThrowExceptionForHR(d.Activate(ref iid, 23, IntPtr.Zero, out o)); var mgr = (ISesMgr2)o; ISesEnum se;
    Marshal.ThrowExceptionForHR(mgr.GetSessionEnumerator(out se));
    int n; se.GetCount(out n); var sb = new StringBuilder(); var g = Guid.Empty;
    for (int i = 0; i < n; i++) {
      ISesCtl2 c; if (se.GetSession(i, out c) != 0 || c == null) continue;
      int st; c.GetState(out st); if (st == 2) continue; // expired
      uint pid; c.GetProcessId(out pid); var sv = (ISimpleVol)c;
      if (pidSet >= 0 && pid == (uint)pidSet) { if (vol >= 0) sv.SetMasterVolume(Math.Min(1f, vol), ref g); if (mute >= 0) sv.SetMute(mute == 1, ref g); }
      float lv; sv.GetMasterVolume(out lv); bool mu; sv.GetMute(out mu);
      string name = "system sounds";
      if (c.IsSystemSoundsSession() != 0) { try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { name = "program " + pid; } }
      sb.Append(pid + "\t" + name + "\t" + Math.Round(lv * 100) + "\t" + (mu ? 1 : 0) + "\n");
    }
    return sb.ToString();
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string c, string w);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string w);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  // shows or hides the desktop icons, as the desktop's own menu does
  public static bool ToggleIcons() {
    IntPtr v = FindWindowEx(FindWindow("Progman", null), IntPtr.Zero, "SHELLDLL_DefView", null);
    if (v == IntPtr.Zero) { IntPtr w = IntPtr.Zero; while ((w = FindWindowEx(IntPtr.Zero, w, "WorkerW", null)) != IntPtr.Zero) { v = FindWindowEx(w, IntPtr.Zero, "SHELLDLL_DefView", null); if (v != IntPtr.Zero) break; } }
    if (v == IntPtr.Zero) return false;
    SendMessage(v, 0x111, (IntPtr)0x7402, IntPtr.Zero); return true;
  }
  [StructLayout(LayoutKind.Sequential)] struct ABD { public int cb; public IntPtr h; public uint msg; public uint edge; public int l, t, r, b; public IntPtr lp; }
  [DllImport("shell32.dll")] static extern IntPtr SHAppBarMessage(uint m, ref ABD d);
  // taskbar auto-hide: set 1 or 0, -1 to only read
  public static int AutoHide(int set) {
    var d = new ABD(); d.cb = Marshal.SizeOf(typeof(ABD)); d.h = FindWindow("Shell_TrayWnd", null);
    if (set >= 0) { d.lp = (IntPtr)(set == 1 ? 1 : 2); SHAppBarMessage(10, ref d); }
    return (((long)SHAppBarMessage(4, ref d)) & 1) != 0 ? 1 : 0;
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool SystemParametersInfo(uint a, uint b, string c, uint d);
  public static bool Wall(string p) { return SystemParametersInfo(20, 0, p, 3); }
}
public static class Mon {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct PM { public IntPtr h; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string d; }
  [StructLayout(LayoutKind.Sequential)] public struct RC { public int l, t, r, b; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct MI { public int cb; public RC m; public RC w; public uint f; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dev; }
  public delegate bool MEP(IntPtr hm, IntPtr dc, ref RC r, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MEP cb, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr hm, ref MI mi);
  [DllImport("dxva2.dll")] static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr hm, out uint n);
  [DllImport("dxva2.dll")] static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr hm, uint n, [Out] PM[] a);
  [DllImport("dxva2.dll")] static extern bool DestroyPhysicalMonitors(uint n, PM[] a);
  [DllImport("dxva2.dll")] static extern bool GetVCPFeatureAndVCPFeatureReply(IntPtr h, byte code, IntPtr type, out uint cur, out uint max);
  [DllImport("dxva2.dll")] static extern bool SetVCPFeature(IntPtr h, byte code, uint v);
  [DllImport("user32.dll")] static extern int SetDisplayConfig(uint a, IntPtr b, uint c, IntPtr d, uint flags);
  // one line per screen: number, main screen, device, name, brightness (-1 = not controllable), size
  public static string Run(int which, int set) {
    var list = new System.Collections.Generic.List<IntPtr>();
    MEP cb = delegate(IntPtr hm, IntPtr dc, ref RC r, IntPtr p) { list.Add(hm); return true; };
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, cb, IntPtr.Zero);
    GC.KeepAlive(cb);
    var sb = new StringBuilder();
    for (int i = 0; i < list.Count; i++) {
      var mi = new MI(); mi.cb = Marshal.SizeOf(typeof(MI)); GetMonitorInfo(list[i], ref mi);
      int b = -1; string desc = ""; uint n;
      if (GetNumberOfPhysicalMonitorsFromHMONITOR(list[i], out n) && n > 0) {
        var a = new PM[n];
        if (GetPhysicalMonitorsFromHMONITOR(list[i], n, a)) {
          try {
            desc = a[0].d ?? ""; uint cur, max;
            if (GetVCPFeatureAndVCPFeatureReply(a[0].h, 0x10, IntPtr.Zero, out cur, out max) && max > 0) {
              b = (int)(cur * 100 / max);
              if (which == i && set >= 0 && SetVCPFeature(a[0].h, 0x10, (uint)(max * set / 100))) b = set;
            }
          } finally { DestroyPhysicalMonitors(n, a); }
        }
      }
      sb.Append(i).Append('\t').Append((mi.f & 1) != 0 ? 1 : 0).Append('\t').Append(mi.dev).Append('\t').Append(desc.Replace('\t', ' '))
        .Append('\t').Append(b).Append('\t').Append(mi.m.r - mi.m.l).Append('x').Append(mi.m.b - mi.m.t).Append('\n');
    }
    return sb.ToString();
  }
  // 1 = main screen only, 2 = duplicate, 4 = extend
  public static int Topo(int t) { uint f = t == 1 ? 1u : t == 2 ? 2u : 4u; return SetDisplayConfig(0, IntPtr.Zero, 0, IntPtr.Zero, f | 0x80); }
}
}
`;
const ctlDll = () => path.join(app.getPath("userData"), "ndctl-" + require("crypto").createHash("md5").update(CTL_CS).digest("hex").slice(0, 8) + ".dll");
function psCtl(script, timeout) {
  const dll = ctlDll().replace(/'/g, "''");
  return ps("$dll='" + dll + "'; if (-not (Test-Path -LiteralPath $dll)) { Add-Type -TypeDefinition @'\n" + CTL_CS + "\n'@ -OutputAssembly $dll -OutputType Library }; Add-Type -LiteralPath $dll;" + script, timeout || 40000);
}
const firstLine = t => String(t || "").trim().split(/\r?\n/)[0];
async function audioDevices() {
  if (!WIN) return { ok: false, msg: "only available on Windows" };
  const r = await psCtl("[NdC.Ctl]::Devices(0) + '@@' + [NdC.Ctl]::Devices(1) + '@@' + [NdC.Ctl]::MicMute(-1)");
  const parts = r.out.split("@@"); if (parts.length < 3) return { ok: false, msg: "the sound devices could not be read" + (r.err ? " - " + firstLine(r.err) : "") };
  const parse = t => t.split(/\r?\n/).map(l => l.split("\t")).filter(a => a.length >= 3).map(a => ({ def: a[0] === "1", id: a[1], name: a[2] }));
  return { ok: true, out: parse(parts[0]), in: parse(parts[1]), micMute: /^\s*1/.test(parts[2]), mic: !/^\s*-1/.test(parts[2]) };
}
async function audioDefault(id) {
  id = String(id); if (!WIN) return { ok: false, msg: "only available on Windows" };
  if (!/^[\w.{}\-#]{5,200}$/.test(id)) return { ok: false, msg: "unknown device" };
  const r = await psCtl("[NdC.Ctl]::SetDefault('" + id + "')");
  return /nd:ok/.test(r.out) ? { ok: true } : { ok: false, msg: "windows did not accept the change" };
}
async function micMute(on) {
  if (!WIN) return { ok: false, msg: "only available on Windows" };
  const r = await psCtl("'nd:' + [NdC.Ctl]::MicMute(" + (on === true ? 1 : on === false ? 0 : -1) + ")"), m = /nd:(-?\d)/.exec(r.out);
  if (!m || m[1] === "-1") return { ok: false, msg: "no microphone found" };
  return { ok: true, mute: m[1] === "1" };
}
function parseSessions(out) {
  const by = new Map();
  for (const l of out.split(/\r?\n/)) {
    const a = l.split("\t"); if (a.length < 4 || !/^\d+$/.test(a[0])) continue;
    if (!by.has(a[0])) by.set(a[0], { pid: Number(a[0]), name: a[1], vol: Number(a[2]) || 0, mute: a[3] === "1" });
  }
  return [...by.values()].sort((x, y) => x.name.localeCompare(y.name));
}
async function appVolumes() {
  if (!WIN) return { ok: false, msg: "only available on Windows" };
  const r = await psCtl("[NdC.Ctl]::Sessions(-1, -1, -1)");
  if (r.err && !r.out.trim()) return { ok: false, msg: "the sound programs could not be read - " + firstLine(r.err) };
  return { ok: true, list: parseSessions(r.out) };
}
async function appVolume(pid, vol, mute) {
  if (!WIN) return { ok: false, msg: "only available on Windows" };
  pid = Number(pid); if (!Number.isInteger(pid) || pid < 0) return { ok: false, msg: "unknown program" };
  const v = vol == null ? -1 : Math.max(0, Math.min(100, Math.round(Number(vol)))) / 100, m = mute === true ? 1 : mute === false ? 0 : -1;
  const r = await psCtl("[NdC.Ctl]::Sessions(" + pid + ", " + v + ", " + m + ")"), it = parseSessions(r.out).find(x => x.pid === pid);
  return it ? { ok: true, vol: it.vol, mute: it.mute } : { ok: false, msg: "that program is not playing sound any more" };
}
// Night light is stored by Windows in one registry value; byte 18 says on (0x15) or off (0x13).
async function nightLight(set) {
  if (!WIN) return { ok: false, msg: "only available on Windows" };
  const s = "$set=" + (set === true ? 1 : set === false ? 0 : -1) + ";" +
    "$k='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CloudStore\\Store\\DefaultAccount\\Current\\default$windows.data.bluelightreduction.bluelightreductionstate\\windows.data.bluelightreduction.bluelightreductionstate';" +
    "try { $d=[byte[]](Get-ItemProperty -LiteralPath $k -Name Data -ErrorAction Stop).Data } catch { 'nd:none'; exit };" +
    "if ($d.Length -lt 26) { 'nd:none'; exit }; $on = $d[18] -eq 0x15;" +
    "if ($set -ge 0 -and ([bool]$set) -ne $on) {" +
    " if ($on) { $n = [byte[]]($d[0..22] + $d[25..($d.Length-1)]); $n[18] = 0x13 } else { $n = [byte[]]($d[0..22] + [byte[]](0x10,0x00) + $d[23..($d.Length-1)]); $n[18] = 0x15 };" +
    " for ($i = 10; $i -lt 15; $i++) { if ($n[$i] -ne 0xff) { $n[$i]++; break } };" +
    " Set-ItemProperty -LiteralPath $k -Name Data -Value $n -Type Binary; $on = -not $on };" +
    "'nd:' + [int]$on";
  const r = await ps(s), m = /nd:(\w+)/.exec(r.out);
  if (!m || m[1] === "none") return { ok: false, msg: "night light has not been set up on this pc yet - open its windows settings once" };
  return { ok: true, on: m[1] === "1" };
}
const RADIO_PS = "Add-Type -AssemblyName System.Runtime.WindowsRuntime;" +
  "$at = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0];" +
  "function W($op, $t) { $x = $at.MakeGenericMethod($t).Invoke($null, @($op)); $x.Wait(-1) | Out-Null; $x.Result };" +
  "[Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime] | Out-Null;" +
  "[Windows.Devices.Radios.RadioAccessStatus,Windows.System.Devices,ContentType=WindowsRuntime] | Out-Null;" +
  "[Windows.Devices.Radios.RadioState,Windows.System.Devices,ContentType=WindowsRuntime] | Out-Null;" +
  "W ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus]) | Out-Null;" +
  "function L { W ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]]) };";
async function radios(kind, on) {
  if (!WIN) return { ok: false, msg: "only available on Windows" };
  let s = RADIO_PS;
  if (kind) {
    if (kind !== "WiFi" && kind !== "Bluetooth") return { ok: false, msg: "unknown radio" };
    s += "foreach ($r in (L)) { if ([string]$r.Kind -eq '" + kind + "') { $res = W ($r.SetStateAsync([Windows.Devices.Radios.RadioState]::" + (on ? "On" : "Off") + ")) ([Windows.Devices.Radios.RadioAccessStatus]); 'nd:set;' + $res } };";
  }
  s += "foreach ($r in (L)) { 'nd:' + $r.Kind + ';' + $r.State + ';' + $r.Name }";
  const r = await ps(s, 30000), list = [];
  for (const m of r.out.matchAll(/nd:(WiFi|Bluetooth);(\w+);(.*)/g)) list.push({ kind: m[1], on: m[2] === "On", name: m[3].trim() });
  if (kind) { const m = /nd:set;(\w+)/.exec(r.out); if (!m || m[1] !== "Allowed") return { ok: false, msg: m ? "windows answered " + m[1] : "the radio did not answer", list }; }
  return { ok: true, list };
}
const WP_STYLE = { fill: "10", fit: "6", stretch: "2", center: "0", span: "22" };
async function wallpaper(style) {
  if (!WIN) return { ok: false, msg: "only available on Windows" };
  const st = WP_STYLE[style] || "10";
  const r = await dialog.showOpenDialog(main, { properties: ["openFile"], defaultPath: app.getPath("pictures"), filters: [{ name: "Pictures", extensions: ["jpg", "jpeg", "png", "bmp"] }] });
  if (r.canceled || !r.filePaths.length) return null;
  const f = r.filePaths[0];
  await run("reg.exe", ["add", "HKCU\\Control Panel\\Desktop", "/v", "WallpaperStyle", "/t", "REG_SZ", "/d", st, "/f"]);
  await run("reg.exe", ["add", "HKCU\\Control Panel\\Desktop", "/v", "TileWallpaper", "/t", "REG_SZ", "/d", "0", "/f"]);
  const x = await psCtl("'nd:' + [NdC.Ctl]::Wall('" + f.replace(/'/g, "''") + "')");
  return /nd:True/i.test(x.out) ? { ok: true, file: f } : { ok: false, msg: "windows did not accept that picture" };
}
// more cleanup: places that only hold caches or crash reports
function cleanDefs() {
  if (!WIN) return [];
  const L = process.env.LOCALAPPDATA || "", W = process.env.SystemRoot || "C:\\Windows";
  const sub = (base, names) => { const out = []; try { for (const d of fs.readdirSync(base, { withFileTypes: true })) if (d.isDirectory()) for (const n of names) out.push(path.join(base, d.name, n)); } catch (e) {} return out; };
  return [
    { id: "update", label: "windows update downloads", dirs: [path.join(W, "SoftwareDistribution", "Download")], admin: true, note: "windows asks for permission." },
    { id: "thumbs", label: "thumbnail cache", dirs: [path.join(L, "Microsoft", "Windows", "Explorer")], match: /^thumbcache_.*\.db$/i, note: "files in use are kept; thumbnails are made again when needed." },
    { id: "dumps", label: "crash dumps", dirs: [path.join(L, "CrashDumps"), path.join(W, "Minidump")], files: [path.join(W, "MEMORY.DMP")], admin: true, note: "system dumps need windows permission." },
    { id: "chrome", label: "chrome cache", dirs: sub(path.join(L, "Google", "Chrome", "User Data"), ["Cache", "Code Cache", "GPUCache"]), note: "close chrome first for the best result." },
    { id: "edge", label: "edge cache", dirs: sub(path.join(L, "Microsoft", "Edge", "User Data"), ["Cache", "Code Cache", "GPUCache"]), note: "close edge first for the best result." },
    { id: "firefox", label: "firefox cache", dirs: sub(path.join(L, "Mozilla", "Firefox", "Profiles"), ["cache2"]), note: "close firefox first for the best result." }
  ];
}
async function catSize(c) {
  let bytes = 0; const until = Date.now() + 8000;
  for (const d of c.dirs) {
    if (c.match) { try { for (const f of await fs.promises.readdir(d)) if (c.match.test(f)) { try { bytes += (await fs.promises.stat(path.join(d, f))).size; } catch (e) {} } } catch (e) {} }
    else if (fs.existsSync(d)) bytes += (await treeSize(d, { max: 200000, until })).bytes;
  }
  for (const f of c.files || []) { try { bytes += (await fs.promises.stat(f)).size; } catch (e) {} }
  return bytes;
}
async function cleanCats() { const out = []; for (const c of cleanDefs()) out.push({ id: c.id, label: c.label, admin: !!c.admin, note: c.note, bytes: await catSize(c) }); return out; }
async function cleanCat(id) {
  const c = cleanDefs().find(x => x.id === id); if (!c) throw new Error("unknown cleanup");
  const before = await catSize(c); let kept = 0; const denied = [];
  const gone = async p => { try { await fs.promises.rm(p, { recursive: true, force: true, maxRetries: 0 }); } catch (e) { if (/EPERM|EACCES/.test(e.code) && c.admin) return false; kept++; } return true; };
  for (const d of c.dirs) {
    let items; try { items = await fs.promises.readdir(d); } catch (e) { if (/EPERM|EACCES/.test(e.code) && c.admin) denied.push(d); continue; }
    let refused = false;
    for (const f of items) if (!c.match || c.match.test(f)) { if (!(await gone(path.join(d, f)))) refused = true; }
    if (refused) denied.push(d);
  }
  for (const f of c.files || []) if (fs.existsSync(f) && !(await gone(f))) denied.push(f);
  let msg = "";
  if (denied.length) { // ask Windows to do the rest with administrator rights
    const q = s => "'" + s.replace(/'/g, "''") + "'";
    const cmd = denied.map(p => c.files && c.files.includes(p) ? "Remove-Item -LiteralPath " + q(p) + " -Force -ErrorAction SilentlyContinue"
      : "Get-ChildItem -LiteralPath " + q(p) + " -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue").join("; ");
    const enc = Buffer.from(cmd, "utf16le").toString("base64");
    const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "try { Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','" + enc + "'; exit 0 } catch { exit 1223 }"], 180000);
    if (!r.ok) msg = "the windows permission was declined, so some files were left";
  }
  const after = await catSize(c);
  return { freed: Math.max(0, before - after), kept, msg };
}
function openDrive(root) { root = String(root); if (!/^[A-Z]:\\$/.test(root) && root !== "/") throw new Error("unknown drive"); return shell.openPath(root).then(e => { if (e) throw new Error(e); return true; }); }
const SETTING_LINKS = { display: "ms-settings:display", sound: "ms-settings:sound", bluetooth: "ms-settings:bluetooth", apps: "ms-settings:appsfeatures",
  update: "ms-settings:windowsupdate", storage: "ms-settings:storagesense", nightlight: "ms-settings:nightlight", notifications: "ms-settings:notifications", power: "ms-settings:powersleep" };
async function openSetting(k) {
  if (!WIN) throw new Error("only available on Windows");
  const W = process.env.SystemRoot || "C:\\Windows";
  if (SETTING_LINKS[k]) { await shell.openExternal(SETTING_LINKS[k]); return true; }
  if (k === "devices") { const e = await shell.openPath(path.join(W, "System32", "devmgmt.msc")); if (e) throw new Error(e); return true; }
  if (k === "taskmgr" || k === "control") { spawn(path.join(W, "System32", k === "taskmgr" ? "Taskmgr.exe" : "control.exe"), [], { detached: true, stdio: "ignore" }).unref(); return true; }
  throw new Error("unknown settings page");
}
// backup of everything Nightdeck keeps: the window's own storage plus the settings files
const BK_FILES = ["settings.json", "clipboard.json", "capture.json", "beta.json"];
async function backupSave(local) {
  if (!local || typeof local !== "object") throw new Error("nothing to back up");
  const files = {}; for (const f of BK_FILES) { try { files[f] = fs.readFileSync(path.join(app.getPath("userData"), f), "utf8"); } catch (e) {} }
  const n = new Date(), p = x => String(x).padStart(2, "0");
  const r = await dialog.showSaveDialog(main, { defaultPath: path.join(app.getPath("documents"), "nightdeck-backup-" + n.getFullYear() + p(n.getMonth() + 1) + p(n.getDate()) + ".json"), filters: [{ name: "Nightdeck backup", extensions: ["json"] }] });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, JSON.stringify({ app: "nightdeck-backup", version: 1, made: n.toISOString(), local, files }));
  return r.filePath;
}
async function backupLoad() {
  const r = await dialog.showOpenDialog(main, { properties: ["openFile"], defaultPath: app.getPath("documents"), filters: [{ name: "Nightdeck backup", extensions: ["json"] }] });
  if (r.canceled || !r.filePaths.length) return null;
  if (fs.statSync(r.filePaths[0]).size > 50 * 1048576) throw new Error("that file is too large");
  let j; try { j = JSON.parse(fs.readFileSync(r.filePaths[0], "utf8")); } catch (e) { throw new Error("that is not a nightdeck backup"); }
  if (!j || j.app !== "nightdeck-backup" || !j.local || typeof j.local !== "object") throw new Error("that is not a nightdeck backup");
  const local = {}; for (const k in j.local) if (/^ndu-.{1,80}$/.test(k) && typeof j.local[k] === "string") local[k] = j.local[k];
  for (const f of BK_FILES) if (j.files && typeof j.files[f] === "string") { try { JSON.parse(j.files[f]); fs.writeFileSync(path.join(app.getPath("userData"), f), j.files[f]); } catch (e) {} }
  return local;
}
function appRestart() { quitting = true; app.relaunch({ args: process.argv.slice(1).filter(a => a !== "--startup") }); setTimeout(() => app.quit(), 300); return true; }
function applyWin() {
  for (const w of [main, con]) if (w && !w.isDestroyed()) { try { w.setAlwaysOnTop(!!settings.onTop); w.setOpacity(Math.max(0.5, Math.min(1, Number(settings.opacity) || 1))); } catch (e) {} }
}

// ---- BETA: feature switches, profiles, game mode, gpu details, overlay, screens, command search, schedule, alerts, usage time ----
// Everything is kept in beta.json next to the other settings. Background work only runs while its switch is on.
const betaFile = () => path.join(app.getPath("userData"), "beta.json");
const BETA_ON = { profiles: true, game: true, gpu: true, overlay: false, monitors: true, palette: true, schedule: true, alerts: false, usage: false };
let beta = { on: Object.assign({}, BETA_ON), profiles: {}, game: { apps: [], force: false, active: null, hiPlan: "" }, corner: "tr", palKey: "Control+Alt+Space",
  sched: [], alerts: { cpu: 80, memGb: 4, mins: 3 }, alertLog: [], usage: {}, usagePath: {} };
let smiExe = null, palReg = "", palOk = false, betaDirty = false;
function loadBeta() {
  try {
    const j = JSON.parse(fs.readFileSync(betaFile(), "utf8"));
    if (j && typeof j === "object") { Object.assign(beta, j); beta.on = Object.assign({}, BETA_ON, j.on || {}); beta.game = Object.assign({ apps: [], force: false, active: null, hiPlan: "" }, j.game || {}); }
  } catch (e) {}
}
function saveBeta() { betaDirty = false; try { fs.writeFileSync(betaFile(), JSON.stringify(beta)); } catch (e) {} }
const cleanName = n => { n = String(n || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 40); if (!n) throw new Error("give it a name"); return n; };
const procName = n => String(n || "").trim().replace(/\.exe$/i, "");
function betaGet() {
  return { on: beta.on, profiles: profList(), game: { apps: beta.game.apps, force: !!beta.game.force, active: !!beta.game.active, since: beta.game.active ? beta.game.active.t : 0 },
    corner: beta.corner, palKey: beta.palKey, palOk, sched: beta.sched, alerts: beta.alerts, alertLog: beta.alertLog };
}
function betaSet(key, v) {
  if (key === "feat") {
    if (!v || !Object.prototype.hasOwnProperty.call(BETA_ON, v.id)) throw new Error("unknown feature");
    beta.on[v.id] = !!v.on;
  } else if (key === "corner") { if (!["tl", "tr", "bl", "br"].includes(v)) throw new Error("unknown corner"); beta.corner = v; }
  else if (key === "palKey") { v = String(v).trim(); if (!ACCEL.test(v)) throw new Error("use a combination like Control+Alt+Space"); beta.palKey = v; }
  else if (key === "gameApps") { beta.game.apps = [].concat(v || []).map(procName).filter(n => /^[\w .+\-()]{1,80}$/.test(n) && !isProtected(n)).slice(0, 40); }
  else if (key === "gameForce") beta.game.force = !!v;
  else if (key === "alerts") {
    const cpu = Number(v && v.cpu), mem = Number(v && v.memGb), mins = Number(v && v.mins);
    if (!(cpu >= 10 && cpu <= 100) || !(mem >= 0.5 && mem <= 64) || !(mins >= 1 && mins <= 60)) throw new Error("use cpu 10-100 %, memory 0.5-64 GB and 1-60 minutes");
    beta.alerts = { cpu, memGb: mem, mins: Math.round(mins) };
  } else if (key === "alertClear") beta.alertLog = [];
  else if (key === "sched") beta.sched = [].concat(v || []).slice(0, 30).map(checkRule);
  else throw new Error("unknown setting");
  saveBeta(); betaApply();
  return betaGet();
}
function betaApply() { overlayApply(); registerPalKey(); watchApply(); }

// profiles: a saved set of power plan, volume, sound output, night light and a few windows switches
const PROF_SW = ["appsDark", "sysDark", "transparency", "toasts"];
async function swGet(id) {
  const sw = SWITCHES[id], r = await run("reg.exe", ["query", sw.key, "/v", sw.name]), m = /REG_DWORD\s+0x([0-9a-f]+)/i.exec(r.out);
  return m ? parseInt(m[1], 16) === sw.on : !!sw.dflt;
}
function profList() { return Object.keys(beta.profiles).sort().map(name => Object.assign({ name }, beta.profiles[name])); }
async function profSave(name) {
  if (!WIN) throw new Error("only available on Windows");
  name = cleanName(name);
  if (!beta.profiles[name] && Object.keys(beta.profiles).length >= 20) throw new Error("20 profiles at most");
  const [plans, vol, dev, night] = await Promise.all([powerPlans(), volume(null, null), audioDevices(), nightLight(null)]);
  const plan = plans.list.find(x => x.active), out = dev.ok ? dev.out.find(d => d.def) : null, sw = {};
  for (const id of PROF_SW) sw[id] = await swGet(id);
  beta.profiles[name] = { plan: plan ? plan.id : null, planName: plan ? plan.name : "", volume: vol.ok ? vol.level : null, mute: vol.ok ? vol.mute : null,
    out: out ? out.id : null, outName: out ? out.name : "", night: night.ok ? night.on : null, sw, t: Date.now() };
  saveBeta(); return profList();
}
async function profApply(name) {
  const p = beta.profiles[String(name)]; if (!p) throw new Error("that profile does not exist");
  if (!WIN) throw new Error("only available on Windows");
  const fails = [];
  const step = async (what, fn) => { try { const r = await fn(); if (r && r.ok === false) fails.push(what + (r.msg ? " (" + r.msg + ")" : "")); } catch (e) { fails.push(what + " (" + e.message + ")"); } };
  if (p.plan) await step("power plan", () => powerPlan(p.plan));
  if (p.out) await step("sound output", () => audioDefault(p.out));
  if (p.volume != null) await step("volume", () => volume(p.volume, p.mute));
  if (p.night != null) await step("night light", () => nightLight(p.night));
  for (const id in p.sw || {}) if (PROF_SW.includes(id) && (await swGet(id)) !== !!p.sw[id]) await step(id, () => switchSet(id, !!p.sw[id]));
  pushLog("profile " + name + " applied" + (fails.length ? " - not changed: " + fails.join(", ") : ""));
  return { ok: !fails.length, fails };
}
function profDelete(name) { delete beta.profiles[String(name)]; saveBeta(); return profList(); }

// game mode: high performance, no notification banners, chosen programs closed - and everything put back afterwards
const HI_PLANS = ["e9a42b02-d5df-448d-aa00-03f14749eb61", "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c"];
async function hiPlan() {
  let list = (await powerPlans()).list;
  const find = () => list.find(p => p.id === beta.game.hiPlan) || HI_PLANS.map(id => list.find(p => p.id === id)).find(Boolean);
  if (find()) return find();
  // windows often hides the high performance plan; a copy of it is made once and remembered
  const r = await run("powercfg.exe", ["/duplicatescheme", HI_PLANS[1]], 15000), m = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/i.exec(r.out);
  if (!m) return null;
  beta.game.hiPlan = m[1].toLowerCase(); saveBeta();
  list = (await powerPlans()).list; return find() || null;
}
async function gameMode(on) {
  if (!WIN) return { ok: false, msg: "only available on Windows" };
  const g = beta.game, notes = [];
  if (on && !g.active) {
    const st = { t: Date.now(), plan: null, toasts: false, closed: [] };
    const cur = (await powerPlans()).list.find(p => p.active); st.plan = cur ? cur.id : null;
    const hi = await hiPlan();
    if (hi && !hi.active) { const r = await powerPlan(hi.id); if (!r.ok) notes.push("power plan not changed"); }
    else if (!hi) notes.push("no high performance plan on this pc");
    st.toasts = await swGet("toasts"); if (st.toasts) await switchSet("toasts", false);
    if (g.apps.length) {
      const procs = await listProcs();
      for (const name of g.apps) {
        const p = procs.find(x => x.name.toLowerCase() === name.toLowerCase());
        if (!p || p.protected) continue;
        const r = await killProc(p.name, !!g.force);
        if (r.ok) st.closed.push({ name: p.name, path: p.path || "" }); else notes.push(p.name + " not closed");
      }
    }
    g.active = st; saveBeta();
    pushLog("game mode on" + (st.closed.length ? " - closed " + st.closed.map(c => c.name).join(", ") : "") + (notes.length ? " - " + notes.join(", ") : ""));
  } else if (!on && g.active) {
    const st = g.active;
    if (st.plan) { const r = await powerPlan(st.plan).catch(e => ({ ok: false, msg: e.message })); if (!r.ok) notes.push("power plan not restored"); }
    if (st.toasts) await switchSet("toasts", true);
    for (const c of st.closed) if (c.path) await launchTarget(c.path).catch(() => notes.push(c.name + " not reopened"));
    g.active = null; saveBeta();
    pushLog("game mode off - settings restored" + (notes.length ? " - " + notes.join(", ") : ""));
  }
  return { ok: true, active: !!g.active, notes };
}

// gpu details from nvidia-smi (found by the temperature reader)
const GPU_F = ["name", "temperature.gpu", "utilization.gpu", "fan.speed", "memory.used", "memory.total", "power.draw", "power.limit", "clocks.gr", "clocks.max.gr", "clocks.mem", "pstate", "driver_version"];
async function gpuStats() {
  if (!smiExe) { tempCache.t = 0; await readTemps(); }
  if (!smiExe) return { ok: false, msg: "nvidia-smi was not found - this needs an nvidia graphics card and its driver" };
  const r = await run(smiExe, ["--query-gpu=" + GPU_F.join(","), "--format=csv,noheader,nounits"], 10000);
  if (!r.ok) return { ok: false, msg: firstLine(r.err) || "nvidia-smi did not answer" };
  const parts = firstLine(r.out).split(",").map(s => s.trim()), o = { ok: true };
  GPU_F.forEach((k, i) => { o[k] = parts[i] == null || /N\/A|not supported/i.test(parts[i]) ? "" : parts[i]; });
  return o;
}

// overlay: a small always-on-top line with cpu, memory and gpu; clicks go through it
let ovWin = null, ovT = null;
const OV_HTML = "<!doctype html><meta charset=utf-8><body style=\"margin:0;overflow:hidden;background:transparent\"><div id=t style=\"display:inline-block;" +
  "font:600 12px 'IBM Plex Mono',Consolas,monospace;color:#dfe6ea;background:rgba(12,15,18,.78);padding:4px 9px;border:1px solid rgba(79,195,217,.45);white-space:nowrap\">...</div>" +
  "<script>window.set=function(s){document.getElementById('t').textContent=s}</script></body>";
function overlayPlace() {
  if (!ovWin || ovWin.isDestroyed()) return;
  const b = screen.getPrimaryDisplay().bounds, w = 300, hh = 28, m = 8, c = beta.corner;
  ovWin.setBounds({ x: c[1] === "l" ? b.x + m : b.x + b.width - w - m, y: c[0] === "t" ? b.y + m : b.y + b.height - hh - m, width: w, height: hh });
  ovWin.webContents.executeJavaScript("document.body.style.textAlign='" + (c[1] === "l" ? "left" : "right") + "'").catch(() => {});
}
async function overlayTick() {
  if (!ovWin || ovWin.isDestroyed()) return;
  const t = await readTemps().catch(() => ({})), mem = (1 - os.freemem() / os.totalmem()) * 100;
  const s = "CPU " + Math.round(cpuPercent()) + "%  RAM " + Math.round(mem) + "%" +
    (t.gpuUse != null ? "  GPU " + Math.round(t.gpuUse) + "%" : "") + (t.gpu != null ? " " + Math.round(t.gpu) + "°C" : "");
  if (ovWin && !ovWin.isDestroyed()) ovWin.webContents.executeJavaScript("window.set&&set(" + JSON.stringify(s) + ")").catch(() => {});
}
function overlayApply() {
  if (!beta.on.overlay) { clearInterval(ovT); ovT = null; if (ovWin && !ovWin.isDestroyed()) ovWin.destroy(); ovWin = null; return; }
  if (!ovWin || ovWin.isDestroyed()) {
    ovWin = new BrowserWindow({ width: 300, height: 28, frame: false, transparent: true, resizable: false, movable: false, focusable: false, skipTaskbar: true,
      alwaysOnTop: true, show: false, hasShadow: false, backgroundColor: "#00000000", webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    ovWin.setAlwaysOnTop(true, "screen-saver"); ovWin.setIgnoreMouseEvents(true);
    ovWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(OV_HTML));
    ovWin.webContents.once("did-finish-load", () => { overlayPlace(); overlayTick(); if (ovWin && !ovWin.isDestroyed()) ovWin.showInactive(); });
    ovWin.on("closed", () => { ovWin = null; });
  } else overlayPlace();
  if (!ovT) ovT = setInterval(overlayTick, 1000);
}

// screens: brightness of each screen (ddc/ci), and main screen only / duplicate / extend
async function monitors(which, set) {
  if (!WIN) return { ok: false, msg: "only available on Windows" };
  const w = Number.isInteger(which) ? which : -1, s = set != null && isFinite(set) ? pct(set) : -1;
  const r = await psCtl("[NdC.Mon]::Run(" + w + ", " + s + ")");
  const list = r.out.split(/\r?\n/).map(l => l.split("\t")).filter(a => a.length >= 6 && /^\d+$/.test(a[0]))
    .map(a => ({ i: Number(a[0]), main: a[1] === "1", dev: a[2].replace(/^\\\\\.\\/, ""), name: a[3] || "screen", bright: Number(a[4]), size: a[5] }));
  if (!list.length) return { ok: false, msg: "the screens could not be read" + (r.err ? " - " + firstLine(r.err) : "") };
  return { ok: true, list };
}
async function screenMode(mode) {
  if (!WIN) return { ok: false, msg: "only available on Windows" };
  const t = { one: 1, clone: 2, extend: 4 }[mode]; if (!t) return { ok: false, msg: "unknown mode" };
  const r = await psCtl("'nd:' + [NdC.Mon]::Topo(" + t + ")"), m = /nd:(-?\d+)/.exec(r.out);
  return m && m[1] === "0" ? { ok: true } : { ok: false, msg: "windows did not accept the change" + (m ? " (code " + m[1] + ")" : "") };
}

// command search: a hotkey that brings nightdeck forward with the search box open
function registerPalKey() {
  if (palReg) { try { globalShortcut.unregister(palReg); } catch (e) {} palReg = ""; }
  palOk = false;
  if (!beta.on.palette || !ACCEL.test(beta.palKey)) return;
  try {
    palOk = globalShortcut.register(beta.palKey, () => {
      showAll(); if (main && !main.isDestroyed()) main.webContents.executeJavaScript("window.ndPalette&&window.ndPalette()").catch(() => {});
    });
    if (palOk) palReg = beta.palKey;
  } catch (e) { palOk = false; }
}

// scheduled actions: at a time, or when a program starts
const SCHED_ACT = ["lock", "sleep", "screenoff", "shutdown", "restart", "game-on", "game-off", "night-on", "night-off", "mute"];
function checkRule(r) {
  r = r || {};
  const o = { id: String(r.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).slice(0, 20), on: r.on !== false,
    kind: r.kind === "start" ? "start" : "time", time: String(r.time || ""), days: String(r.days || "daily"), proc: procName(r.proc), action: String(r.action || ""), last: String(r.last || "") };
  if (o.kind === "time" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(o.time)) throw new Error("pick a time");
  if (!["daily", "weekdays", "weekends", "once"].includes(o.days)) throw new Error("unknown days");
  if (o.kind === "start" && !/^[\w .+\-()]{1,80}$/.test(o.proc)) throw new Error("type a program name, for example steam");
  const okAct = SCHED_ACT.includes(o.action) || (/^profile:.{1,40}$/.test(o.action)) || (/^open:.{3,500}$/.test(o.action) && !/[\r\n]/.test(o.action));
  if (!okAct) throw new Error("pick an action");
  return o;
}
async function runAction(a, why) {
  pushLog("scheduled: " + why + " -> " + a.replace(/^open:.*[\\/]/, "open "));
  try {
    if (["lock", "sleep", "screenoff"].includes(a)) return await API.power(a);
    if (a === "shutdown" || a === "restart") {
      try { new Notification({ title: "Nightdeck", body: (a === "shutdown" ? "Shutting down" : "Restarting") + " in one minute (" + why + "). The power tab can cancel it." }).show(); } catch (e) {}
      return await run("shutdown.exe", [a === "shutdown" ? "/s" : "/r", "/t", "60"], 15000);
    }
    if (a === "game-on" || a === "game-off") return await gameMode(a === "game-on");
    if (a === "night-on" || a === "night-off") return await nightLight(a === "night-on");
    if (a === "mute") return await volume(null, true);
    if (a.startsWith("profile:")) return await profApply(a.slice(8));
    if (a.startsWith("open:")) return await launchTarget(a.slice(5));
  } catch (e) { pushLog("scheduled action failed: " + e.message); }
}
const dayKey = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
function schedTick() {
  if (!beta.on.schedule) return;
  const now = new Date(), hm = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0"), wd = now.getDay(), stamp = dayKey(now) + " " + hm;
  let changed = false;
  for (const r of beta.sched) {
    if (!r.on || r.kind !== "time" || r.time !== hm || r.last === stamp) continue;
    if (r.days === "weekdays" && (wd === 0 || wd === 6)) continue;
    if (r.days === "weekends" && wd !== 0 && wd !== 6) continue;
    r.last = stamp; if (r.days === "once") r.on = false; changed = true;
    runAction(r.action, "at " + r.time);
  }
  if (changed) saveBeta();
}

// one small helper reports the program in front every 5 seconds and the program list every 10 seconds
let watchPs = null, prevSample = null, prevNames = null, lastFg = 0;
const overSince = new Map(), lastAlert = new Map();
function watchWanted() { return WIN && (beta.on.usage || beta.on.alerts || (beta.on.schedule && beta.sched.some(r => r.on && r.kind === "start"))); }
function watchApply() {
  if (!watchWanted()) { if (watchPs) { try { watchPs.kill(); } catch (e) {} watchPs = null; } return; }
  if (watchPs) return;
  const script = "$ErrorActionPreference='SilentlyContinue';" +
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class NdFg { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); }';" +
    "$i=0; while (Get-Process -Id " + process.pid + ") {" +
    " $p=[uint32]0; [void][NdFg]::GetWindowThreadProcessId([NdFg]::GetForegroundWindow(), [ref]$p); $n=''; $f='';" +
    " if ($p) { $g=Get-Process -Id $p; if ($g) { $n=$g.Name; $f=$g.Path } };" +
    " [Console]::Out.WriteLine('F ' + $n + '|' + $f);" +
    " if ($i % 2 -eq 0) { [Console]::Out.WriteLine('P ' + ((Get-Process | ForEach-Object { $_.Name + '|' + [int64]($_.CPU * 1000) + '|' + $_.WorkingSet64 }) -join '/')) };" +
    " $i++; Start-Sleep -Seconds 5 }";
  const enc = Buffer.from(script, "utf16le").toString("base64");
  const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  watchPs = p; prevSample = prevNames = null; lastFg = 0; let buf = "";
  p.stdout.on("data", d => {
    buf += d; let k;
    while ((k = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, k).trim(); buf = buf.slice(k + 1); try { watchLine(line); } catch (e) {} }
    if (buf.length > 2000000) buf = "";
  });
  const gone = () => { if (watchPs === p) watchPs = null; };
  p.on("exit", gone); p.on("error", gone);
}
function watchLine(line) {
  const now = Date.now();
  if (line.startsWith("F ")) {
    const [name, file] = line.slice(2).split("|"), dt = lastFg ? Math.min(10, (now - lastFg) / 1000) : 5; lastFg = now;
    if (!beta.on.usage || !name || name === "Idle") return;
    let idle = 0; try { idle = powerMonitor.getSystemIdleTime(); } catch (e) {}
    if (idle > 120) return; // nobody at the pc
    const day = dayKey(new Date()), u = beta.usage[day] = beta.usage[day] || {};
    u[name] = Math.round(((u[name] || 0) + dt) * 10) / 10;
    if (file) beta.usagePath[name] = file;
    const keep = Object.keys(beta.usage).sort().slice(-14); for (const d in beta.usage) if (!keep.includes(d)) delete beta.usage[d];
    betaDirty = true;
  } else if (line.startsWith("P ")) {
    const map = new Map();
    for (const it of line.slice(2).split("/")) {
      const a = it.split("|"); if (a.length < 3 || !a[0]) continue;
      const g = map.get(a[0]) || { cpu: 0, mem: 0 }; g.cpu += Number(a[1]) || 0; g.mem += Number(a[2]) || 0; map.set(a[0], g);
    }
    // programs that just started (for scheduled actions)
    if (prevNames && beta.on.schedule) {
      for (const r of beta.sched) {
        if (!r.on || r.kind !== "start") continue;
        const hit = [...map.keys()].find(n => n.toLowerCase() === r.proc.toLowerCase());
        if (hit && !prevNames.has(hit.toLowerCase())) runAction(r.action, r.proc + " started");
      }
    }
    prevNames = new Set([...map.keys()].map(n => n.toLowerCase()));
    // heavy programs
    if (beta.on.alerts && prevSample && now > prevSample.t) {
      const cores = os.cpus().length || 1, s = (now - prevSample.t) / 1000, A = beta.alerts;
      for (const [name, g] of map) {
        if (isProtected(name) || name === "Idle") continue;
        const before = prevSample.map.get(name), cpu = before ? Math.max(0, g.cpu - before.cpu) / 1000 / s / cores * 100 : 0;
        const over = cpu >= A.cpu || g.mem >= A.memGb * 1073741824;
        if (!over) { overSince.delete(name); continue; }
        if (!overSince.has(name)) overSince.set(name, now);
        if (now - overSince.get(name) >= A.mins * 60000 && now - (lastAlert.get(name) || 0) > 30 * 60000) {
          lastAlert.set(name, now);
          const what = cpu >= A.cpu ? Math.round(cpu) + "% cpu" : (g.mem / 1073741824).toFixed(1) + " GB memory";
          const msg = name + " has used " + what + " for " + A.mins + " minute" + (A.mins > 1 ? "s" : "");
          beta.alertLog.unshift({ t: now, msg }); beta.alertLog = beta.alertLog.slice(0, 20); betaDirty = true;
          pushLog("alert: " + msg);
          try { new Notification({ title: "Nightdeck", body: msg }).show(); } catch (e) {}
        }
      }
      for (const n of [...overSince.keys()]) if (!map.has(n)) overSince.delete(n);
    }
    prevSample = { t: now, map };
  }
}
async function usageGet() {
  const days = Object.keys(beta.usage).sort().slice(-7), icons = {};
  const names = new Set(); for (const d of days) for (const n in beta.usage[d]) names.add(n);
  await Promise.all([...names].map(async n => { const f = beta.usagePath[n]; icons[n] = f ? await fileIcon(f) : ""; }));
  return { on: !!beta.on.usage, today: dayKey(new Date()), days: days.map(d => ({ day: d, apps: beta.usage[d] })), icons };
}
function usageReset() { beta.usage = {}; beta.usagePath = {}; saveBeta(); return true; }
function betaInit() {
  loadBeta(); betaApply();
  setInterval(schedTick, 15000);
  setInterval(() => { if (betaDirty) saveBeta(); }, 60000);
  if (main) main.on("closed", () => { if (ovWin && !ovWin.isDestroyed()) ovWin.destroy(); });
}

const LOGIN_ARGS = ["--startup"];
function settingsGet() {
  let login = false; try { login = app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin; } catch (e) {}
  return { tray: settings.tray, trayOk: !settings.tray || !!tray, hotkey: settings.hotkey, hotkeyOk, accel: settings.accel, login, onTop: !!settings.onTop, startTray: !!settings.startTray, opacity: Number(settings.opacity) || 1 };
}
function settingSet(key, value) {
  if (key === "tray") { settings.tray = !!value; applyTray(); }
  else if (key === "hotkey") { settings.hotkey = !!value; applyHotkey(); }
  else if (key === "accel") { value = String(value).trim(); if (!ACCEL.test(value)) throw new Error("use a combination like Control+Alt+N"); settings.accel = value; applyHotkey(); }
  else if (key === "onTop") { settings.onTop = !!value; applyWin(); }
  else if (key === "startTray") { settings.startTray = !!value; }
  else if (key === "opacity") { const v = Number(value); if (!(v >= 0.5 && v <= 1)) throw new Error("opacity must be 50 to 100%"); settings.opacity = v; applyWin(); }
  else if (key === "login") { app.setLoginItemSettings({ openAtLogin: !!value, args: LOGIN_ARGS }); }
  else throw new Error("unknown setting");
  saveSettings();
  return settingsGet();
}

// ---- Everything the tool tabs can ask the app to do ----
// every drive with its size and free space (looked up again every 10 seconds)
let diskCache = { t: 0, list: [] };
function listDisks() {
  if (Date.now() - diskCache.t < 10000) return diskCache.list;
  const list = [], roots = WIN ? "CDEFGHIJKLMNOPQRSTUVWXYZ".split("").map(l => l + ":\\") : [path.parse(os.homedir()).root];
  for (const root of roots) {
    try {
      if (WIN && !fs.existsSync(root)) continue;
      const st = fs.statfsSync(root), total = st.blocks * st.bsize;
      if (total > 0) list.push({ root, total, free: st.bavail * st.bsize });
    } catch (e) {}
  }
  diskCache = { t: Date.now(), list };
  return list;
}
// details that do not change while the PC runs: mainboard, memory modules, screens
let extraCache = null;
async function sysExtra() {
  if (extraCache) return extraCache;
  const out = { board: "", ram: "", screens: "" };
  try {
    out.screens = screen.getAllDisplays().map(s => Math.round(s.size.width * s.scaleFactor) + " x " + Math.round(s.size.height * s.scaleFactor) +
      (s.displayFrequency ? " @ " + Math.round(s.displayFrequency) + " Hz" : "")).join(",  ");
  } catch (e) {}
  if (WIN) {
    const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='SilentlyContinue'; $b=Get-CimInstance Win32_BaseBoard | Select-Object -First 1 Manufacturer,Product; " +
      "$m=@(Get-CimInstance Win32_PhysicalMemory | Select-Object Capacity,Speed); [pscustomobject]@{board=$b;mem=$m} | ConvertTo-Json -Compress -Depth 3"], 20000);
    try {
      const j = JSON.parse(r.out);
      if (j.board) out.board = [j.board.Manufacturer, j.board.Product].filter(Boolean).join(" ").trim();
      const m = [].concat(j.mem || []).filter(Boolean);
      if (m.length) {
        const sizes = m.map(x => Math.round(Number(x.Capacity) / 1073741824)), speed = Math.max(...m.map(x => Number(x.Speed) || 0));
        out.ram = (sizes.every(s => s === sizes[0]) ? m.length + " x " + sizes[0] + " GB" : sizes.join(" + ") + " GB") + (speed ? ", " + speed + " MHz" : "");
      }
    } catch (e) {}
  }
  extraCache = out;
  return out;
}
// ---- Launcher: open (also as administrator), icons, installed apps, hotkeys ----
async function launchTarget(target, admin) {
  target = String(target);
  if (/^https?:\/\//i.test(target)) { await shell.openExternal(target); return true; }
  if (WIN && /^shell:AppsFolder\\[\w.!\-]+$/i.test(target)) { execFile("explorer.exe", [target], { windowsHide: true }, () => {}); return true; }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) || /^shell:/i.test(target)) throw new Error("only http and https links are allowed");
  if (admin && WIN) {
    const r = await psEnv("try { Start-Process -FilePath $env:ND_T -Verb RunAs; exit 0 } catch { exit 5 }", { ND_T: target }, 60000);
    if (!r.ok) throw new Error("not started - the windows permission was declined");
    return true;
  }
  const err = await shell.openPath(target);
  if (err) throw new Error(err);
  return true;
}
const favCache = new Map();
function fetchIcon(url, hops) { // a website's own icon as a small picture, or "" when there is none
  return new Promise(resolve => {
    let done = false; const fin = v => { if (!done) { done = true; resolve(v); } };
    try {
      const req = https.get(url, { timeout: 6000, headers: { "User-Agent": "Mozilla/5.0 Nightdeck" } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) {
          res.resume(); let next = "";
          try { next = new URL(res.headers.location, url).href; } catch (e) {}
          if (!/^https:/i.test(next)) return fin("");
          return fetchIcon(next, hops - 1).then(fin);
        }
        const type = String(res.headers["content-type"] || "").split(";")[0].trim();
        if (res.statusCode !== 200 || !/^image\//i.test(type)) { res.resume(); return fin(""); }
        const chunks = []; let n = 0;
        res.on("data", c => { n += c.length; if (n > 60000) { req.destroy(); fin(""); } else chunks.push(c); });
        res.on("end", () => fin(n ? "data:" + type + ";base64," + Buffer.concat(chunks).toString("base64") : ""));
        res.on("error", () => fin(""));
      });
      req.on("error", () => fin("")); req.on("timeout", () => { req.destroy(); fin(""); });
    } catch (e) { fin(""); }
  });
}
async function launchIcon(target) {
  target = String(target);
  if (/^https?:\/\//i.test(target)) {
    let origin = ""; try { origin = new URL(target).origin; } catch (e) {}
    if (!/^https:/i.test(origin)) return "";
    if (!favCache.has(origin)) favCache.set(origin, await fetchIcon(origin + "/favicon.ico", 3));
    return favCache.get(origin);
  }
  if (/^shell:/i.test(target)) return "";
  let file = target;
  if (WIN && /\.lnk$/i.test(file)) { try { const l = shell.readShortcutLink(file); if (l.target && fs.existsSync(l.target)) file = l.target; } catch (e) {} }
  return fs.existsSync(file) ? await fileIcon(file) : "";
}
let appsCache = { t: 0, list: null };
async function installedApps() { // what the Windows Start menu lists
  if (!WIN) throw new Error("only available on Windows");
  if (appsCache.list && Date.now() - appsCache.t < 60000) return appsCache.list;
  const roots = [path.join(process.env.ProgramData || "C:\\ProgramData", "Microsoft", "Windows", "Start Menu", "Programs"),
    path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs")];
  const found = new Map(), skip = /\b(uninstall|deinstall|readme|license|help|documentation|manual|website|release notes)\b/i;
  const walk = (dir, depth) => {
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 4 && !/^(startup|autostart)$/i.test(e.name)) walk(p, depth + 1); }
      else if (/\.lnk$/i.test(e.name)) {
        const name = e.name.replace(/\.lnk$/i, "");
        if (!skip.test(name) && !found.has(name.toLowerCase())) found.set(name.toLowerCase(), { name, target: p });
      }
    }
  };
  for (const r of roots) walk(r, 0);
  const list = [...found.values()];
  await Promise.all(list.map(async a => {
    let file = a.target;
    try {
      const l = shell.readShortcutLink(a.target);
      if (l.target) { if (/\.(chm|url|txt|html?|pdf)$/i.test(l.target)) { a.drop = true; return; } if (fs.existsSync(l.target)) file = l.target; }
    } catch (e) {}
    a.icon = await fileIcon(file);
  }));
  try { // Microsoft Store apps (Windows does not hand out their icons this way)
    const r = await psEnv("$ErrorActionPreference='SilentlyContinue'; ConvertTo-Json -Compress -InputObject @(Get-StartApps | Where-Object { $_.AppID -like '*!*' } | Select-Object Name,AppID)", null, 20000);
    for (const s of [].concat(JSON.parse(r.out || "[]") || [])) {
      if (!s || !s.Name || !/^[\w.!\-]+$/.test(String(s.AppID)) || found.has(String(s.Name).toLowerCase())) continue;
      list.push({ name: String(s.Name), target: "shell:AppsFolder\\" + s.AppID, icon: "" });
    }
  } catch (e) {}
  const out = list.filter(a => !a.drop).map(a => ({ name: a.name, target: a.target, icon: a.icon || "" })).sort((a, b) => a.name.localeCompare(b.name));
  appsCache = { t: Date.now(), list: out };
  return out;
}
let launchKeys = [], launchKeysOn = [];
const LACCEL = /^((Control|Ctrl|Alt|Shift|Super)\+)+([A-Za-z0-9]|F\d{1,2})$/i;
function registerLaunchKeys() { // returns the hotkeys Windows did not accept
  for (const a of launchKeysOn) { try { globalShortcut.unregister(a); } catch (e) {} }
  launchKeysOn = []; const bad = [];
  for (const k of launchKeys) {
    let ok = false;
    try {
      const own = settings && settings.hotkey && String(settings.accel).toLowerCase() === k.accel.toLowerCase();
      if (LACCEL.test(k.accel) && !own && !globalShortcut.isRegistered(k.accel))
        ok = globalShortcut.register(k.accel, () => { launchTarget(k.target, k.admin).catch(() => {}); });
    } catch (e) {}
    if (ok) launchKeysOn.push(k.accel); else bad.push(k.accel);
  }
  return bad;
}

// ---- Power extras: timer, power plans, keep awake ----
const POWER_TIMED = new Set(["shutdown", "restart", "sleep", "hibernate", "lock"]);
let powerSched = null, powerSchedT = null, powerWarnT = null, awakeId = null;
function powerTimer(cmd, action, at) { // the timer lives here, so it keeps running when the window reloads
  if (cmd === "get") return powerSched;
  clearTimeout(powerSchedT); clearTimeout(powerWarnT); powerSched = null;
  if (cmd === "cancel") return null;
  if (cmd !== "set" || !POWER_TIMED.has(action)) throw new Error("unexpected request");
  at = Number(at); const wait = at - Date.now();
  if (!(wait > 0 && wait <= 24 * 3600 * 1000 + 60000)) throw new Error("the time must be within the next 24 hours");
  powerSched = { action, at };
  powerSchedT = setTimeout(() => { powerSched = null; Promise.resolve(API.power(action)).catch(() => {}); }, wait);
  if (wait > 70000) powerWarnT = setTimeout(() => {
    try { new Notification({ title: "Nightdeck", body: "Timer: " + action + " in one minute. Open the power tab to cancel." }).show(); } catch (e) {}
  }, wait - 60000);
  return powerSched;
}
async function powerPlans() {
  if (!WIN) return { list: [], msg: "only available on Windows" };
  const r = await run("powercfg.exe", ["/list"], 10000), list = [];
  const re = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\s+\((.+?)\)\s*(\*)?/gi; let m;
  while ((m = re.exec(r.out))) list.push({ id: m[1].toLowerCase(), name: m[2], active: !!m[3] });
  return { list };
}
async function powerPlan(id) {
  id = String(id).toLowerCase();
  const p = await powerPlans();
  if (!p.list.some(x => x.id === id)) throw new Error("unknown power plan");
  const r = await run("powercfg.exe", ["/setactive", id], 10000);
  return { ok: r.ok, msg: r.ok ? "" : (r.err || r.out || "windows did not accept the change").trim().split(/\r?\n/)[0] };
}
function keepAwake(on) { // stops the PC and the screens from going to sleep while Nightdeck runs
  if (on === undefined || on === null) return awakeId !== null;
  if (on && awakeId === null) awakeId = powerSaveBlocker.start("prevent-display-sleep");
  if (!on && awakeId !== null) { try { powerSaveBlocker.stop(awakeId); } catch (e) {} awakeId = null; }
  return awakeId !== null;
}
const API = {
  sysExtra,
  powerTimer, powerPlans, powerPlan, keepAwake,
  sys() {
    const cpus = os.cpus();
    const disks = listDisks(), disk = disks[0] || null;
    return {
      cpu: cpuPercent(), memTotal: os.totalmem(), memFree: os.freemem(), uptime: os.uptime(), disk, disks,
      host: os.hostname(), cpuModel: cpus[0] ? cpus[0].model.trim() : "unknown", cores: cpus.length,
      system: (os.version ? os.version() : os.type()) + " (" + os.arch() + ")"
    };
  },
  temps: readTemps,
  rates: currencyRates,
  audioDevices, audioDefault, micMute, appVolumes, appVolume, nightLight, radios: () => radios(), radioSet: (k, on) => radios(String(k), !!on),
  wallpaper, cleanCats, cleanCat, drives: () => listDisks(), openDrive, openSetting, backupSave, backupLoad, appRestart,
  volume, brightness, switchesGet, switchSet, cleanScan, cleanTemp, cleanBin, settingsGet, settingSet,
  procs: listProcs,
  startupList, startupSet, showFile,
  kill: killProc,
  net() {
    const adapters = [], ifs = os.networkInterfaces();
    for (const name in ifs) for (const a of ifs[name]) if (a.family === "IPv4" && !a.internal) adapters.push({ name, address: a.address });
    return { host: os.hostname(), adapters };
  },
  async netcheck() {
    const [a, b, ip] = await Promise.all([tcpTime("1.1.1.1"), tcpTime("8.8.8.8"), publicIp()]);
    return { a, b, publicIp: ip };
  },
  ping: () => tcpTime("1.1.1.1"),
  netRate, netDetails, speedTest, netFix, netDevices,
  async pick(kind) {
    const r = await dialog.showOpenDialog(main, { properties: [kind === "folder" ? "openDirectory" : "openFile"] });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  },
  launch: (target, admin) => launchTarget(target, admin),
  launchIcon, installedApps,
  launchHotkeys(list) {
    launchKeys = [].concat(list || []).slice(0, 50).map(k => ({ accel: String(k.accel), target: String(k.target), admin: !!k.admin, name: String(k.name || "") }));
    return registerLaunchKeys();
  },
  async power(action) {
    if (!WIN) return { ok: false, msg: "only available on Windows" };
    const cmds = {
      lock: ["rundll32.exe", ["user32.dll,LockWorkStation"]],
      sleep: ["rundll32.exe", ["powrprof.dll,SetSuspendState", "0,1,0"]],
      restart: ["shutdown.exe", ["/r", "/t", "0"]],
      shutdown: ["shutdown.exe", ["/s", "/t", "0"]],
      signout: ["shutdown.exe", ["/l"]],
      hibernate: ["shutdown.exe", ["/h"]],
      bios: ["shutdown.exe", ["/r", "/fw", "/t", "0"]],
      abort: ["shutdown.exe", ["/a"]],
      screenoff: ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "(Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool PostMessage(int hWnd, int msg, int wParam, int lParam);' -Name ScreenOff -Namespace Nightdeck -PassThru)::PostMessage(0xffff, 0x0112, 0xF170, 2) | Out-Null"]]
    };
    const c = cmds[action];
    if (!c) return { ok: false, msg: "unknown action" };
    if (action === "sleep" || action === "hibernate") {
      // The PC sleeps while this command runs. Waiting for it ended in a false "command failed" after waking up, so it is started without waiting.
      execFile(c[0], c[1], { windowsHide: true }, () => {});
      return { ok: true, msg: "" };
    }
    const r = await run(c[0], c[1], 15000);
    if (action === "bios" && !r.ok) return { ok: false, msg: "windows refused - this needs administrator rights, or this PC does not support it" };
    return { ok: r.ok, msg: r.ok ? "" : (r.err || "command failed").trim().split(/\r?\n/)[0] };
  },
  clips(q) {
    q = String(q || "").toLowerCase();
    const list = clips.filter(c => !q || (c.kind === "text" ? c.text.toLowerCase().includes(q) : "picture image".includes(q)));
    return { cfg: clipCfg, total: clips.length, items: list.slice().sort((a, b) => Number(b.pinned) - Number(a.pinned))
      .map(c => ({ id: c.id, kind: c.kind, text: c.text.slice(0, 300), len: c.text.length, thumb: c.thumb || "", w: c.w || 0, h: c.h || 0, time: c.time, pinned: c.pinned })) };
  },
  clipCopy(id) {
    const c = clips.find(x => x.id === id); if (!c) return false;
    if (c.kind === "image") { clipboard.writeImage(c.img); lastImg = c.sig; lastClip = ""; } else { lastClip = c.text; clipboard.writeText(c.text); }
    c.time = Date.now(); clips = [c].concat(clips.filter(x => x !== c)); clipSave(); return true;
  },
  clipDelete(id) { clips = clips.filter(c => c.id !== id); clipSave(); return true; },
  clipPin(id) { const c = clips.find(x => x.id === id); if (!c) return false; c.pinned = !c.pinned; clipTrim(); clipSave(); return c.pinned; },
  clipSet(o) {
    o = o || {};
    if ([25, 50, 100].includes(o.max)) clipCfg.max = o.max;
    if (typeof o.keep === "boolean") clipCfg.keep = o.keep;
    if (typeof o.paused === "boolean") clipCfg.paused = o.paused;
    clipTrim(); clipSave(); return clipCfg;
  },
  // changes an entry (capitals, small letters, tidy spaces, plain text) and puts the result on the clipboard
  clipTool(id, op) {
    const c = clips.find(x => x.id === id); if (!c || c.kind !== "text") return false;
    const t = op === "upper" ? c.text.toUpperCase() : op === "lower" ? c.text.toLowerCase()
      : op === "trim" ? c.text.split(/\r?\n/).map(l => l.replace(/[ \t]+/g, " ").trim()).join("\n").trim() : c.text;
    if (!t) return false;
    lastClip = t; clipboard.writeText(t); clipAddText(t); return true;
  },
  // Clears this app's list (pinned entries stay), the current clipboard, and the Windows clipboard history (Win + V).
  async clipClear() {
    clips = clips.filter(c => c.pinned); clipSave();
    try { clipboard.clear(); lastClip = ""; lastImg = ""; } catch (e) {}
    if (!WIN) return { windows: false };
    const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "[Windows.ApplicationModel.DataTransfer.Clipboard,Windows.ApplicationModel.DataTransfer,ContentType=WindowsRuntime] | Out-Null; " +
      "[Windows.ApplicationModel.DataTransfer.Clipboard]::ClearHistory()"], 15000);
    return { windows: r.ok && /true/i.test(r.out) };
  },
  // notes: a backup copy next to the app's settings, plus saving and opening text files
  notesBackup(json) {
    json = String(json); if (json.length > 5000000) throw new Error("the notes are too large to back up");
    JSON.parse(json); fs.writeFileSync(path.join(app.getPath("userData"), "notes-backup.json"), json); return true;
  },
  notesRestore() { try { const j = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "notes-backup.json"), "utf8")); return Array.isArray(j) ? j : null; } catch (e) { return null; } },
  async notesExport(title, text) {
    const safe = String(title || "note").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 60) || "note";
    const r = await dialog.showSaveDialog(main, { defaultPath: path.join(app.getPath("documents"), safe + ".txt"), filters: [{ name: "Text", extensions: ["txt"] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, String(text).replace(/\r?\n/g, WIN ? "\r\n" : "\n"), "utf8"); return r.filePath;
  },
  async notesImport() {
    const r = await dialog.showOpenDialog(main, { properties: ["openFile"], filters: [{ name: "Text", extensions: ["txt", "md", "log", "csv"] }] });
    if (r.canceled || !r.filePaths.length) return null;
    const f = r.filePaths[0]; if (fs.statSync(f).size > 1048576) throw new Error("that file is larger than 1 MB");
    return { name: path.basename(f).replace(/\.[^.]+$/, "").slice(0, 60), text: fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n") };
  },
  clipRead() { try { return clipboard.readText(); } catch (e) { return ""; } },
  copyText(t) { t = String(t); lastClip = t; clipboard.writeText(t); return true; },
  timerDone(label, quiet) { // quiet: the window plays its own sound
    if (!quiet) { try { shell.beep(); } catch (e) {} }
    if (main && !main.isDestroyed()) { main.flashFrame(true); setTimeout(() => { if (main && !main.isDestroyed()) main.flashFrame(false); }, 4000); }
    try { if (Notification.isSupported()) new Notification({ title: "Nightdeck", body: String(label || "Timer finished") }).show(); } catch (e) {}
    return true;
  },
  capShot, capGrab, capSave, capSources, capList, capDo, capSet, recStart, recChunk, recStop,
  betaGet, betaSet, profSave, profApply, profDelete, gameMode, gpuStats, monitors, screenMode, usageGet, usageReset,
  async openShots() { fs.mkdirSync(shotsDir(), { recursive: true }); const err = await shell.openPath(shotsDir()); if (err) throw new Error(err); return true; }
};
ipcMain.handle("nd-api", async (event, name, ...args) => {
  if (!Object.prototype.hasOwnProperty.call(API, name)) throw new Error("unknown request");
  return API[name](...args);
});

ipcMain.on("nd-log-clear", () => { history = []; });

ipcMain.on("nd-log", (event, msg) => {
  pushLog(String(msg));
});

// Software rendering avoids leftover "ghost" pixels while resizing.
app.disableHardwareAcceleration();
app.setAppUserModelId("Nightdeck.Utility");
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", showAll);
app.on("before-quit", () => { quitting = true; });
app.on("will-quit", () => { try { globalShortcut.unregisterAll(); } catch (e) {} try { if (netPs) netPs.kill(); } catch (e) {} try { if (watchPs) watchPs.kill(); } catch (e) {} if (betaDirty) saveBeta(); });
app.whenReady().then(() => { loadSettings(); createWindows(); applyTray(); capLoad(); applyHotkey(); clipLoad(); setInterval(pollClipboard, 1000); betaInit(); });
app.on("window-all-closed", () => app.quit());
