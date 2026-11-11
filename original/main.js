const { app, BrowserWindow, Menu, shell, ipcMain, screen } = require("electron");
const path = require("path");
const fs = require("fs");
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
  const web = { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true };
  let start = pairStart(), size = { width: MW, height: MH }, showConsole = true;
  try {
    const st = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    fs.unlinkSync(stateFile());
    start = { x: st.bounds.x, y: st.bounds.y }; size = { width: st.bounds.width, height: st.bounds.height };
    showConsole = st.console !== false;
  } catch (e) {}
  main = new BrowserWindow({
    x: start.x, y: start.y, width: size.width, height: size.height, minWidth: 700, minHeight: 480,
    titleBarStyle: "hidden", maximizable: false, icon: ICON, backgroundColor: "#15191d", title: "Nightdeck", webPreferences: web
  });
  con = new BrowserWindow({
    parent: main, x: start.x + size.width + GAP, y: start.y, width: CW, height: size.height,
    icon: ICON, frame: false, resizable: false, minimizable: false, maximizable: false, skipTaskbar: true, show: false,
    backgroundColor: "#15191d", title: "Nightdeck Console", webPreferences: web
  });
  Menu.setApplicationMenu(null);
  main.loadFile(path.join(__dirname, "index.html"));
  con.loadFile(path.join(__dirname, "console.html"));

  con.webContents.on("did-finish-load", () => {
    conReady = true;
    history.forEach(m => con.webContents.send("nd-log", m));
  });
  con.once("ready-to-show", () => { sync(); if (showConsole) { con.show(); main.focus(); } });

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
    if (con.isVisible()) con.hide();
    else { sync(); con.showInactive(); }
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

ipcMain.on("nd-log-clear", () => { history = []; });

ipcMain.on("nd-log", (event, msg) => {
  pushLog(String(msg));
});

// Software rendering avoids leftover "ghost" pixels while resizing.
app.disableHardwareAcceleration();
app.whenReady().then(createWindows);
app.on("window-all-closed", () => app.quit());
