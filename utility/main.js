const { app, BrowserWindow, Menu, shell, ipcMain, screen, clipboard, dialog, desktopCapturer, Notification, Tray, globalShortcut, powerSaveBlocker } = require("electron");
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
  const startHidden = process.argv.includes("--startup") && settings.tray;
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

// ---- Screenshot ----
const shotsDir = () => path.join(app.getPath("pictures"), "Nightdeck Screenshots");
async function screenshot(hide) {
  const d = screen.getPrimaryDisplay();
  const size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
  const conWasVisible = con && !con.isDestroyed() && con.isVisible();
  if (hide) { if (conWasVisible) con.hide(); main.hide(); await new Promise(r => setTimeout(r, 400)); }
  try {
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
    const src = sources.find(x => String(x.display_id) === String(d.id)) || sources[0];
    if (!src || src.thumbnail.isEmpty()) throw new Error("the screen could not be captured");
    fs.mkdirSync(shotsDir(), { recursive: true });
    const n = new Date(), pad = x => String(x).padStart(2, "0");
    const file = path.join(shotsDir(), "shot-" + n.getFullYear() + pad(n.getMonth() + 1) + pad(n.getDate()) + "-" +
      pad(n.getHours()) + pad(n.getMinutes()) + pad(n.getSeconds()) + ".png");
    fs.writeFileSync(file, src.thumbnail.toPNG());
    const sz = src.thumbnail.getSize();
    return { file, width: sz.width, height: sz.height };
  } finally {
    if (hide && main && !main.isDestroyed()) { main.show(); if (conWasVisible && con && !con.isDestroyed()) { sync(); con.showInactive(); } }
  }
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
        if (last.ok) break;
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
  showHidden: { key: HKCU + "Explorer\\Advanced", name: "Hidden", on: 1, off: 2 }
};
async function switchesGet() {
  if (!WIN) return { ok: false, msg: "only available on Windows" };
  const out = { ok: true };
  for (const id in SWITCHES) {
    const sw = SWITCHES[id], r = await run("reg.exe", ["query", sw.key, "/v", sw.name]);
    const m = /REG_DWORD\s+0x([0-9a-f]+)/i.exec(r.out);
    out[id] = m ? parseInt(m[1], 16) === sw.on : false;
  }
  return out;
}
async function switchSet(id, on) {
  if (!WIN) return { ok: false, msg: "only available on Windows" };
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
  globalShortcut.unregisterAll(); hotkeyOk = false; setTimeout(registerLaunchKeys, 0); // the shortcut hotkeys are put back right after
  if (settings.hotkey && ACCEL.test(settings.accel)) { try { hotkeyOk = globalShortcut.register(settings.accel, toggleAll); } catch (e) { hotkeyOk = false; } }
}
const LOGIN_ARGS = ["--startup"];
function settingsGet() {
  let login = false; try { login = app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin; } catch (e) {}
  return { tray: settings.tray, trayOk: !settings.tray || !!tray, hotkey: settings.hotkey, hotkeyOk, accel: settings.accel, login };
}
function settingSet(key, value) {
  if (key === "tray") { settings.tray = !!value; applyTray(); }
  else if (key === "hotkey") { settings.hotkey = !!value; applyHotkey(); }
  else if (key === "accel") { value = String(value).trim(); if (!ACCEL.test(value)) throw new Error("use a combination like Control+Alt+N"); settings.accel = value; applyHotkey(); }
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
  screenshot: hide => screenshot(!!hide),
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
app.on("will-quit", () => { try { globalShortcut.unregisterAll(); } catch (e) {} try { if (netPs) netPs.kill(); } catch (e) {} });
app.whenReady().then(() => { loadSettings(); createWindows(); applyTray(); applyHotkey(); clipLoad(); setInterval(pollClipboard, 1000); });
app.on("window-all-closed", () => app.quit());
