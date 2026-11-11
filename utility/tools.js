/* Nightdeck Utility - the tools behind each tab. */
(function () {
  const ND = window.nightdeckWindow || {};
  const api = (n, ...a) => ND.api ? ND.api(n, ...a) : Promise.reject(new Error("only available in the app"));
  const $c = id => document.querySelector('[data-custom="' + id + '"]');
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === "class") e.className = props[k];
      else if (k === "text") e.textContent = props[k];
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), props[k]);
      else e.setAttribute(k, props[k]);
    }
    for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
    return e;
  }
  const store = {
    get(k, d) { try { const v = localStorage.getItem("ndu-" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("ndu-" + k, JSON.stringify(v)); } catch (e) {} }
  };
  const gb = b => (b / 1073741824).toFixed(1);
  const size = b => b >= 1073741824 ? gb(b) + " GB" : Math.round(b / 1048576) + " MB";
  const btn = (text, onclick, cls) => h("button", { class: "nd-btn" + (cls ? " " + cls : ""), text, onclick });
  const log = m => panel.log(m);

  let active = null;
  const onTab = {};
  window.ndTabChanged = name => { active = name; store.set("tab", name); if (onTab[name]) onTab[name](); };

  /* ---------- footer buttons ---------- */
  (function () {
    const foot = document.querySelector(".nd-foot"), ver = foot.querySelector("small");
    const old = foot.querySelector('[data-act="reset"]'); if (old) old.remove(); // no on/off settings in the utility
    const add = (text, title, fn) => { const b = btn(text, fn); b.title = title; foot.insertBefore(b, ver); };
    add("reset layout", "Restore the original window size", () => { if (ND.resetSize) ND.resetSize(); log("window layout reset"); });
    add("console", "Show or hide the console", () => { if (ND.toggleConsole) ND.toggleConsole(); });
    add("update", "Load the latest changes", () => { if (ND.update) ND.update(); });
    document.querySelector(".nd-menu").append(document.querySelector(".nd-wc"));
    document.querySelector(".nd-wc").addEventListener("click", e => {
      const b = e.target.closest("button"); if (b && ND[b.dataset.w]) ND[b.dataset.w]();
    });
  })();

  /* ---------- system ---------- */
  (function () {
    if (!ND.api) { panel.setInfo("host", "only available in the app"); return; }
    const dur = s => { const d = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + "d " : "") + hh + "h " + String(m).padStart(2, "0") + "m " + String(Math.floor(s % 60)).padStart(2, "0") + "s"; };
    let first = true, warned = false, battery = null;
    if (navigator.getBattery) navigator.getBattery().then(b => { battery = b; }).catch(() => {});
    async function tick() {
      try {
        const s = await api("sys");
        const used = s.memTotal - s.memFree, memPct = used / s.memTotal * 100;
        panel.setMeter("cpu", s.cpu);
        panel.setMeter("mem", memPct, gb(used) + " / " + gb(s.memTotal) + " GB");
        if (s.disk) panel.setMeter("disk", (s.disk.total - s.disk.free) / s.disk.total * 100, gb(s.disk.free) + " GB free of " + Math.round(s.disk.total / 1073741824) + " GB");
        else panel.setMeter("disk", 0, "not available");
        if (battery) panel.setMeter("battery", battery.level * 100, Math.round(battery.level * 100) + "%" + (battery.charging ? " - plugged in" : " - on battery"), battery.level <= 0.15 && !battery.charging);
        else panel.setMeter("battery", 0, "not available");
        panel.setInfo("uptime", dur(s.uptime));
        if (first) {
          first = false;
          panel.setInfo("host", s.host); panel.setInfo("os", s.system);
          panel.setInfo("cpumodel", s.cpuModel); panel.setInfo("cores", String(s.cores));
          log("system monitor started - " + s.cores + " cores, " + gb(s.memTotal) + " GB memory");
        }
        if (memPct >= 90 && !warned) { warned = true; log("warning: memory above 90%"); }
        if (memPct < 85) warned = false;
      } catch (e) { if (first) { first = false; log("system monitor error: " + e.message); } }
    }
    // temperatures: 0-100 degrees C on the bar, so it turns red above 50 and gold at 100
    async function temps() {
      try {
        const t = await api("temps");
        if (t.system != null) panel.setMeter("temp", t.system, Math.round(t.system) + " \u00b0C"); else panel.setMeter("temp", 0, "not reported by this PC");
        if (t.gpu != null) panel.setMeter("gputemp", t.gpu, Math.round(t.gpu) + " \u00b0C"); else panel.setMeter("gputemp", 0, "not reported by this PC");
        if (!temps.logged) { temps.logged = true; log("temperature: system " + (t.system != null ? Math.round(t.system) + " C" : "not available") + ", gpu " + (t.gpu != null ? Math.round(t.gpu) + " C (" + t.gpuName + ")" : "not available" + (t.gpuError ? " - " + t.gpuError : ""))); }
      } catch (e) {}
    }
    temps(); setInterval(() => { if (active === "system") temps(); }, 5000);
    tick(); setInterval(tick, 1000);
  })();

  /* ---------- running apps ---------- */
  (function () {
    const root = $c("apps"); if (!root) return;
    let sort = store.get("procsort", "mem"), data = [], pending = null, force = false, busy = false;
    const status = h("span", { class: "nd-dim" });
    const bMem = btn("memory", () => setSort("mem")), bCpu = btn("cpu", () => setSort("cpu"));
    const list = h("div", { class: "nd-table" });
    root.append(h("div", { class: "nd-row" }, h("span", { class: "nd-dim", text: "sort by" }), bMem, bCpu, status), list);
    function setSort(s) { sort = s; store.set("procsort", s); render(); }
    function render() {
      bMem.classList.toggle("nd-on", sort === "mem"); bCpu.classList.toggle("nd-on", sort === "cpu");
      list.textContent = "";
      list.append(h("div", { class: "nd-tr nd-th" }, h("span", { text: "program" }), h("span", { text: "cpu" }), h("span", { text: "memory" }), h("span")));
      const rows = [...data].sort((a, b) => sort === "cpu" ? (b.cpu || 0) - (a.cpu || 0) : b.mem - a.mem).slice(0, 14);
      for (const p of rows) {
        let action;
        if (p.protected) action = h("span", { class: "nd-dim", text: "system" });
        else if (pending === p.name) action = h("span", { class: "nd-row" },
          btn(force ? "force" : "yes", () => kill(p.name), "nd-danger"), btn("no", () => { pending = null; force = false; render(); }));
        else action = btn("close", () => { pending = p.name; force = false; render(); });
        list.append(h("div", { class: "nd-tr" },
          h("span", { class: "nd-app", title: p.name },
            p.icon ? h("img", { class: "nd-appicon", src: p.icon, alt: "" }) : h("i", { class: "nd-appicon nd-noicon" }),
            p.name + (p.count > 1 ? " (" + p.count + ")" : "")),
          h("span", { text: p.cpu == null ? "..." : p.cpu.toFixed(1) + "%" }), h("span", { text: size(p.mem) }), action));
      }
    }
    async function kill(name) {
      const f = force;
      try {
        const r = await api("kill", name, f);
        if (r.ok) { log((f ? "force closed " : "asked to close ") + name); pending = null; force = false; }
        else if (!f) { force = true; log(name + " did not close normally - press force to end it (unsaved work is lost)"); }
        else { log("could not close " + name + ": " + r.msg); pending = null; force = false; }
      } catch (e) { log("close failed: " + e.message); pending = null; force = false; }
      render(); setTimeout(load, 900);
    }
    async function load() {
      if (busy) return; busy = true;
      try { data = await api("procs"); status.textContent = data.length + " programs running"; render(); }
      catch (e) { status.textContent = e.message; }
      busy = false;
    }
    onTab.apps = load;
    setInterval(() => { if (active === "apps") load(); }, 3000);
  })();

  /* ---------- network ---------- */
  (function () {
    const root = $c("network"); if (!root) return;
    const info = h("div", { class: "nd-kv" }), details = h("div", { class: "nd-kv" }), result = h("div", { class: "nd-kv" }), confirm = h("div", { class: "nd-row" });
    const copy = t => api("copyText", t).then(() => log("copied " + t)).catch(e => log("copy failed: " + e.message));
    const row = (k, v, canCopy) => h("div", { class: "nd-info" }, h("span", { text: k }),
      canCopy ? h("span", { class: "nd-row nd-ipcopy" }, h("output", { text: v }), btn("copy", () => copy(v))) : h("output", { text: v }));
    const sub = t => h("div", { class: "nd-sub", text: t });
    const rate = b => b >= 1048576 ? (b / 1048576).toFixed(1) + " MB/s" : Math.round(b / 1024) + " KB/s";
    const mbit = b => (b / 1e6).toFixed(b >= 1e8 ? 0 : 1) + " Mbit/s";

    // live download / upload bars. Full bar = 125% of the fastest speed seen (or of the last speed test).
    const meter = (id, label) => h("div", { class: "nd-meter", "data-meter": id }, h("div", null, label, h("output", { text: "..." })), h("div", { class: "nd-meterbar" }, h("i")));
    let peakD = 0, peakU = 0, best = store.get("netbest", { down: 0, up: 0 }), tBusy = false;
    async function traffic() {
      if (tBusy) return; tBusy = true;
      try {
        const r = await api("netRate");
        if (r.down == null) { panel.setMeter("netdown", 0, "..."); panel.setMeter("netup", 0, "..."); }
        else {
          peakD = Math.max(peakD, r.down); peakU = Math.max(peakU, r.up);
          panel.setMeter("netdown", r.down / Math.max(1048576, 1.25 * Math.max(peakD, best.down || 0)) * 100, rate(r.down));
          panel.setMeter("netup", r.up / Math.max(262144, 1.25 * Math.max(peakU, best.up || 0)) * 100, rate(r.up));
        }
      } catch (e) { panel.setMeter("netdown", 0, e.message); panel.setMeter("netup", 0, ""); }
      tBusy = false;
    }

    // live ping with a small history line
    const pingOut = h("output", { text: "..." }), spark = h("canvas", { class: "nd-spark" }), hist = [];
    let pBusy = false;
    function drawSpark() {
      const w = spark.clientWidth, hh = spark.clientHeight; if (!w || !hh) return;
      const dpr = window.devicePixelRatio || 1; spark.width = Math.round(w * dpr); spark.height = Math.round(hh * dpr);
      const g = spark.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, hh);
      const vals = hist.filter(v => v != null); if (!hist.length) return;
      const top = Math.max(50, ...vals) * 1.15, stepX = w / 59, X = i => w - 2 - (hist.length - 1 - i) * stepX, Y = v => hh - 3 - v / top * (hh - 6);
      g.strokeStyle = "#4fc3d9"; g.lineWidth = 1.5; g.beginPath(); let pen = false;
      hist.forEach((v, i) => {
        if (v == null) { pen = false; g.fillStyle = "#d6564a"; g.fillRect(X(i) - 1, hh - 5, 2, 5); return; }
        if (pen) g.lineTo(X(i), Y(v)); else g.moveTo(X(i), Y(v)); pen = true;
      });
      g.stroke();
    }
    async function ping() {
      if (pBusy) return; pBusy = true;
      let ms = null; try { ms = await api("ping"); } catch (e) {}
      hist.push(ms); if (hist.length > 60) hist.shift();
      const vals = hist.filter(v => v != null);
      pingOut.textContent = (ms == null ? "no reply" : ms + " ms") + (vals.length > 1 ? "   (lowest " + Math.min(...vals) + ", highest " + Math.max(...vals) + ")" : "");
      drawSpark(); pBusy = false;
    }
    if (window.ResizeObserver) new ResizeObserver(drawSpark).observe(spark);

    // connection details
    async function loadDetails() {
      details.textContent = ""; details.append(row("connection", "reading..."));
      try {
        const d = await api("netDetails"); details.textContent = "";
        if (d.msg) { details.append(row("connection", d.msg)); return; }
        if (!d.adapters.length) details.append(row("connection", "no active adapter"));
        for (const a of d.adapters) {
          details.append(row("connection", a.kind + " - " + a.name));
          if (a.device) details.append(row("adapter", a.device));
          if (a.speed) details.append(row("link speed", a.speed));
          if (a.ssid) details.append(row("wi-fi network", a.ssid + (a.signal != null ? "  (" + a.signal + "% signal)" : "")));
          if (a.gateway) details.append(row("router", a.gateway, true));
          if (a.dns) details.append(row("dns servers", a.dns));
        }
      } catch (e) { details.textContent = ""; details.append(row("connection", e.message)); }
    }

    // buttons: check, speed test, quick fixes
    const ms = v => v == null ? "no reply" : v + " ms";
    const check = btn("check connection", async () => {
      check.disabled = true; confirm.textContent = ""; result.textContent = ""; result.append(row("checking", "..."));
      try {
        const r = await api("netcheck");
        result.textContent = "";
        result.append(row("reach 1.1.1.1", ms(r.a)), row("reach 8.8.8.8", ms(r.b)), r.publicIp ? row("public ip", r.publicIp, true) : row("public ip", "not available"));
        const up = r.a != null || r.b != null;
        log("connection check: " + (up ? "online, " + ms(r.a != null ? r.a : r.b) : "no internet reply"));
      } catch (e) { result.textContent = ""; result.append(row("check failed", e.message)); }
      check.disabled = false;
    });
    const speed = btn("speed test", async () => {
      speed.disabled = true; confirm.textContent = ""; result.textContent = ""; result.append(row("speed test", "measuring, about 15 seconds..."));
      try {
        const r = await api("speedTest");
        result.textContent = "";
        result.append(row("download", mbit(r.down)), row("upload", r.up == null ? "not measured" : mbit(r.up)), row("data used", size(r.bytes)));
        best = { down: r.down / 8, up: (r.up || 0) / 8 }; store.set("netbest", best);
        log("speed test: " + mbit(r.down) + " down" + (r.up != null ? ", " + mbit(r.up) + " up" : ""));
      } catch (e) { result.textContent = ""; result.append(row("speed test failed", e.message)); log("speed test failed: " + e.message); }
      speed.disabled = false;
    });
    async function fix(kind, label) {
      confirm.textContent = ""; result.textContent = ""; result.append(row(label, "working..."));
      let text;
      try { const r = await api("netFix", kind); text = r.ok ? "done" : r.msg; if (r.ok && kind === "renew") setTimeout(load, 2000); }
      catch (e) { text = e.message; }
      result.textContent = ""; result.append(row(label, text)); log(label + ": " + text);
    }
    const flush = btn("flush dns", () => fix("flushdns", "flush dns"));
    const renew = btn("renew ip", () => {
      confirm.textContent = "";
      confirm.append(h("span", { text: "renew the ip address? the connection can drop for a few seconds and windows may ask for permission." }),
        btn("yes, renew", () => fix("renew", "renew ip"), "nd-danger"), btn("cancel", () => { confirm.textContent = ""; }));
    });

    // devices on the local network
    const devList = h("div", { class: "nd-table" }), devNote = h("span", { class: "nd-dim", text: "looks for every device on your local network - takes a few seconds" });
    const scan = btn("scan devices", async () => {
      scan.disabled = true; devNote.textContent = "scanning, a few seconds...";
      try {
        const d = await api("netDevices");
        devList.textContent = "";
        devList.append(h("div", { class: "nd-tr nd-dev nd-th" }, h("span", { text: "address" }), h("span", { text: "name" }), h("span", { text: "hardware address" })));
        for (const x of d) devList.append(h("div", { class: "nd-tr nd-dev" }, h("span", { text: x.ip + (x.note ? "  (" + x.note + ")" : "") }), h("span", { text: x.name || "-", title: x.name || "" }), h("span", { text: x.mac })));
        devNote.textContent = d.length + (d.length === 1 ? " device" : " devices") + " found - devices that are switched off or asleep do not show up";
        log("network scan: " + d.length + (d.length === 1 ? " device" : " devices"));
      } catch (e) { devNote.textContent = e.message; }
      scan.disabled = false;
    });

    root.append(info, sub("live"), h("div", { class: "nd-two nd-netbars" }, meter("netdown", "download"), meter("netup", "upload")),
      h("div", { class: "nd-info" }, h("span", { text: "ping (1.1.1.1)" }), pingOut), spark,
      sub("connection"), details, h("div", { class: "nd-row" }, check, speed, flush, renew), confirm, result,
      sub("devices on your network"), h("div", { class: "nd-row" }, scan, devNote), devList);

    async function load() {
      info.textContent = "";
      info.append(row("status", navigator.onLine ? "online" : "offline"));
      try {
        const n = await api("net");
        info.append(row("computer", n.host));
        if (!n.adapters.length) info.append(row("local ip", "no active adapter"));
        for (const a of n.adapters) info.append(row(a.name, a.address, true));
      } catch (e) { info.append(row("adapters", e.message)); }
      loadDetails(); traffic(); ping();
    }
    onTab.network = load;
    setInterval(() => { if (active === "network") traffic(); }, 1000);
    setInterval(() => { if (active === "network") ping(); }, 3000);
    window.addEventListener("online", () => { log("network: online"); if (active === "network") load(); });
    window.addEventListener("offline", () => { log("network: offline"); if (active === "network") load(); });
  })();

  /* ---------- launcher ---------- */
  (function () {
    const root = $c("launcher"); if (!root) return;
    let items = store.get("launch", []);
    const grid = h("div", { class: "nd-grid" });
    const name = h("input", { class: "nd-input", placeholder: "name", maxlength: "40" });
    const target = h("input", { class: "nd-input nd-grow", placeholder: "path or website, e.g. https://example.com" });
    async function pick(kind) { try { const p = await api("pick", kind); if (p) { target.value = p; if (!name.value) name.value = p.split(/[\\/]/).filter(Boolean).pop().replace(/\.(exe|lnk)$/i, ""); } } catch (e) { log("browse failed: " + e.message); } }
    function add() {
      let t = target.value.trim(); if (!t) return;
      if (/^www\./i.test(t)) t = "https://" + t;
      items.push({ name: name.value.trim() || t, target: t }); store.set("launch", items);
      log("launcher: added " + (name.value.trim() || t)); name.value = ""; target.value = ""; render();
    }
    function render() {
      grid.textContent = "";
      if (!items.length) grid.append(h("span", { class: "nd-dim", text: "nothing here yet - add an app, folder or website below" }));
      items.forEach((it, i) => grid.append(h("div", { class: "nd-launch" },
        h("button", { class: "nd-btn", text: it.name, title: it.target, onclick: async () => {
          try { await api("launch", it.target); log("opened " + it.name); } catch (e) { log("could not open " + it.name + ": " + e.message); } } }),
        h("button", { class: "nd-btn", text: "x", title: "Remove", onclick: () => { items.splice(i, 1); store.set("launch", items); render(); } }))));
    }
    target.addEventListener("keydown", e => { if (e.key === "Enter") add(); });
    root.append(grid, h("div", { class: "nd-sub", text: "add a shortcut" }),
      h("div", { class: "nd-row" }, name, target),
      h("div", { class: "nd-row" }, btn("browse app or file", () => pick("file")), btn("browse folder", () => pick("folder")), btn("add", add, "nd-on")));
    render();
  })();

  /* ---------- power ---------- */
  (function () {
    const root = $c("power"); if (!root) return;
    const acts = [["lock", "lock"], ["sleep", "sleep"], ["restart", "restart"], ["shutdown", "shut down"]];
    const row = h("div", { class: "nd-row" }), confirm = h("div", { class: "nd-row" });
    let timer = null;
    function cancel() { clearTimeout(timer); confirm.textContent = ""; }
    for (const [id, label] of acts) row.append(btn(label, () => {
      cancel();
      confirm.append(h("span", { text: label + " this PC now?" }),
        btn("yes, " + label, async () => {
          cancel(); log("power: " + label + " requested");
          try { const r = await api("power", id); if (!r.ok) log("power: " + r.msg); } catch (e) { log("power failed: " + e.message); }
        }, "nd-danger"), btn("cancel", cancel));
      timer = setTimeout(cancel, 8000);
    }));
    root.append(row, confirm, h("span", { class: "nd-dim", text: "restart and shut down close every program - save your work first." }));
  })();

  /* ---------- clipboard ---------- */
  (function () {
    const root = $c("clipboard"); if (!root) return;
    const list = h("div", { class: "nd-table" }); let sig = "";
    root.append(h("div", { class: "nd-row" },
      h("span", { class: "nd-dim", text: "text you copy while nightdeck is open. kept in memory only. clear also empties the Windows history (Win + V)." }),
      btn("clear", async () => {
        try {
          const r = await api("clipClear");
          log(r && r.windows ? "clipboard cleared, including the Windows history (Win + V)" : "clipboard cleared here - the Windows history (Win + V) could not be cleared");
          load();
        } catch (e) { log("clear failed: " + e.message); }
      })), list);
    async function load() {
      let clips; try { clips = await api("clips"); } catch (e) { list.textContent = e.message; return; }
      const s = clips.map(c => c.time + c.text.length).join("|"); if (s === sig && list.childNodes.length) return; sig = s;
      list.textContent = "";
      if (!clips.length) list.append(h("span", { class: "nd-dim", text: "nothing copied yet" }));
      clips.forEach((c, i) => list.append(h("div", { class: "nd-clip", title: "click to copy again", onclick: async () => {
        try { await api("clipCopy", i); log("copied again: " + c.text.replace(/\s+/g, " ").slice(0, 40)); load(); } catch (e) {} } },
        h("i", { text: c.time + " " }), c.text.replace(/\s+/g, " ").slice(0, 120))));
    }
    onTab.clipboard = load;
    setInterval(() => { if (active === "clipboard") load(); }, 1500);
  })();

  /* ---------- notes ---------- */
  (function () {
    const root = $c("notes"); if (!root) return;
    const status = h("span", { class: "nd-dim", text: "saved automatically" });
    const ta = h("textarea", { class: "nd-input nd-notes", placeholder: "type your notes here...", spellcheck: "false" });
    ta.value = store.get("notes", ""); let t = null;
    ta.addEventListener("input", () => {
      status.textContent = "saving..."; clearTimeout(t);
      t = setTimeout(() => { store.set("notes", ta.value); status.textContent = "saved " + new Date().toTimeString().slice(0, 8); }, 400);
    });
    root.append(ta, status);
  })();

  /* ---------- timers ---------- */
  (function () {
    const root = $c("timers"); if (!root) return;
    const fmt = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); const hh = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
      return (hh ? hh + ":" : "") + String(m).padStart(2, "0") + ":" + String(ss).padStart(2, "0"); };
    const fmtSw = ms => { const t = Math.floor(ms / 100); return String(Math.floor(t / 600)).padStart(2, "0") + ":" + String(Math.floor(t / 10) % 60).padStart(2, "0") + "." + (t % 10); };
    const MAXCD = 359999000; // longest countdown: 99:59:59
    function parse(v) { v = v.trim(); if (!v) return 0; const p = v.split(":").map(Number); if (p.some(n => !isFinite(n) || n < 0)) return 0;
      if (p.length > 3) return 0;
      return Math.min(MAXCD, Math.round((p.length === 1 ? p[0] * 60 : p.length === 2 ? p[0] * 60 + p[1] : p[0] * 3600 + p[1] * 60 + p[2]) * 1000)); }
    // countdown
    if (String(store.get("cd", "5")).length > 8) store.set("cd", "5"); // drop an over-long saved value
    const cdIn = h("input", { class: "nd-input", value: store.get("cd", "5"), placeholder: "minutes or m:ss", size: "10", maxlength: "8" });
    const cdOut = h("div", { class: "nd-big", text: "00:00" });
    let cdLeft = 0, cdEnd = 0, cdRun = false;
    const cdGo = btn("start", () => {
      if (cdRun) { cdLeft = cdEnd - Date.now(); cdRun = false; }
      else { if (cdLeft <= 0) { cdLeft = parse(cdIn.value); store.set("cd", cdIn.value); if (cdLeft <= 0) { log("timer: enter minutes, or m:ss"); return; } log("timer started: " + fmt(cdLeft)); }
        cdEnd = Date.now() + cdLeft; cdRun = true; }
      draw();
    }, "nd-on");
    const cdReset = btn("reset", () => { cdRun = false; cdLeft = 0; draw(); });
    // stopwatch
    const swOut = h("div", { class: "nd-big", text: "00:00.0" });
    let swBase = 0, swStart = 0, swRun = false;
    const swGo = btn("start", () => { if (swRun) { swBase += Date.now() - swStart; swRun = false; log("stopwatch stopped at " + fmtSw(swBase)); } else { swStart = Date.now(); swRun = true; } draw(); }, "nd-on");
    const swReset = btn("reset", () => { swRun = false; swBase = 0; draw(); });
    function draw() {
      if (cdRun && Date.now() >= cdEnd) { cdRun = false; cdLeft = 0; log("timer finished"); api("timerDone", "Timer finished").catch(() => {}); }
      cdOut.textContent = fmt(cdRun ? cdEnd - Date.now() : cdLeft > 0 ? cdLeft : parse(cdIn.value));
      cdGo.textContent = cdRun ? "pause" : cdLeft > 0 ? "resume" : "start";
      swOut.textContent = fmtSw(swBase + (swRun ? Date.now() - swStart : 0));
      swGo.textContent = swRun ? "stop" : swBase ? "resume" : "start";
    }
    cdIn.addEventListener("input", draw);
    root.append(h("div", { class: "nd-two" },
      h("div", null, h("div", { class: "nd-sub", text: "countdown" }), cdOut, h("div", { class: "nd-row" }, cdIn, cdGo, cdReset)),
      h("div", null, h("div", { class: "nd-sub", text: "stopwatch" }), swOut, h("div", { class: "nd-row" }, swGo, swReset))));
    draw(); setInterval(draw, 100);
  })();

  /* ---------- screenshot ---------- */
  (function () {
    const root = $c("capture"); if (!root) return;
    const hide = h("input", { type: "checkbox" }); hide.checked = store.get("shothide", true);
    hide.addEventListener("change", () => store.set("shothide", hide.checked));
    const last = h("span", { class: "nd-dim", text: "screenshots are saved to Pictures > Nightdeck Screenshots" });
    const take = btn("take screenshot", async () => {
      take.disabled = true;
      try { const r = await api("screenshot", hide.checked); last.textContent = "saved: " + r.file; log("screenshot saved (" + r.width + " x " + r.height + ")"); }
      catch (e) { last.textContent = "screenshot failed: " + e.message; log("screenshot failed: " + e.message); }
      take.disabled = false;
    }, "nd-on");
    root.append(h("div", { class: "nd-row" }, take, btn("open folder", () => api("openShots").catch(e => log("could not open folder: " + e.message)))),
      h("label", { class: "nd-opt" }, hide, h("span"), "hide nightdeck while capturing"), last,
      h("span", { class: "nd-dim", text: "captures the main screen." }));
  })();

  /* ---------- calculators and converters ---------- */
  (function () {
    const root = $c("tools"); if (!root) return;
    const num = v => parseFloat(String(v).replace(",", "."));
    const show = v => isFinite(v) ? String(+v.toPrecision(12)) : "not a number";

    // ---- expression parser (no eval). Decimals: 1.5 or 1,5. Two-value functions use ";" ----
    function evaluate(src, opt) {
      opt = opt || {};
      const s = String(src).toLowerCase().replace(/\s+/g, "").replace(/×/g, "*").replace(/÷/g, "/").replace(/π/g, "pi").replace(/,/g, ".");
      if (!s) return null;
      let i = 0;
      const toRad = v => opt.deg ? v * Math.PI / 180 : v, fromRad = v => opt.deg ? v * 180 / Math.PI : v;
      const F1 = { sin: v => Math.sin(toRad(v)), cos: v => Math.cos(toRad(v)), tan: v => Math.tan(toRad(v)),
        asin: v => fromRad(Math.asin(v)), acos: v => fromRad(Math.acos(v)), atan: v => fromRad(Math.atan(v)),
        sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs,
        ln: Math.log, log: Math.log10, log2: Math.log2, exp: Math.exp, floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign };
      const F2 = { pow: Math.pow, mod: (a, b) => a % b, min: Math.min, max: Math.max, root: (a, n) => Math.pow(a, 1 / n) };
      const C = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };
      const fail = () => { throw new Error("bad expression"); };
      function fact(n) { if (n < 0 || n !== Math.floor(n) || n > 170) fail(); let r = 1; for (let k = 2; k <= n; k++) r *= k; return r; }
      function primary() {
        if (s[i] === "(") { i++; const v = expr(); if (s[i] !== ")") fail(); i++; return v; }
        const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/.exec(s.slice(i));
        if (m) { i += m[0].length; return parseFloat(m[0]); }
        const id = (/^[a-z][a-z0-9]*/.exec(s.slice(i)) || [null])[0]; if (!id) fail();
        i += id.length;
        if (F1[id] || F2[id]) {
          if (s[i] !== "(") fail(); i++;
          const a = expr(); let v;
          if (F2[id]) { if (s[i] !== ";") fail(); i++; v = F2[id](a, expr()); } else v = F1[id](a);
          if (s[i] !== ")") fail(); i++; return v;
        }
        if (opt.vars && Object.prototype.hasOwnProperty.call(opt.vars, id)) return opt.vars[id];
        if (Object.prototype.hasOwnProperty.call(C, id)) return C[id];
        fail();
      }
      function postfix() { let v = primary(); while (s[i] === "!") { i++; v = fact(v); } return v; }
      function power() { const b = postfix(); if (s[i] === "^") { i++; return Math.pow(b, unary()); } return b; }
      function unary() { if (s[i] === "-") { i++; return -unary(); } if (s[i] === "+") { i++; return unary(); } return power(); }
      function term() {
        let v = unary();
        for (;;) {
          const c = s[i];
          if (c === "*") { i++; v *= unary(); } else if (c === "/") { i++; v /= unary(); } else if (c === "%") { i++; v %= unary(); }
          else if (c === "(" || (c >= "a" && c <= "z")) v *= power(); // implicit multiplication: 2x, 3(4)
          else return v;
        }
      }
      function expr() { let v = term(); for (;;) { if (s[i] === "+") { i++; v += term(); } else if (s[i] === "-") { i++; v -= term(); } else return v; } }
      const v = expr(); if (i !== s.length) fail(); return v;
    }

    // ---- sub-menu ----
    const modes = ["standard", "scientific", "graphing", "programmer", "date", "converter", "colour"];
    const sections = {}, buttons = {}, onShow = {};
    const nav = h("div", { class: "nd-row nd-modes" });
    root.append(nav);
    function section(name, ...kids) { const d = h("div", { class: "nd-sec" }, kids); sections[name] = d; root.append(d); }
    function pick(name) {
      for (const m of modes) { sections[m].classList.toggle("nd-show", m === name); buttons[m].classList.toggle("nd-on", m === name); }
      store.set("toolmode", name); if (onShow[name]) onShow[name]();
    }

    // ---- standard ----
    function calcRow(placeholder, opt, label) {
      const inp = h("input", { class: "nd-input nd-grow", placeholder, spellcheck: "false" }), out = h("output", { class: "nd-result", text: "=" });
      const run = () => { try { const v = evaluate(inp.value, opt()); out.textContent = v == null ? "=" : "= " + (v === Infinity || v === -Infinity ? "cannot divide by zero" : show(v)); } catch (e) { out.textContent = "= ?"; } };
      inp.addEventListener("input", run);
      inp.addEventListener("keydown", e => { if (e.key === "Enter" && out.textContent.length > 2 && out.textContent !== "= ?") log(label + ": " + inp.value + " " + out.textContent); });
      return { inp, out, run };
    }
    const std = calcRow("e.g. (12,5 + 3) * 4", () => ({}), "calc");
    section("standard", h("div", { class: "nd-row" }, std.inp, std.out),
      h("span", { class: "nd-dim", text: "+  -  *  /  %  ^  ( )   -   press Enter to keep the result in the console" }));

    // ---- scientific ----
    let deg = store.get("deg", true);
    const sci = calcRow("e.g. sin(30) + sqrt(16) * pi", () => ({ deg }), "sci");
    const degBtn = btn("", () => { deg = !deg; store.set("deg", deg); degBtn.textContent = deg ? "degrees" : "radians"; sci.run(); });
    degBtn.textContent = deg ? "degrees" : "radians";
    const fnRow = h("div", { class: "nd-row nd-fns" });
    for (const f of ["sin(", "cos(", "tan(", "asin(", "acos(", "atan(", "sqrt(", "cbrt(", "ln(", "log(", "exp(", "abs(", "pi", "e", "^", "!", "(", ")"])
      fnRow.append(btn(f, () => { const a = sci.inp.selectionStart == null ? sci.inp.value.length : sci.inp.selectionStart; sci.inp.value = sci.inp.value.slice(0, a) + f + sci.inp.value.slice(sci.inp.selectionEnd == null ? a : sci.inp.selectionEnd); sci.inp.focus(); sci.inp.selectionStart = sci.inp.selectionEnd = a + f.length; sci.run(); }));
    section("scientific", h("div", { class: "nd-row" }, sci.inp, sci.out), h("div", { class: "nd-row" }, h("span", { class: "nd-dim", text: "angles in" }), degBtn), fnRow,
      h("span", { class: "nd-dim", text: "also: sinh cosh tanh log2 floor ceil round, and root(27;3) pow(2;8) mod(7;3) min(a;b) max(a;b)" }));

    // ---- graphing ----
    const gIn = h("input", { class: "nd-input nd-grow", value: store.get("graph", "sin(x) * x"), spellcheck: "false" });
    const gMin = h("input", { class: "nd-input", value: "-10", size: "5" }), gMax = h("input", { class: "nd-input", value: "10", size: "5" });
    const gMsg = h("span", { class: "nd-dim" }), cv = h("canvas", { class: "nd-graph" });
    function step(range) { const raw = range / 8, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p; return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p; }
    function draw() {
      const w = cv.clientWidth, hh = cv.clientHeight; if (!w || !hh) return;
      const dpr = window.devicePixelRatio || 1; cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr);
      const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, hh);
      const x0 = num(gMin.value), x1 = num(gMax.value);
      if (!isFinite(x0) || !isFinite(x1) || x0 >= x1) { gMsg.textContent = "check the x range"; return; }
      const pts = [];
      try { for (let p = 0; p <= w; p++) { const y = evaluate(gIn.value, { vars: { x: x0 + (x1 - x0) * p / w } }); pts.push(y != null && isFinite(y) ? y : null); } }
      catch (e) { gMsg.textContent = "cannot read that formula - use x, e.g. x^2 - 3"; return; }
      const fin = pts.filter(v => v != null).sort((a, b) => a - b);
      if (!fin.length) { gMsg.textContent = "nothing to draw in this range"; return; }
      let y0 = fin[Math.floor(fin.length * 0.02)], y1 = fin[Math.max(0, Math.ceil(fin.length * 0.98) - 1)];
      if (y0 === y1) { y0 -= 1; y1 += 1; } const pad = (y1 - y0) * 0.1; y0 -= pad; y1 += pad;
      const X = x => (x - x0) / (x1 - x0) * w, Y = y => hh - (y - y0) / (y1 - y0) * hh;
      g.font = '10px "IBM Plex Mono", monospace'; g.lineWidth = 1;
      const sx = step(x1 - x0), sy = step(y1 - y0), lab = v => String(+v.toPrecision(6));
      for (let x = Math.ceil(x0 / sx) * sx; x <= x1; x += sx) { g.strokeStyle = Math.abs(x) < sx / 2 ? "#7d8891" : "#232a30"; g.beginPath(); g.moveTo(X(x), 0); g.lineTo(X(x), hh); g.stroke(); g.fillStyle = "#7d8891"; g.fillText(lab(x), X(x) + 3, hh - 4); }
      for (let y = Math.ceil(y0 / sy) * sy; y <= y1; y += sy) { g.strokeStyle = Math.abs(y) < sy / 2 ? "#7d8891" : "#232a30"; g.beginPath(); g.moveTo(0, Y(y)); g.lineTo(w, Y(y)); g.stroke(); g.fillStyle = "#7d8891"; g.fillText(lab(y), 3, Y(y) - 3); }
      g.strokeStyle = "#4fc3d9"; g.lineWidth = 2; g.beginPath(); let pen = false, last = 0;
      pts.forEach((y, p) => { if (y == null) { pen = false; return; } const py = Y(y); if (pen && Math.abs(py - last) > hh) pen = false; if (pen) g.lineTo(p, py); else g.moveTo(p, py); pen = true; last = py; });
      g.stroke(); gMsg.textContent = "y = " + gIn.value; store.set("graph", gIn.value);
    }
    for (const e of [gIn, gMin, gMax]) e.addEventListener("input", draw);
    if (window.ResizeObserver) new ResizeObserver(draw).observe(cv);
    onShow.graphing = draw;
    section("graphing", h("div", { class: "nd-row" }, h("span", { class: "nd-dim", text: "y =" }), gIn, h("span", { class: "nd-dim", text: "x from" }), gMin, h("span", { class: "nd-dim", text: "to" }), gMax), cv, gMsg);

    // ---- programmer (whole numbers, any size) ----
    function evalInt(src) {
      const s = String(src).toLowerCase().replace(/[\s_]+/g, ""); if (!s) return null; let i = 0;
      const fail = () => { throw new Error("bad"); };
      function prim() {
        if (s[i] === "(") { i++; const v = or(); if (s[i] !== ")") fail(); i++; return v; }
        if (s[i] === "-") { i++; return -prim(); } if (s[i] === "~") { i++; return ~prim(); }
        const m = /^(0x[0-9a-f]+|0b[01]+|0o[0-7]+|\d+)/.exec(s.slice(i)); if (!m) fail(); i += m[0].length; return BigInt(m[0]);
      }
      function mul() { let v = prim(); for (;;) { const c = s[i]; if (c === "*") { i++; v *= prim(); } else if (c === "/" || c === "%") { i++; const d = prim(); if (d === 0n) fail(); v = c === "/" ? v / d : v % d; } else return v; } }
      function add() { let v = mul(); for (;;) { if (s[i] === "+") { i++; v += mul(); } else if (s[i] === "-") { i++; v -= mul(); } else return v; } }
      function shift() { let v = add(); for (;;) { const l = s.startsWith("<<", i), r = s.startsWith(">>", i); if (!l && !r) return v; i += 2; const n = add(); if (n < 0n || n > 256n) fail(); v = l ? v << n : v >> n; } }
      function and() { let v = shift(); while (s[i] === "&") { i++; v &= shift(); } return v; }
      function xor() { let v = and(); while (s[i] === "^") { i++; v ^= and(); } return v; }
      function or() { let v = xor(); while (s[i] === "|") { i++; v |= xor(); } return v; }
      const v = or(); if (i !== s.length) fail(); return v;
    }
    const pIn = h("input", { class: "nd-input nd-grow", placeholder: "e.g. 255, 0xFF, 0b1010, 0xF0 | 0x0F, 1 << 8", spellcheck: "false" });
    const pOut = {}; const pRows = h("div", { class: "nd-kv" });
    for (const k of ["HEX", "DEC", "OCT", "BIN"]) { pOut[k] = h("output", { class: "nd-wrap" }); pRows.append(h("div", { class: "nd-info" }, h("span", { text: k }), pOut[k])); }
    pIn.addEventListener("input", () => {
      let v; try { v = evalInt(pIn.value); } catch (e) { for (const k in pOut) pOut[k].textContent = "?"; return; }
      if (v == null) { for (const k in pOut) pOut[k].textContent = ""; return; }
      const u = v < 0n ? BigInt.asUintN(64, v) : v; // negative numbers shown as 64-bit two's complement
      pOut.DEC.textContent = v.toString(); pOut.HEX.textContent = u.toString(16).toUpperCase(); pOut.OCT.textContent = u.toString(8);
      const b = u.toString(2); pOut.BIN.textContent = b.padStart(Math.ceil(b.length / 4) * 4, "0").replace(/(.{4})(?=.)/g, "$1 ");
    });
    section("programmer", h("div", { class: "nd-row" }, pIn), pRows,
      h("span", { class: "nd-dim", text: "whole numbers only. prefixes: 0x hex, 0b binary, 0o octal. operators: + - * / %  & | ^ (xor) ~ << >>" }));

    // ---- date calculation ----
    const iso = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    const parseD = v => { const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(v); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
    const dA = h("input", { type: "date", class: "nd-input", value: iso(new Date()) }), dB = h("input", { type: "date", class: "nd-input", value: iso(new Date()) });
    const dOut = h("output", { class: "nd-result" });
    function diff() {
      let a = parseD(dA.value), b = parseD(dB.value); if (!a || !b) { dOut.textContent = "pick two dates"; return; }
      if (a > b) [a, b] = [b, a];
      const days = Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
      let y = b.getFullYear() - a.getFullYear(), m = b.getMonth() - a.getMonth(), d = b.getDate() - a.getDate();
      if (d < 0) { m--; d += new Date(b.getFullYear(), b.getMonth(), 0).getDate(); }
      if (m < 0) { y--; m += 12; }
      const parts = []; if (y) parts.push(y + (y === 1 ? " year" : " years")); if (m) parts.push(m + (m === 1 ? " month" : " months")); if (d || !parts.length) parts.push(d + (d === 1 ? " day" : " days"));
      dOut.textContent = days === 0 ? "same date" : parts.join(", ") + "  (" + days + " days, " + (days / 7).toFixed(1) + " weeks)";
    }
    dA.addEventListener("input", diff); dB.addEventListener("input", diff);
    const dC = h("input", { type: "date", class: "nd-input", value: iso(new Date()) }), dN = h("input", { class: "nd-input", value: "30", size: "6" }), dRes = h("output", { class: "nd-result" });
    function addDays() {
      const a = parseD(dC.value), n = Math.round(num(dN.value)); if (!a || !isFinite(n)) { dRes.textContent = "= ?"; return; }
      const r = new Date(a.getFullYear(), a.getMonth(), a.getDate() + n);
      dRes.textContent = "= " + r.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    }
    dC.addEventListener("input", addDays); dN.addEventListener("input", addDays);
    section("date", h("div", { class: "nd-sub", text: "difference between dates" }), h("div", { class: "nd-row" }, dA, h("span", { class: "nd-dim", text: "to" }), dB), dOut,
      h("div", { class: "nd-sub", text: "add or subtract days" }), h("div", { class: "nd-row" }, dC, h("span", { class: "nd-dim", text: "plus" }), dN, h("span", { class: "nd-dim", text: "days (use a minus for earlier)" })), dRes);
    onShow.date = () => { diff(); addDays(); };

    // ---- converter ----
    const U = {
      currency: {},
      volume: { ml: 0.001, litre: 1, "cubic metre": 1000, "teaspoon (US)": 0.00492892159375, "tablespoon (US)": 0.01478676478125, "fluid ounce (US)": 0.0295735295625, "cup (US)": 0.2365882365, "pint (US)": 0.473176473, "quart (US)": 0.946352946, "gallon (US)": 3.785411784, "gallon (UK)": 4.54609, "cubic inch": 0.016387064, "cubic foot": 28.316846592 },
      length: { mm: 0.001, cm: 0.01, m: 1, km: 1000, inch: 0.0254, foot: 0.3048, yard: 0.9144, mile: 1609.344, "nautical mile": 1852 },
      weight: { mg: 0.000001, g: 0.001, kg: 1, tonne: 1000, carat: 0.0002, ounce: 0.028349523125, pound: 0.45359237, stone: 6.35029318 },
      temperature: { C: 1, F: 1, K: 1 },
      energy: { joule: 1, kilojoule: 1000, calorie: 4.184, kilocalorie: 4184, "watt-hour": 3600, "kilowatt-hour": 3600000, "electron volt": 1.602176634e-19, BTU: 1055.05585262, "foot-pound": 1.3558179483314004 },
      area: { "mm²": 0.000001, "cm²": 0.0001, "m²": 1, hectare: 10000, "km²": 1000000, "inch²": 0.00064516, "foot²": 0.09290304, "yard²": 0.83612736, acre: 4046.8564224, "mile²": 2589988.110336 },
      speed: { "m/s": 1, "km/h": 1 / 3.6, mph: 0.44704, knot: 1852 / 3600, "foot/s": 0.3048, "mach (sea level)": 340.3 },
      time: { microsecond: 0.000001, millisecond: 0.001, second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, "year (365.25 d)": 31557600 },
      power: { watt: 1, kilowatt: 1000, "horsepower (US)": 745.6998715822702, "horsepower (metric)": 735.49875, "foot-pound/min": 0.022596966, "BTU/min": 17.584264 },
      data: { bit: 0.125, byte: 1, "kilobyte (KB)": 1000, "megabyte (MB)": 1e6, "gigabyte (GB)": 1e9, "terabyte (TB)": 1e12, "kibibyte (KiB)": 1024, "mebibyte (MiB)": 1048576, "gibibyte (GiB)": 1073741824, "tebibyte (TiB)": 1099511627776 },
      pressure: { pascal: 1, kilopascal: 1000, bar: 100000, atmosphere: 101325, psi: 6894.757293168, mmHg: 133.322387415 },
      angle: { degree: 1, radian: 180 / Math.PI, gradian: 0.9 }
    };
    const sel = opts => { const s = h("select", { class: "nd-input" }); for (const o of opts) s.append(h("option", { value: o, text: o })); return s; };
    const uCat = sel(Object.keys(U)), uVal = h("input", { class: "nd-input", value: "1", size: "10" }), uOut = h("output", { class: "nd-result" }), uAlso = h("span", { class: "nd-dim" });
    const uFrom = sel([]), uTo = sel([]);
    uCat.value = store.get("ucat", "length"); if (!U[uCat.value]) uCat.value = "length";
    function fill() {
      const k = Object.keys(U[uCat.value]), pref = store.get("upick-" + uCat.value, null);
      for (const s of [uFrom, uTo]) { s.textContent = ""; for (const o of k) s.append(h("option", { value: o, text: o })); }
      if (pref && k.includes(pref[0]) && k.includes(pref[1])) { uFrom.value = pref[0]; uTo.value = pref[1]; } else uTo.selectedIndex = Math.min(1, k.length - 1);
      conv();
    }
    function conv() {
      uAlso.textContent = uCat.value === "currency" ? rateNote : "";
      const v = num(uVal.value), T = U[uCat.value];
      if (!Object.keys(T).length) { uOut.textContent = "= ..."; return; }
      if (!isFinite(v)) { uOut.textContent = "= ?"; return; }
      let r;
      if (uCat.value === "temperature") {
        const c = uFrom.value === "C" ? v : uFrom.value === "F" ? (v - 32) * 5 / 9 : v - 273.15;
        const all = { C: c, F: c * 9 / 5 + 32, K: c + 273.15 }; r = all[uTo.value];
        const rest = Object.keys(all).filter(u => u !== uFrom.value && u !== uTo.value);
        uAlso.textContent = "about equal to " + rest.map(u => +all[u].toFixed(2) + " " + u).join("  or  ");
      } else r = v * T[uFrom.value] / T[uTo.value];
      uOut.textContent = "= " + (uCat.value === "currency" ? r.toFixed(2) : +r.toPrecision(8)) + " " + uTo.value;
      store.set("upick-" + uCat.value, [uFrom.value, uTo.value]);
    }
    let rateNote = "";
    function useRates(d, stale) {
      const T = {}; for (const c of ["EUR", "USD", "GBP", "CHF"]) if (d.rates[c]) T[c] = 1 / d.rates[c];
      for (const c of Object.keys(d.rates).sort()) if (/^[A-Z]{3}$/.test(c) && d.rates[c] > 0 && !T[c]) T[c] = 1 / d.rates[c];
      U.currency = T; rateNote = "rates by " + d.source + ", updated " + d.updated + (stale ? " (saved copy - could not refresh)" : "");
    }
    async function loadRates() {
      if (Object.keys(U.currency).length && rateNote.indexOf("saved copy") < 0) return;
      const saved = store.get("rates", null);
      try { const d = await api("rates"); store.set("rates", d); useRates(d, false); log("currency rates loaded (" + d.updated + ")"); }
      catch (e) { if (saved) useRates(saved, true); else rateNote = "currency rates need an internet connection"; }
      if (uCat.value === "currency") fill();
    }
    uCat.addEventListener("change", () => { store.set("ucat", uCat.value); fill(); if (uCat.value === "currency") loadRates(); });
    for (const e of [uVal, uFrom, uTo]) e.addEventListener("input", conv);
    const swap = btn("swap", () => { const a = uFrom.value; uFrom.value = uTo.value; uTo.value = a; conv(); });
    section("converter", h("div", { class: "nd-row" }, uCat, uVal, uFrom, h("span", { class: "nd-dim", text: "to" }), uTo, swap), uOut, uAlso);
    onShow.converter = () => { fill(); if (uCat.value === "currency") loadRates(); };

    // ---- colour picker ----
    const col = h("input", { type: "color", class: "nd-color", value: store.get("color", "#4fc3d9") }), colOut = h("output", { class: "nd-result" });
    const rgb = hex => "rgb(" + [1, 3, 5].map(n => parseInt(hex.slice(n, n + 2), 16)).join(", ") + ")";
    const showCol = () => { colOut.textContent = col.value.toUpperCase() + "   " + rgb(col.value); store.set("color", col.value); };
    col.addEventListener("input", showCol);
    const copy = t => api("copyText", t).then(() => log("copied " + t)).catch(e => log("copy failed: " + e.message));
    section("colour", h("div", { class: "nd-row" }, col, colOut, btn("copy hex", () => copy(col.value.toUpperCase())), btn("copy rgb", () => copy(rgb(col.value)))));
    showCol();

    for (const m of modes) { buttons[m] = btn(m, () => pick(m)); nav.append(buttons[m]); }
    const startMode = store.get("toolmode", "standard");
    pick(modes.includes(startMode) ? startMode : "standard");
    onTab.tools = () => { const m = store.get("toolmode", "standard"); if (onShow[m]) onShow[m](); };
    window.ndCalc = { evaluate, evalInt }; // for testing
  })();

  /* ---------- control: Windows controls and app behaviour ---------- */
  (function () {
    const root = $c("control"); if (!root) return;
    const paint = r => r.style.setProperty("--p", r.value + "%");
    function slider(label) {
      const out = h("output"), inp = h("input", { type: "range", min: "0", max: "100", value: "0" });
      const el = h("label", { class: "nd-slider" }, h("div", null, label, out), inp);
      inp.addEventListener("input", () => { paint(inp); out.textContent = inp.value; });
      return { el, inp, out, set(v) { inp.value = v; paint(inp); out.textContent = v; }, note(t) { out.textContent = t; } };
    }
    function toggle(label, fn) {
      const inp = h("input", { type: "checkbox" }), el = h("label", { class: "nd-opt" }, inp, h("span"), label);
      inp.addEventListener("change", () => fn(inp.checked, inp));
      return { el, inp };
    }
    // sound
    const vol = slider("volume"), mute = toggle("mute", async on => { try { const r = await api("volume", null, on); if (r.ok) log("sound " + (r.mute ? "muted" : "unmuted")); else log("sound: " + r.msg); } catch (e) { log("sound: " + e.message); } });
    vol.inp.addEventListener("change", async () => { try { const r = await api("volume", Number(vol.inp.value), null); if (r.ok) { vol.set(r.level); log("volume set to " + r.level + "%"); } else { vol.note(r.msg); } } catch (e) { vol.note(e.message); } });
    // brightness
    const bri = slider("brightness");
    bri.inp.addEventListener("change", async () => { try { const r = await api("brightness", Number(bri.inp.value)); if (r.ok) { bri.set(r.level); log("brightness set to " + r.level + "%"); } else { bri.note("not supported"); log("brightness: " + r.msg); } } catch (e) { bri.note(e.message); } });
    // Windows switches
    const names = { appsDark: "dark mode for apps", sysDark: "dark mode for taskbar and start", showExt: "show file extensions", showHidden: "show hidden files" };
    const sw = {};
    for (const id in names) sw[id] = toggle(names[id], async (on, inp) => {
      try { const r = await api("switchSet", id, on); if (r.ok) log(names[id] + ": " + (on ? "on" : "off")); else { inp.checked = !on; log(names[id] + " could not be changed: " + r.msg); } }
      catch (e) { inp.checked = !on; log(names[id] + ": " + e.message); }
    });
    // cleanup
    const cTemp = h("output", { text: "press scan" }), cBin = h("output", { text: "press scan" }), cConfirm = h("div", { class: "nd-row" });
    const row = (k, v) => h("div", { class: "nd-info" }, h("span", { text: k }), v);
    let scanning = false;
    async function scan() {
      if (scanning) return; scanning = true; cTemp.textContent = "scanning..."; cBin.textContent = "scanning...";
      try { const r = await api("cleanScan"); cTemp.textContent = size(r.temp.bytes) + " in " + r.temp.count + " items"; cBin.textContent = r.bin ? size(r.bin.bytes) + " in " + r.bin.count + " items" : "not available"; }
      catch (e) { cTemp.textContent = e.message; cBin.textContent = ""; }
      scanning = false;
    }
    function ask(text, yes, fn) {
      cConfirm.textContent = "";
      cConfirm.append(h("span", { text }), btn(yes, async () => { cConfirm.textContent = ""; await fn(); scan(); }, "nd-danger"), btn("cancel", () => { cConfirm.textContent = ""; }));
    }
    const clearTemp = btn("clear temp files", () => ask("delete temporary files older than a day? this cannot be undone.", "yes, delete", async () => {
      try { const r = await api("cleanTemp"); log("temp files: removed " + r.removed + " items, freed " + size(r.freed) + ", kept " + r.kept + " recent or in use"); } catch (e) { log("temp cleanup failed: " + e.message); } }));
    const clearBin = btn("empty recycle bin", () => ask("permanently delete everything in the recycle bin?", "yes, empty it", async () => {
      try { const r = await api("cleanBin"); log(r.ok ? "recycle bin emptied" : "recycle bin: " + (r.msg || "could not be emptied")); } catch (e) { log("recycle bin: " + e.message); } }));
    // app behaviour
    const accel = h("input", { class: "nd-input", size: "18", spellcheck: "false" }), hkNote = h("span", { class: "nd-dim" });
    function showSettings(s) {
      tray.inp.checked = s.tray; hot.inp.checked = s.hotkey; login.inp.checked = s.login; if (document.activeElement !== accel) accel.value = s.accel;
      hkNote.textContent = s.hotkey ? (s.hotkeyOk ? "active" : "could not be registered - another program may use it") : "";
    }
    const setS = async (k, v, label) => { try { const s = await api("settingSet", k, v); showSettings(s); log(label); } catch (e) { log("setting not saved: " + e.message); api("settingsGet").then(showSettings).catch(() => {}); } };
    const tray = toggle("tray icon (closing keeps it running)", on => setS("tray", on, "tray icon " + (on ? "on" : "off")));
    const hot = toggle("hotkey to show or hide nightdeck", on => setS("hotkey", on, "global hotkey " + (on ? "on" : "off")));
    const login = toggle("start with Windows", on => setS("login", on, "start with Windows " + (on ? "on" : "off")));
    const setAccel = btn("set", () => setS("accel", accel.value, "hotkey set to " + accel.value));
    accel.addEventListener("keydown", e => { if (e.key === "Enter") setAccel.click(); });

    root.append(
      h("div", { class: "nd-sub", text: "sound and screen" }), h("div", { class: "nd-two" }, h("div", { class: "nd-kv" }, vol.el, mute.el), h("div", { class: "nd-kv" }, bri.el)),
      h("div", { class: "nd-sub", text: "windows" }), h("div", { class: "nd-grid2" }, Object.values(sw).map(t => t.el)),
      h("span", { class: "nd-dim", text: "file settings show in folders you open next, or after pressing F5 in an open folder." }),
      h("div", { class: "nd-sub", text: "cleanup" }), h("div", { class: "nd-kv" }, row("temporary files", cTemp), row("recycle bin", cBin)),
      h("div", { class: "nd-row" }, btn("scan", scan), clearTemp, clearBin), cConfirm,
      h("div", { class: "nd-sub", text: "nightdeck" }), h("div", { class: "nd-grid2" }, tray.el, login.el, hot.el),
      h("div", { class: "nd-row" }, h("span", { class: "nd-dim", text: "hotkey keys" }), accel, setAccel, hkNote));

    let loaded = false;
    async function load() {
      api("settingsGet").then(showSettings).catch(() => {});
      if (loaded) return; loaded = true;
      api("volume", null, null).then(r => { if (r.ok) { vol.set(r.level); mute.inp.checked = r.mute; } else vol.note(r.msg); }).catch(e => vol.note(e.message));
      api("brightness", null).then(r => { if (r.ok) bri.set(r.level); else { bri.note("not supported"); bri.inp.disabled = true; } }).catch(e => bri.note(e.message));
      api("switchesGet").then(r => { if (r.ok) for (const id in sw) sw[id].inp.checked = !!r[id]; }).catch(() => {});
    }
    onTab.control = load;
  })();

  // open the tab that was open last time
  const lastTab = store.get("tab", "system");
  panel.select(document.querySelector('[data-pane="' + lastTab + '"]') ? lastTab : "system");
})();
