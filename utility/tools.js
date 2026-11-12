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
    // one bar per drive: the first uses the built-in "disk" bar, the others are added after it
    const pane = document.querySelector('[data-pane="system"]'), diskEl = pane.querySelector('[data-meter="disk"]'), made = {};
    function drives(list) {
      if (!list.length) { panel.setMeter("disk", 0, "not available"); return; }
      let after = diskEl;
      list.forEach((d, i) => {
        const letter = String(d.root).replace(/[\\/]+$/, "").toLowerCase() || "/", id = i === 0 ? "disk" : "disk-" + letter.replace(/\W/g, "");
        if (i === 0) { const t = diskEl.firstChild.firstChild; if (t && t.nodeValue !== "disk " + letter) t.nodeValue = "disk " + letter; }
        else {
          if (!made[id]) { made[id] = h("div", { class: "nd-meter", "data-meter": id }, h("div", null, "disk " + letter, h("output")), h("div", { class: "nd-meterbar" }, h("i"))); after.insertAdjacentElement("afterend", made[id]); }
          after = made[id];
        }
        panel.setMeter(id, (d.total - d.free) / d.total * 100, gb(d.free) + " GB free of " + Math.round(d.total / 1073741824) + " GB");
      });
    }
    // the last minute of cpu and memory use as a thin line under each bar
    const hist = { cpu: [], mem: [] }, cv = {};
    for (const k of ["cpu", "mem"]) { const m = pane.querySelector('[data-meter="' + k + '"]'); if (m) { cv[k] = h("canvas", { class: "nd-hist" }); m.append(cv[k]); } }
    function drawHist() {
      for (const k in cv) {
        const a = hist[k]; while (a.length > 60) a.shift();
        const c = cv[k], w = c.clientWidth, hh = c.clientHeight; if (!w || !hh) continue;
        const dpr = window.devicePixelRatio || 1; c.width = Math.round(w * dpr); c.height = Math.round(hh * dpr);
        const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.strokeStyle = "#4fc3d9"; g.lineWidth = 1.2; g.beginPath();
        a.forEach((v, i) => { const x = w - 1 - (a.length - 1 - i) * (w / 59), y = hh - 2 - Math.max(0, Math.min(100, v)) / 100 * (hh - 4); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
        g.stroke();
      }
    }
    async function tick() {
      try {
        const s = await api("sys");
        const used = s.memTotal - s.memFree, memPct = used / s.memTotal * 100;
        panel.setMeter("cpu", s.cpu);
        panel.setMeter("mem", memPct, gb(used) + " / " + gb(s.memTotal) + " GB");
        drives(s.disks && s.disks.length ? s.disks : (s.disk ? [s.disk] : []));
        hist.cpu.push(s.cpu); hist.mem.push(memPct); drawHist();
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
        if (t.gpuUse != null) panel.setMeter("gpu", t.gpuUse); else panel.setMeter("gpu", 0, "not reported by this PC");
        if (t.vramTotal) panel.setMeter("vram", t.vramUsed / t.vramTotal * 100, (t.vramUsed / 1024).toFixed(1) + " / " + (t.vramTotal / 1024).toFixed(1) + " GB"); else panel.setMeter("vram", 0, "not reported by this PC");
        panel.setInfo("gpuname", t.gpuName || "not reported");
        if (!temps.logged) { temps.logged = true; log("temperature: system " + (t.system != null ? Math.round(t.system) + " C" : "not available") + ", gpu " + (t.gpu != null ? Math.round(t.gpu) + " C (" + t.gpuName + ")" : "not available" + (t.gpuError ? " - " + t.gpuError : ""))); }
      } catch (e) {}
    }
    api("sysExtra").then(x => { panel.setInfo("board", x.board || "not reported"); panel.setInfo("ram", x.ram || "not reported"); panel.setInfo("screens", x.screens || "not reported"); }).catch(() => {});
    // which program is using the most right now
    async function top() {
      try {
        const p = await api("procs"); if (!p || !p.length) return;
        const c = p.filter(x => x.cpu != null).sort((a, b) => b.cpu - a.cpu)[0], m = p.slice().sort((a, b) => b.mem - a.mem)[0];
        if (c) panel.setInfo("topcpu", c.name + "  (" + c.cpu.toFixed(1) + "%)");
        if (m) panel.setInfo("topmem", m.name + "  (" + size(m.mem) + ")");
      } catch (e) {}
    }
    top(); setInterval(() => { if (active === "system") top(); }, 5000);
    pane.append(h("div", { class: "nd-row nd-specs" }, btn("copy specs", () => {
      const text = [...pane.querySelectorAll("[data-info]")].filter(r => !/^(uptime|topcpu|topmem)$/.test(r.dataset.info))
        .map(r => r.querySelector("span").textContent + ": " + r.querySelector("output").textContent).join("\n");
      api("copyText", text).then(() => log("system details copied")).catch(e => log("copy failed: " + e.message));
    })));
    temps(); setInterval(() => { if (active === "system") temps(); }, 5000);
    tick(); setInterval(tick, 1000);
  })();

  /* ---------- running apps ---------- */
  (function () {
    const root = $c("apps"); if (!root) return;
    let sort = store.get("procsort", "mem"), dir = store.get("procdir", -1), all = store.get("procall", false), query = "";
    let data = [], pending = null, force = false, busy = false, open = null;
    const status = h("span", { class: "nd-dim" });
    const search = h("input", { class: "nd-input", placeholder: "search programs", size: "16", spellcheck: "false" });
    search.addEventListener("input", () => { query = search.value.trim().toLowerCase(); render(); });
    const bAll = btn("show all", () => { all = !all; store.set("procall", all); render(); });
    const list = h("div", { class: "nd-table" });
    function setSort(s) {
      if (sort === s) dir = -dir; else { sort = s; dir = s === "name" ? 1 : -1; }
      store.set("procsort", sort); store.set("procdir", dir); render();
    }
    // click a heading to sort by it, click again to turn the order round
    const head = (label, key) => {
      const el = h("span", { class: "nd-sorth" + (sort === key ? " nd-on" : ""), text: label + (sort === key ? (dir < 0 ? " ▾" : " ▴") : ""), title: "sort by " + label });
      el.addEventListener("click", () => setSort(key)); return el;
    };
    const val = p => (sort === "cpu" ? p.cpu : p.mem) || 0;
    const cmp = (a, b) => sort === "name" ? dir * a.name.localeCompare(b.name) : dir * (val(a) - val(b));
    const iconOf = p => p.icon ? h("img", { class: "nd-appicon", src: p.icon, alt: "" }) : h("i", { class: "nd-appicon nd-noicon" });
    function rowsFor(p) {
      let action;
      if (p.protected) action = h("span", { class: "nd-dim", text: "system" });
      else if (pending === p.name) action = h("span", { class: "nd-row" },
        btn(force ? "force" : "yes", () => kill(p.name), "nd-danger"), btn("no", () => { pending = null; force = false; render(); }));
      else action = h("span", { class: "nd-row" }, btn("close", () => { pending = p.name; force = false; open = null; render(); }),
        btn("…", () => { open = open === p.name ? null : p.name; render(); }));
      const out = [h("div", { class: "nd-tr" },
        h("span", { class: "nd-app", title: p.title || p.name }, iconOf(p), p.name + (p.count > 1 ? " (" + p.count + ")" : "")),
        h("span", { text: p.cpu == null ? "..." : p.cpu.toFixed(1) + "%" }), h("span", { text: size(p.mem) }), action)];
      if (open === p.name && !p.protected) {
        const more = h("span", { class: "nd-row" });
        if (p.path) more.append(btn("open file location", () => api("showFile", p.path).then(() => log("opened the folder of " + p.name)).catch(e => log("could not open the folder: " + e.message))));
        more.append(btn("force close", () => { pending = p.name; force = true; open = null; render(); }, "nd-danger"));
        out.push(h("div", { class: "nd-more" }, h("span", { class: "nd-dim nd-path", text: p.path || "file location not available", title: p.path || "" }), more));
      }
      return out;
    }
    function render() {
      bAll.classList.toggle("nd-on", !!all);
      list.textContent = "";
      list.append(h("div", { class: "nd-tr nd-th" }, head("program", "name"), head("cpu", "cpu"), head("memory", "mem"), h("span")));
      const match = data.filter(p => !query || p.name.toLowerCase().includes(query) || String(p.title || "").toLowerCase().includes(query));
      for (const [label, items] of [["apps", match.filter(p => p.win)], ["background", match.filter(p => !p.win)]]) {
        if (!items.length) continue;
        items.sort(cmp);
        const shown = all || query ? items : items.slice(0, label === "apps" ? 30 : 10);
        list.append(h("div", { class: "nd-sub nd-group", text: label + "  (" + items.length + ")" + (shown.length < items.length ? "  -  top " + shown.length + " shown" : "") }));
        for (const p of shown) list.append(...rowsFor(p));
      }
      if (!match.length) list.append(h("div", { class: "nd-dim", text: query ? "nothing matches \"" + query + "\"" : "no programs found" }));
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
      try {
        data = await api("procs");
        let n = 0, cpu = 0, mem = 0; for (const p of data) { n += p.count || 1; cpu += p.cpu || 0; mem += p.mem || 0; }
        status.textContent = n + " processes    cpu " + Math.round(cpu) + "%    memory " + size(mem);
        render();
      } catch (e) { status.textContent = e.message; }
      busy = false;
    }

    // programs that start with Windows
    const sList = h("div", { class: "nd-table" }), sNote = h("span", { class: "nd-dim" });
    async function loadStartup() {
      sNote.textContent = "reading...";
      try {
        const r = await api("startupList"); sList.textContent = "";
        if (r.msg) { sNote.textContent = r.msg; return; }
        for (const it of r.items) {
          const b = btn(it.on ? "on" : "off", async () => {
            b.disabled = true;
            try { const x = await api("startupSet", it.hive, it.name, !it.on); log(x.ok ? "start with windows: " + it.name + (it.on ? " off" : " on") : it.name + ": " + x.msg); }
            catch (e) { log("startup change failed: " + e.message); }
            loadStartup();
          });
          if (it.on) b.classList.add("nd-on");
          sList.append(h("div", { class: "nd-tr nd-start" }, h("span", { class: "nd-app", title: it.cmd }, iconOf(it), it.name),
            h("span", { class: "nd-dim", text: it.hive === "HKLM" ? "all users" : "this user" }), b));
        }
        const on = r.items.filter(x => x.on).length;
        sNote.textContent = r.items.length ? on + " of " + r.items.length + " switched on - changes apply at the next start of windows" : "nothing found";
      } catch (e) { sNote.textContent = e.message; }
    }
    root.append(h("div", { class: "nd-row" }, search, bAll, status), list,
      h("div", { class: "nd-sub", text: "starts with windows" }), h("div", { class: "nd-row" }, btn("refresh", loadStartup), sNote), sList);
    onTab.apps = () => { load(); loadStartup(); };
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
    let items = store.get("launch", []), icons = store.get("launchicons", {}), edit = false, editing = -1, sure = -1, admin = false, dragFrom = -1, apps = null;
    const grid = h("div", { class: "nd-lgroups" }), groupList = h("datalist", { id: "nd-lgroup-names" });
    const name = h("input", { class: "nd-input", placeholder: "name", maxlength: "40" });
    const target = h("input", { class: "nd-input nd-grow", placeholder: "path or website, e.g. https://example.com" });
    const group = h("input", { class: "nd-input", placeholder: "group (optional)", maxlength: "24", size: "16", list: "nd-lgroup-names" });
    const hotkey = h("input", { class: "nd-input", placeholder: "hotkey, e.g. Control+Alt+S", size: "24", spellcheck: "false" });
    const bAdmin = btn("run as administrator", () => { admin = !admin; bAdmin.classList.toggle("nd-on", admin); });
    const formTitle = h("div", { class: "nd-sub", text: "add a shortcut" });
    const bSave = btn("add", save, "nd-on"), bCancel = btn("cancel", () => resetForm());
    const bEdit = btn("edit", () => { edit = !edit; sure = -1; if (!edit && editing >= 0) resetForm(); else render(); });
    const hint = h("span", { class: "nd-dim" });
    async function pick(kind) { try { const p = await api("pick", kind); if (p) { target.value = p; if (!name.value) name.value = p.split(/[\\/]/).filter(Boolean).pop().replace(/\.(exe|lnk)$/i, ""); } } catch (e) { log("browse failed: " + e.message); } }
    const noIcon = () => h("i", { class: "nd-appicon nd-noicon" });
    const iconEl = t => icons[t] ? h("img", { class: "nd-appicon", src: icons[t], alt: "" }) : noIcon();
    function loadIcon(it) { // looked up once per shortcut, then remembered
      if (icons[it.target] !== undefined) return;
      icons[it.target] = "";
      api("launchIcon", it.target).then(src => { if (src) { icons[it.target] = src; store.set("launchicons", icons); render(); } }).catch(() => {});
    }
    async function pushHotkeys() {
      try {
        const bad = await api("launchHotkeys", items.filter(x => x.hotkey).map(x => ({ accel: x.hotkey, target: x.target, admin: !!x.admin, name: x.name })));
        for (const b of bad || []) log("launcher: hotkey " + b + " is not available - another program or shortcut uses it");
      } catch (e) {}
    }
    function commit() { store.set("launch", items); pushHotkeys(); render(); }
    function resetForm() {
      editing = -1; admin = false; bAdmin.classList.remove("nd-on");
      name.value = target.value = group.value = hotkey.value = "";
      formTitle.textContent = "add a shortcut"; bSave.textContent = "add"; bCancel.style.display = "none"; render();
    }
    function startEdit(i) {
      const it = items[i]; editing = i; sure = -1;
      name.value = it.name; target.value = it.target; group.value = it.group || ""; hotkey.value = it.hotkey || "";
      admin = !!it.admin; bAdmin.classList.toggle("nd-on", admin);
      formTitle.textContent = "edit shortcut"; bSave.textContent = "save"; bCancel.style.display = ""; render(); name.focus();
    }
    function save() {
      let t = target.value.trim(); if (!t) return;
      if (/^www\./i.test(t)) t = "https://" + t;
      const hk = hotkey.value.trim();
      if (hk && !/^((Control|Ctrl|Alt|Shift|Super)\+)+([A-Za-z0-9]|F\d{1,2})$/i.test(hk)) { log("launcher: a hotkey must look like Control+Alt+S"); return; }
      const it = { name: name.value.trim() || t, target: t, group: group.value.trim(), admin, hotkey: hk };
      if (editing >= 0) { items[editing] = it; log("launcher: changed " + it.name); } else { items.push(it); log("launcher: added " + it.name); }
      store.set("launch", items); pushHotkeys(); resetForm();
    }
    async function open(it) { try { await api("launch", it.target, !!it.admin); log("opened " + it.name); } catch (e) { log("could not open " + it.name + ": " + e.message); } }
    function render() {
      grid.textContent = ""; groupList.textContent = "";
      bEdit.classList.toggle("nd-on", edit);
      hint.textContent = edit ? "click a shortcut to change it, drag to move it, x to remove" : "";
      if (!items.length) { grid.append(h("span", { class: "nd-dim", text: "nothing here yet - press add app, or add a shortcut below" })); return; }
      const groups = [];
      items.forEach((it, i) => { const g = it.group || ""; let e = groups.find(x => x.name === g); if (!e) groups.push(e = { name: g, list: [] }); e.list.push(i); });
      groups.sort((a, b) => (a.name !== "") - (b.name !== ""));
      for (const g of groups) {
        if (g.name) {
          groupList.append(h("option", { value: g.name }));
          grid.append(h("div", { class: "nd-lhead" }, h("span", { class: "nd-sub", text: g.name }),
            g.list.length > 1 && !edit ? btn("start all", async () => { for (const i of g.list) await open(items[i]); }) : null));
        }
        const box = h("div", { class: "nd-grid" });
        for (const i of g.list) {
          const it = items[i]; loadIcon(it);
          const tile = h("div", { class: "nd-launch" + (editing === i ? " nd-editing" : "") });
          const main = h("button", { class: "nd-btn nd-ltile", title: it.target + (it.hotkey ? "\nhotkey: " + it.hotkey : "") + (it.admin ? "\nruns as administrator" : "") }, iconEl(it.target), it.name);
          main.addEventListener("click", () => { if (edit) startEdit(i); else open(it); });
          tile.append(main);
          if (edit) {
            tile.append(h("button", { class: "nd-btn" + (sure === i ? " nd-danger" : ""), text: sure === i ? "remove?" : "x", title: "Remove", onclick: () => {
              if (sure !== i) { sure = i; render(); return; }
              const gone = items.splice(i, 1)[0]; delete icons[gone.target]; store.set("launchicons", icons); sure = -1;
              log("launcher: removed " + gone.name); store.set("launch", items); pushHotkeys(); resetForm();
            } }));
            tile.draggable = true;
            tile.addEventListener("dragstart", e => { dragFrom = i; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i)); });
            tile.addEventListener("dragover", e => { e.preventDefault(); tile.classList.add("nd-drop"); });
            tile.addEventListener("dragleave", () => tile.classList.remove("nd-drop"));
            tile.addEventListener("drop", e => {
              e.preventDefault(); if (dragFrom < 0 || dragFrom === i) { dragFrom = -1; render(); return; }
              const moved = items.splice(dragFrom, 1)[0]; moved.group = it.group || "";
              items.splice(items.indexOf(it), 0, moved); dragFrom = -1; sure = -1;
              store.set("launch", items); resetForm();
            });
          }
          box.append(tile);
        }
        grid.append(box);
      }
    }
    // list of installed apps to pick from
    const picker = h("div", { class: "nd-picker" }); picker.style.display = "none";
    const pSearch = h("input", { class: "nd-input", placeholder: "search installed apps", size: "26", spellcheck: "false" });
    const pList = h("div", { class: "nd-table nd-plist" }), pNote = h("span", { class: "nd-dim" });
    function drawPicker() {
      pList.textContent = ""; if (!apps) return;
      const q = pSearch.value.trim().toLowerCase(), have = new Set(items.map(x => String(x.target).toLowerCase()));
      const m = apps.filter(a => !q || a.name.toLowerCase().includes(q));
      for (const a of m.slice(0, 300)) {
        pList.append(h("div", { class: "nd-tr nd-pick" },
          h("span", { class: "nd-app", title: a.target }, a.icon ? h("img", { class: "nd-appicon", src: a.icon, alt: "" }) : noIcon(), a.name),
          have.has(a.target.toLowerCase()) ? h("span", { class: "nd-dim", text: "added" }) : btn("add", () => {
            items.push({ name: a.name, target: a.target, group: "", admin: false, hotkey: "" });
            if (a.icon) { icons[a.target] = a.icon; store.set("launchicons", icons); }
            log("launcher: added " + a.name); commit(); drawPicker();
          })));
      }
      pNote.textContent = m.length + " of " + apps.length + " apps";
    }
    pSearch.addEventListener("input", drawPicker);
    const bPick = btn("add app", async () => {
      const show = picker.style.display === "none";
      picker.style.display = show ? "" : "none"; bPick.classList.toggle("nd-on", show);
      if (!show) return;
      pSearch.focus();
      if (!apps) { pNote.textContent = "reading installed apps..."; try { apps = await api("installedApps"); } catch (e) { pNote.textContent = e.message; return; } }
      drawPicker();
    });
    picker.append(h("div", { class: "nd-row" }, pSearch, pNote), pList);
    target.addEventListener("keydown", e => { if (e.key === "Enter") save(); });
    bCancel.style.display = "none";
    root.append(h("div", { class: "nd-row" }, bPick, bEdit, hint), picker, grid, formTitle,
      h("div", { class: "nd-row" }, name, target),
      h("div", { class: "nd-row" }, group, hotkey, bAdmin),
      h("div", { class: "nd-row" }, btn("browse app or file", () => pick("file")), btn("browse folder", () => pick("folder")), bSave, bCancel), groupList);
    render(); pushHotkeys();
  })();

  /* ---------- power ---------- */
  (function () {
    const root = $c("power"); if (!root) return;
    const acts = [["lock", "lock"], ["sleep", "sleep"], ["hibernate", "hibernate"], ["signout", "sign out"], ["screenoff", "screens off"],
      ["restart", "restart"], ["shutdown", "shut down"], ["bios", "restart to bios"]];
    const label = id => (acts.find(a => a[0] === id) || [id, id])[1];
    const dim = t => h("span", { class: "nd-dim", text: t });
    const two = n => String(n).padStart(2, "0");
    const row = h("div", { class: "nd-row" }), confirm = h("div", { class: "nd-row" });
    let timer = null;
    function cancel() { clearTimeout(timer); confirm.textContent = ""; }
    async function doNow(id) {
      log("power: " + label(id) + " requested");
      try { const r = await api("power", id); if (!r.ok) log("power: " + r.msg); } catch (e) { log("power failed: " + e.message); }
    }
    for (const [id, text] of acts) row.append(btn(text, () => {
      cancel();
      if (id === "screenoff") { doNow(id); return; }
      confirm.append(h("span", { text: id === "bios" ? "restart this PC into its setup screen (bios) now?" : text + " this PC now?" }),
        btn("yes, " + text, () => { cancel(); doNow(id); }, "nd-danger"), btn("cancel", cancel));
      timer = setTimeout(cancel, 8000);
    }));

    // timer: after some minutes, or at a clock time
    let sched = null;
    const tAct = h("select", { class: "nd-input" });
    for (const id of ["shutdown", "sleep", "hibernate", "restart", "lock"]) tAct.append(h("option", { value: id, text: label(id) }));
    const tMin = h("input", { class: "nd-input nd-num", type: "number", min: "1", max: "1440", value: store.get("pmin", "30") });
    const tAt = h("input", { class: "nd-input", type: "time" });
    const tState = dim("no timer set");
    const tCancel = btn("cancel timer", async () => { try { await api("powerTimer", "cancel"); log("power timer cancelled"); } catch (e) {} sched = null; drawTimer(); }, "nd-danger");
    function drawTimer() {
      if (!sched || sched.at <= Date.now()) { tState.textContent = "no timer set"; tCancel.style.display = "none"; return; }
      const s = Math.max(0, Math.round((sched.at - Date.now()) / 1000)), d = new Date(sched.at);
      tState.textContent = label(sched.action) + " in " + (s >= 3600 ? Math.floor(s / 3600) + ":" + two(Math.floor(s % 3600 / 60)) : Math.floor(s / 60)) + ":" + two(s % 60) +
        "   (at " + two(d.getHours()) + ":" + two(d.getMinutes()) + ")";
      tCancel.style.display = "";
    }
    async function setTimer(at) {
      try { sched = await api("powerTimer", "set", tAct.value, at); const d = new Date(sched.at); log("power timer: " + label(sched.action) + " at " + two(d.getHours()) + ":" + two(d.getMinutes())); }
      catch (e) { log("power timer: " + e.message); }
      drawTimer();
    }
    const bIn = btn("start", () => {
      const m = Math.round(Number(tMin.value));
      if (!(m >= 1 && m <= 1440)) { log("power timer: enter 1 to 1440 minutes"); return; }
      store.set("pmin", String(m)); setTimer(Date.now() + m * 60000);
    });
    const bAt = btn("set", () => {
      const m = /^(\d\d):(\d\d)/.exec(tAt.value); if (!m) { log("power timer: pick a time first"); return; }
      const d = new Date(); d.setHours(Number(m[1]), Number(m[2]), 0, 0);
      if (d.getTime() <= Date.now() + 5000) d.setDate(d.getDate() + 1);
      setTimer(d.getTime());
    });

    // power plans
    const plans = h("div", { class: "nd-row" });
    async function loadPlans() {
      try {
        const r = await api("powerPlans"); plans.textContent = "";
        if (r.msg) { plans.append(dim(r.msg)); return; }
        if (!r.list.length) plans.append(dim("no power plans reported"));
        for (const p of r.list) {
          const b = btn(String(p.name).toLowerCase(), async () => {
            try { const x = await api("powerPlan", p.id); log(x.ok ? "power plan: " + p.name : "power plan: " + x.msg); } catch (e) { log("power plan: " + e.message); }
            loadPlans();
          });
          if (p.active) b.classList.add("nd-on");
          plans.append(b);
        }
      } catch (e) { plans.textContent = e.message; }
    }

    // keep awake, start time, pending shutdown
    const bAwake = btn("keep pc and screens awake", async () => {
      try { const on = await api("keepAwake", !bAwake.classList.contains("nd-on")); bAwake.classList.toggle("nd-on", !!on); log("keep awake " + (on ? "on" : "off")); }
      catch (e) { log("keep awake: " + e.message); }
    });
    const iStart = h("output"), iUp = h("output");
    async function info() {
      try {
        const s = await api("sys"), d = new Date(Date.now() - s.uptime * 1000), u = Math.floor(s.uptime);
        iStart.textContent = d.toLocaleDateString() + "  " + two(d.getHours()) + ":" + two(d.getMinutes());
        iUp.textContent = (u >= 86400 ? Math.floor(u / 86400) + "d " : "") + Math.floor(u % 86400 / 3600) + "h " + two(Math.floor(u % 3600 / 60)) + "m";
      } catch (e) {}
    }
    const bAbort = btn("cancel a pending windows shutdown", async () => {
      try { const r = await api("power", "abort"); log(r.ok ? "pending windows shutdown cancelled" : "no windows shutdown was pending"); } catch (e) { log("power failed: " + e.message); }
    });

    tCancel.style.display = "none";
    root.append(row, confirm, dim("restart and shut down close every program - save your work first."),
      h("div", { class: "nd-sub", text: "timer" }),
      h("div", { class: "nd-row" }, tAct, dim("in"), tMin, dim("minutes"), bIn, dim("or at"), tAt, bAt),
      h("div", { class: "nd-row" }, tState, tCancel),
      h("div", { class: "nd-sub", text: "power plan" }), plans,
      h("div", { class: "nd-sub", text: "stay awake" }), h("div", { class: "nd-row" }, bAwake, dim("only while nightdeck is running")),
      h("div", { class: "nd-sub", text: "this session" }),
      h("div", { class: "nd-kv" }, h("div", { class: "nd-info" }, h("span", { text: "pc started" }), iStart), h("div", { class: "nd-info" }, h("span", { text: "running for" }), iUp)),
      h("div", { class: "nd-row" }, bAbort));
    function refresh() {
      loadPlans(); info();
      api("powerTimer", "get").then(s => { sched = s; drawTimer(); }).catch(() => {});
      api("keepAwake").then(on => bAwake.classList.toggle("nd-on", !!on)).catch(() => {});
    }
    onTab.power = refresh; refresh();
    setInterval(() => { drawTimer(); }, 1000);
    setInterval(() => { if (active === "power") info(); }, 30000);
  })();

  /* ---------- clipboard ---------- */
  (function () {
    const root = $c("clipboard"); if (!root) return;
    const list = h("div", { class: "nd-table" });
    let sig = "", items = [], cfg = { max: 25, keep: false, paused: false }, query = "", open = null;
    const two = n => String(n).padStart(2, "0");
    const when = ms => {
      const d = new Date(ms), t = two(d.getHours()) + ":" + two(d.getMinutes()) + ":" + two(d.getSeconds());
      return d.toDateString() === new Date().toDateString() ? t : two(d.getDate()) + "." + two(d.getMonth() + 1) + ". " + t.slice(0, 5);
    };
    const refresh = () => { sig = ""; return load(); };
    async function set(o) {
      try {
        cfg = await api("clipSet", o);
        if ("paused" in o) log("clipboard recording " + (cfg.paused ? "paused" : "resumed"));
        if ("keep" in o) log(cfg.keep ? "clipboard text history is now saved on this pc" : "clipboard history is no longer saved (pinned text still is)");
      } catch (e) { log("clipboard: " + e.message); }
      refresh();
    }
    const search = h("input", { class: "nd-input", placeholder: "search clipboard", size: "18", spellcheck: "false" });
    search.addEventListener("input", () => { query = search.value.trim(); refresh(); });
    const bPause = btn("pause", () => set({ paused: !cfg.paused }));
    const bKeep = btn("keep after restart", () => set({ keep: !cfg.keep }));
    const sMax = h("select", { class: "nd-input", title: "how many entries are kept" });
    for (const n of [25, 50, 100]) sMax.append(h("option", { value: String(n), text: n + " entries" }));
    sMax.addEventListener("change", () => set({ max: Number(sMax.value) }));
    const note = h("span", { class: "nd-dim" });
    const bClear = btn("clear", async () => {
      try {
        const r = await api("clipClear");
        log(r && r.windows ? "clipboard cleared, including the Windows history (Win + V)" : "clipboard cleared here - the Windows history (Win + V) could not be cleared");
        refresh();
      } catch (e) { log("clear failed: " + e.message); }
    });
    const tools = [["upper", "UPPER CASE"], ["lower", "lower case"], ["trim", "tidy spaces"], ["plain", "plain text"]];
    function render() {
      bPause.classList.toggle("nd-on", !!cfg.paused); bPause.textContent = cfg.paused ? "paused" : "pause";
      bKeep.classList.toggle("nd-on", !!cfg.keep); sMax.value = String(cfg.max);
      note.textContent = cfg.paused ? "recording is paused - nothing you copy is added."
        : cfg.keep ? "text history is saved on this pc, pictures are not. clear keeps pinned entries."
        : "kept in memory only; pinned text stays after a restart. clear keeps pinned entries and also empties Win + V.";
      list.textContent = "";
      if (!items.length) list.append(h("span", { class: "nd-dim", text: query ? "nothing matches \"" + query + "\"" : "nothing copied yet" }));
      for (const c of items) {
        const flat = c.kind === "text" ? c.text.replace(/\s+/g, " ") : "", one = c.kind === "text" ? c.text.trim() : "";
        const body = h("span", { class: "nd-clipb", title: "click to copy again" },
          c.kind === "image" ? [h("img", { class: "nd-clipimg", src: c.thumb, alt: "" }), "picture  " + c.w + " x " + c.h] : flat.slice(0, 160));
        body.addEventListener("click", async () => {
          try { await api("clipCopy", c.id); log("copied again: " + (c.kind === "image" ? "picture" : flat.slice(0, 40))); refresh(); } catch (e) {}
        });
        const extra = h("span", { class: "nd-row nd-clipx" });
        if (/^(#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\([\d\s.,%\/]+\))$/i.test(one)) { const sw = h("i", { class: "nd-swatch", title: one }); sw.style.background = one; extra.append(sw); }
        if (c.len <= 300 && /^https?:\/\/\S+$/i.test(one)) extra.append(btn("open", () => api("launch", one).then(() => log("opened " + one.slice(0, 60))).catch(e => log("could not open the link: " + e.message))));
        if (c.kind === "text") extra.append(h("span", { class: "nd-dim", text: c.len + (c.len === 1 ? " char" : " chars") }));
        extra.append(btn("…", () => { open = open === c.id ? null : c.id; render(); }));
        const pin = btn(c.pinned ? "pinned" : "pin", async () => { try { await api("clipPin", c.id); } catch (e) {} refresh(); });
        pin.title = c.pinned ? "unpin" : "keeps this entry on top and safe from clear";
        if (c.pinned) pin.classList.add("nd-on");
        list.append(h("div", { class: "nd-clipr" }, pin, h("i", { class: "nd-dim", text: when(c.time) }), body, extra));
        if (open === c.id) list.append(h("div", { class: "nd-more" },
          h("span", { class: "nd-row" }, c.kind === "text" ? tools.map(([op, label]) => btn(label, async () => {
            try { await api("clipTool", c.id, op); log("clipboard: " + label + " version copied"); } catch (e) {}
            open = null; refresh();
          })) : h("span", { class: "nd-dim", text: "pictures stay in memory only" })),
          btn("delete", async () => { try { await api("clipDelete", c.id); } catch (e) {} open = null; refresh(); }, "nd-danger")));
      }
    }
    async function load() {
      let r; try { r = await api("clips", query); } catch (e) { list.textContent = e.message; return; }
      const s = JSON.stringify(r.cfg) + "|" + query + "|" + r.items.map(c => c.id + (c.pinned ? "p" : "") + c.time).join("|");
      if (s === sig && list.childNodes.length) return;
      sig = s; items = r.items; cfg = r.cfg; render();
    }
    root.append(h("div", { class: "nd-row" }, search, bPause, bKeep, sMax, bClear), note, list);
    onTab.clipboard = load;
    setInterval(() => { if (active === "clipboard") load(); }, 1500);
  })();

  /* ---------- notes ---------- */
  (function () {
    const root = $c("notes"); if (!root) return;
    const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const two = n => String(n).padStart(2, "0");
    const stamp = ms => { const d = new Date(ms); return two(d.getDate()) + "." + two(d.getMonth() + 1) + "." + d.getFullYear() + " " + two(d.getHours()) + ":" + two(d.getMinutes()); };
    let notes = store.get("notes2", null), fresh = false;
    if (!Array.isArray(notes)) { // first start with several notes: the old single note becomes the first one
      const old = String(store.get("notes", "") || ""); fresh = !old;
      notes = [{ id: uid(), title: "notes", text: old, pinned: false, locked: false, changed: Date.now() }];
    }
    let cur = store.get("notescur", null), query = "", check = false, sureDel = false, saveT = null, fileT = null, font = store.get("notesfont", "s");
    const shown = {}; // locked notes that were opened in this session
    if (!notes.some(n => n.id === cur)) cur = notes.length ? notes[0].id : null;
    const get = () => notes.find(n => n.id === cur) || null;
    const status = h("span", { class: "nd-dim", text: "saved automatically" }), info = h("span", { class: "nd-dim" });
    function persist() { // in the app's own storage right away, and as a backup file a moment later
      store.set("notes2", notes); store.set("notescur", cur);
      clearTimeout(fileT); fileT = setTimeout(() => { api("notesBackup", JSON.stringify(notes)).catch(() => {}); }, 1500);
    }
    function touch(n) {
      n.changed = Date.now(); status.textContent = "saving..."; clearTimeout(saveT);
      saveT = setTimeout(() => { persist(); status.textContent = "saved " + new Date().toTimeString().slice(0, 8); renderList(); }, 400);
      details();
    }
    const search = h("input", { class: "nd-input", placeholder: "search notes", spellcheck: "false" });
    search.addEventListener("input", () => { query = search.value.trim().toLowerCase(); renderList(); });
    const list = h("div", { class: "nd-nlist" });
    const title = h("input", { class: "nd-input nd-grow", placeholder: "title", maxlength: "60", spellcheck: "false" });
    const ta = h("textarea", { class: "nd-input nd-notes", placeholder: "type here...  lines that start with \"- \" become a to-do list (press checklist)", spellcheck: "false" });
    const todos = h("div", { class: "nd-ntodos" }), cover = h("div", { class: "nd-ncover", text: "locked - click to show" });
    title.addEventListener("input", () => { const n = get(); if (n) { n.title = title.value; touch(n); } });
    ta.addEventListener("input", () => { const n = get(); if (n) { n.text = ta.value; touch(n); } });
    cover.addEventListener("click", () => { if (cur) { shown[cur] = true; renderNote(); } });
    function select(id) { cur = id; sureDel = false; store.set("notescur", cur); renderList(); renderNote(); }
    function add(t, text) {
      const n = { id: uid(), title: t || "new note", text: text || "", pinned: false, locked: false, changed: Date.now() };
      notes.push(n); persist(); select(n.id); return n;
    }
    function insert(s) {
      const n = get(); if (!n || (n.locked && !shown[n.id])) return;
      if (check) n.text += (n.text && !n.text.endsWith("\n") ? "\n" : "") + s;
      else { ta.focus(); ta.setRangeText(s, ta.selectionStart, ta.selectionEnd, "end"); n.text = ta.value; }
      touch(n); if (check) renderNote();
    }
    const bNew = btn("new", () => { const n = add(); log("notes: new note"); title.focus(); title.select(); return n; });
    const bPin = btn("pin", () => { const n = get(); if (!n) return; n.pinned = !n.pinned; persist(); renderList(); renderNote(); });
    const bLock = btn("lock", () => { const n = get(); if (!n) return; n.locked = !n.locked; delete shown[n.id]; persist(); renderList(); renderNote(); });
    const bCheck = btn("checklist", () => { check = !check; renderNote(); });
    const bDate = btn("date", () => insert(stamp(Date.now())));
    const bPaste = btn("paste", async () => { try { const t = await api("clipRead"); if (t) insert(t); else log("notes: the clipboard has no text"); } catch (e) { log("notes: " + e.message); } });
    const bExport = btn("export", async () => {
      const n = get(); if (!n) return;
      try { const f = await api("notesExport", n.title, n.text); if (f) log("notes: saved " + f); } catch (e) { log("notes: could not save the file - " + e.message); }
    });
    const bImport = btn("import", async () => {
      try { const f = await api("notesImport"); if (f) { add(f.name, f.text); log("notes: opened " + f.name + " as a new note"); } } catch (e) { log("notes: " + e.message); }
    });
    const bDel = btn("delete", () => {
      const n = get(); if (!n) return;
      if (!sureDel) { sureDel = true; renderNote(); return; }
      notes = notes.filter(x => x !== n); log("notes: deleted " + (n.title || "untitled"));
      cur = notes.length ? notes.slice().sort((a, b) => b.changed - a.changed)[0].id : null; sureDel = false; persist(); renderList(); renderNote();
    });
    const fonts = [["s", "S"], ["m", "M"], ["l", "L"]].map(([k, label]) => { const b = btn(label, () => { font = k; store.set("notesfont", k); renderNote(); }); b.dataset.font = k; b.title = "text size"; return b; });
    function details() {
      const n = get(); if (!n) { info.textContent = ""; return; }
      const hidden = n.locked && !shown[n.id], w = (n.text.trim().match(/\S+/g) || []).length;
      info.textContent = (hidden ? "" : w + (w === 1 ? " word, " : " words, ") + n.text.length + " characters  -  ") + "changed " + stamp(n.changed);
    }
    function renderList() {
      list.textContent = "";
      const m = notes.filter(n => !query || String(n.title).toLowerCase().includes(query) || (!n.locked && n.text.toLowerCase().includes(query)))
        .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.changed - a.changed));
      if (!m.length) list.append(h("span", { class: "nd-dim", text: query ? "nothing found" : "no notes" }));
      for (const n of m) {
        const first = n.locked ? "locked" : (n.text.split("\n").find(l => l.trim()) || "empty").replace(/^\s*- (\[[ xX]\] )?/, "").slice(0, 40);
        const el = h("div", { class: "nd-nitem" + (n.id === cur ? " nd-on" : ""), title: n.title }, (n.pinned ? "* " : "") + (n.title || "untitled"), h("small", { text: first }));
        el.addEventListener("click", () => select(n.id));
        list.append(el);
      }
    }
    function drawTodos(n) {
      todos.textContent = "";
      const lines = n.text.split("\n"); let any = false;
      lines.forEach((ln, i) => {
        const m = /^(\s*)- (?:\[( |x|X)\] )?(.*)$/.exec(ln);
        if (m) {
          any = true;
          const done = String(m[2] || "").toLowerCase() === "x", cb = h("input", { type: "checkbox" }); cb.checked = done;
          cb.addEventListener("change", () => { lines[i] = m[1] + "- [" + (cb.checked ? "x" : " ") + "] " + m[3]; n.text = lines.join("\n"); ta.value = n.text; touch(n); drawTodos(n); });
          todos.append(h("label", { class: "nd-ntodo" + (done ? " nd-done" : "") }, cb, h("span", { text: m[3] })));
        } else if (ln.trim()) todos.append(h("div", { class: "nd-ntext", text: ln }));
      });
      if (!any) todos.append(h("span", { class: "nd-dim", text: "no to-do lines yet - add one below, or start a line with \"- \"" }));
      const item = h("input", { class: "nd-input nd-grow", placeholder: "new to-do", maxlength: "200" });
      const addItem = () => { const v = item.value.trim(); if (!v) return; n.text += (n.text && !n.text.endsWith("\n") ? "\n" : "") + "- [ ] " + v; ta.value = n.text; touch(n); drawTodos(n); const el = todos.querySelector(".nd-nadd input"); if (el) el.focus(); };
      item.addEventListener("keydown", e => { if (e.key === "Enter") addItem(); });
      todos.append(h("div", { class: "nd-row nd-nadd" }, item, btn("add", addItem)));
    }
    function renderNote() {
      const n = get(), hidden = !!n && n.locked && !shown[n.id];
      for (const el of [title, bPin, bLock, bCheck, bDate, bPaste, bExport, bDel]) el.disabled = !n;
      title.value = n ? n.title : ""; ta.value = n ? n.text : "";
      bPin.classList.toggle("nd-on", !!n && n.pinned); bLock.classList.toggle("nd-on", !!n && n.locked); bCheck.classList.toggle("nd-on", check);
      bDel.textContent = sureDel ? "really delete?" : "delete"; bDel.classList.toggle("nd-danger", sureDel);
      for (const b of fonts) b.classList.toggle("nd-on", b.dataset.font === font);
      for (const el of [ta, todos]) { el.classList.remove("nd-nf-s", "nd-nf-m", "nd-nf-l"); el.classList.add("nd-nf-" + font); }
      cover.style.display = hidden ? "" : "none";
      ta.style.display = n && !hidden && !check ? "" : "none";
      todos.style.display = n && !hidden && check ? "" : "none";
      if (n && !hidden && check) drawTodos(n);
      if (!n) { cover.style.display = ""; cover.textContent = "no note selected - press new"; } else cover.textContent = "locked - click to show";
      details();
    }
    root.append(h("div", { class: "nd-nwrap" },
      h("div", { class: "nd-nside" }, search, h("div", { class: "nd-row" }, bNew, bImport), list),
      h("div", { class: "nd-nmain" },
        h("div", { class: "nd-row" }, title, bPin, bLock, bDel),
        h("div", { class: "nd-row" }, bCheck, bDate, bPaste, bExport, h("span", { class: "nd-dim", text: "size" }), fonts),
        ta, todos, cover, h("div", { class: "nd-row" }, info, status))));
    renderList(); renderNote();
    if (fresh) api("notesRestore").then(saved => { // nothing stored yet: bring the backup file back, if there is one
      if (Array.isArray(saved) && saved.length && notes.length === 1 && !notes[0].text) {
        notes = saved.filter(n => n && n.id).map(n => ({ id: String(n.id), title: String(n.title || ""), text: String(n.text || ""), pinned: !!n.pinned, locked: !!n.locked, changed: Number(n.changed) || Date.now() }));
        cur = notes.length ? notes[0].id : null; store.set("notes2", notes); renderList(); renderNote(); log("notes: restored " + notes.length + " from the backup file");
      }
    }).catch(() => {});
    else persist();
  })();

  /* ---------- timers ---------- */
  (function () {
    const root = $c("timers"); if (!root) return;
    const two = n => String(n).padStart(2, "0"), uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const dim = t => h("span", { class: "nd-dim", text: t }), sub = t => h("div", { class: "nd-sub", text: t });
    const MAXCD = 359999000; // longest countdown: 99:59:59
    const fmt = ms => { const s = Math.max(0, Math.ceil(ms / 1000)), hh = Math.floor(s / 3600); return (hh ? hh + ":" + two(Math.floor(s % 3600 / 60)) : Math.floor(s / 60)) + ":" + two(s % 60); };
    const fmtSw = ms => { const t = Math.floor(ms / 100), s = Math.floor(t / 10), hh = Math.floor(s / 3600); return (hh ? hh + ":" + two(Math.floor(s % 3600 / 60)) : two(Math.floor(s / 60))) + ":" + two(s % 60) + "." + (t % 10); };
    function parse(v) {
      v = String(v).trim(); if (!v) return 0;
      const p = v.split(":").map(Number); if (p.length > 3 || p.some(x => !isFinite(x) || x < 0)) return 0;
      return Math.min(MAXCD, Math.round((p.length === 1 ? p[0] * 60 : p.length === 2 ? p[0] * 60 + p[1] : p[0] * 3600 + p[1] * 60 + p[2]) * 1000));
    }
    // everything is remembered, so timers keep running across tab changes, "update" and a restart of the app
    let st = store.get("timers3", null); if (!st || typeof st !== "object") st = {};
    st.timers = Array.isArray(st.timers) ? st.timers : []; st.alarms = Array.isArray(st.alarms) ? st.alarms : []; st.presets = Array.isArray(st.presets) ? st.presets : [];
    st.sw = st.sw || { start: null, acc: 0, laps: [] }; st.sound = st.sound || "chime";
    const POMO = { work: 25 * 60000, break: 5 * 60000, long: 15 * 60000 };
    st.pomo = st.pomo || { state: "idle", phase: "work", round: 1, end: null, left: POMO.work };
    const save = () => store.set("timers3", st);

    // finish signal: a Windows notification, the window flashes, and a sound that repeats until stopped
    let actx = null, ringT = null;
    function tone(kind) {
      if (kind === "silent") return;
      try {
        actx = actx || new (window.AudioContext || window.webkitAudioContext)(); const t0 = actx.currentTime;
        const notes = kind === "alarm" ? [[880, 0, .14], [880, .2, .14], [880, .4, .14], [880, .6, .14]] : kind === "beep" ? [[1000, 0, .25]] : [[660, 0, .22], [880, .24, .22], [1320, .48, .4]];
        for (const [f, at, len] of notes) {
          const o = actx.createOscillator(), g = actx.createGain(); o.type = kind === "alarm" ? "square" : "sine"; o.frequency.value = f;
          g.gain.setValueAtTime(0.0001, t0 + at); g.gain.exponentialRampToValueAtTime(kind === "alarm" ? 0.12 : 0.25, t0 + at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
          o.connect(g); g.connect(actx.destination); o.start(t0 + at); o.stop(t0 + at + len + 0.05);
        }
      } catch (e) {}
    }
    const bStop = btn("stop sound", () => stopRing(), "nd-danger");
    function stopRing() { clearInterval(ringT); ringT = null; bStop.style.display = "none"; }
    function ring(text) {
      api("timerDone", text, true).catch(() => {}); log(text); stopRing();
      if (st.sound === "silent") return;
      tone(st.sound); let n = 0;
      ringT = setInterval(() => { if (++n >= 30) stopRing(); else tone(st.sound); }, 2000); bStop.style.display = "";
    }
    const sSound = h("select", { class: "nd-input", title: "sound when a timer ends" });
    for (const k of ["chime", "alarm", "beep", "silent"]) sSound.append(h("option", { value: k, text: k }));
    sSound.value = st.sound; sSound.addEventListener("change", () => { st.sound = sSound.value; save(); });

    // countdowns
    const tList = h("div", { class: "nd-tlist" }), presetRow = h("div", { class: "nd-row" });
    const tName = h("input", { class: "nd-input", placeholder: "name (optional)", maxlength: "30", size: "16" });
    const tTime = h("input", { class: "nd-input", placeholder: "minutes or m:ss", size: "14", maxlength: "8" });
    tTime.value = String(store.get("cd", "5")).slice(0, 8);
    function addTimer(ms, name) {
      if (!ms) { log("timers: enter minutes, or m:ss"); return; }
      const nm = String(name || "").trim() || fmt(ms) + " timer";
      st.timers.push({ id: uid(), name: nm, total: ms, end: Date.now() + ms, left: ms, state: "run" }); save(); log("timer started: " + nm); drawTimers();
    }
    const addFromForm = () => { store.set("cd", tTime.value.trim()); addTimer(parse(tTime.value), tName.value); tName.value = ""; };
    tTime.addEventListener("keydown", e => { if (e.key === "Enter") addFromForm(); });
    function drawPresets() {
      presetRow.textContent = "";
      for (const m of [1, 5, 10, 15, 30, 60]) presetRow.append(btn(m + " min", () => { addTimer(m * 60000, tName.value); tName.value = ""; }));
      st.presets.forEach((ms, i) => presetRow.append(h("span", { class: "nd-preset" },
        btn(fmt(ms), () => { addTimer(ms, tName.value); tName.value = ""; }), h("button", { class: "nd-btn", text: "x", title: "Remove this preset", onclick: () => { st.presets.splice(i, 1); save(); drawPresets(); } }))));
    }
    const bPreset = btn("save as preset", () => {
      const ms = parse(tTime.value); if (!ms) { log("timers: enter minutes, or m:ss"); return; }
      if (!st.presets.includes(ms)) { st.presets.push(ms); st.presets = st.presets.slice(-8); save(); drawPresets(); }
    });
    function drawTimers() {
      tList.textContent = "";
      if (!st.timers.length) tList.append(dim("no countdown yet - press a preset or add one"));
      for (const t of st.timers) {
        const acts = h("span", { class: "nd-row" });
        if (t.state === "run") acts.append(btn("pause", () => { t.left = Math.max(0, t.end - Date.now()); t.state = "pause"; save(); drawTimers(); }));
        else if (t.state === "pause") acts.append(btn("resume", () => { t.end = Date.now() + t.left; t.state = "run"; save(); drawTimers(); }, "nd-on"));
        acts.append(btn("restart", () => { t.left = t.total; t.end = Date.now() + t.total; t.state = "run"; stopRing(); save(); drawTimers(); }),
          h("button", { class: "nd-btn", text: "x", title: "Remove", onclick: () => { st.timers = st.timers.filter(x => x !== t); stopRing(); save(); drawTimers(); } }));
        tList.append(h("div", { class: "nd-trow" },
          h("div", { class: "nd-meter", "data-meter": "tm-" + t.id }, h("div", null, t.name, h("output")), h("div", { class: "nd-meterbar" }, h("i"))), acts));
      }
      tick();
    }

    // alarms at a clock time
    const aList = h("div", { class: "nd-table" }), aTime = h("input", { class: "nd-input", type: "time" });
    const aName = h("input", { class: "nd-input", placeholder: "name (optional)", maxlength: "30", size: "16" });
    let aRepeat = false; const bRepeat = btn("every day", () => { aRepeat = !aRepeat; bRepeat.classList.toggle("nd-on", aRepeat); });
    function drawAlarms() {
      aList.textContent = "";
      if (!st.alarms.length) aList.append(dim("no alarm set"));
      for (const a of st.alarms.slice().sort((x, y) => x.time.localeCompare(y.time))) {
        const b = btn(a.on ? "on" : "off", () => { a.on = !a.on; a.last = ""; save(); drawAlarms(); }); if (a.on) b.classList.add("nd-on");
        aList.append(h("div", { class: "nd-tr nd-al" }, h("span", { text: a.time }), h("span", { text: a.name || "alarm" }), h("span", { class: "nd-dim", text: a.repeat ? "every day" : "once" }),
          h("span", { class: "nd-row" }, b, h("button", { class: "nd-btn", text: "x", title: "Remove", onclick: () => { st.alarms = st.alarms.filter(x => x !== a); save(); drawAlarms(); } }))));
      }
    }
    const bAlarm = btn("add alarm", () => {
      if (!/^\d\d:\d\d/.test(aTime.value)) { log("timers: pick a time for the alarm"); return; }
      const t = aTime.value.slice(0, 5), now = new Date();
      // an alarm for a time that has already passed today waits for tomorrow
      st.alarms.push({ id: uid(), time: t, name: aName.value.trim(), repeat: aRepeat, on: true, last: t <= two(now.getHours()) + ":" + two(now.getMinutes()) ? now.toDateString() : "" });
      save(); log("alarm set for " + t); aName.value = ""; drawAlarms();
    });

    // stopwatch with laps
    const swOut = h("div", { class: "nd-big", text: "00:00.0" }), laps = h("div", { class: "nd-table nd-laps" });
    const swTotal = () => st.sw.acc + (st.sw.start ? Date.now() - st.sw.start : 0);
    const bSw = btn("start", () => { if (st.sw.start) { st.sw.acc = swTotal(); st.sw.start = null; } else st.sw.start = Date.now(); save(); drawSw(); });
    const bLap = btn("lap", () => { if (!st.sw.start) return; st.sw.laps.push(swTotal()); st.sw.laps = st.sw.laps.slice(-50); save(); drawSw(); });
    const bSwReset = btn("reset", () => { st.sw = { start: null, acc: 0, laps: [] }; save(); drawSw(); });
    function drawSw() {
      bSw.textContent = st.sw.start ? "stop" : "start"; bSw.classList.toggle("nd-on", !st.sw.start); bLap.disabled = !st.sw.start;
      laps.textContent = "";
      st.sw.laps.forEach((t, i) => laps.prepend(h("div", { class: "nd-tr nd-lap" }, h("span", { class: "nd-dim", text: "lap " + (i + 1) }), h("span", { text: fmtSw(t - (i ? st.sw.laps[i - 1] : 0)) }), h("span", { text: fmtSw(t) }))));
      swOut.textContent = fmtSw(swTotal());
    }

    // pomodoro: 25 minutes work, 5 break, a 15 minute break after four rounds
    const pOut = h("div", { class: "nd-big", text: "25:00" }), pInfo = h("span", { class: "nd-dim" });
    const pLeft = () => st.pomo.state === "run" ? st.pomo.end - Date.now() : st.pomo.left;
    const bPomo = btn("start", () => {
      const p = st.pomo;
      if (p.state === "run") { p.left = Math.max(0, p.end - Date.now()); p.state = "pause"; } else { p.end = Date.now() + p.left; p.state = "run"; }
      save(); drawPomo();
    });
    const bPomoReset = btn("reset", () => { st.pomo = { state: "idle", phase: "work", round: 1, end: null, left: POMO.work }; save(); drawPomo(); });
    function drawPomo() {
      const p = st.pomo;
      bPomo.textContent = p.state === "run" ? "pause" : p.state === "pause" ? "resume" : "start"; bPomo.classList.toggle("nd-on", p.state !== "run");
      pInfo.textContent = (p.phase === "work" ? "work" : p.phase === "long" ? "long break" : "break") + "   round " + p.round + " of 4" + (p.state === "pause" ? "   paused" : "");
      pOut.textContent = fmt(pLeft());
    }

    const tab = document.querySelector('.nd-tab[data-tab="timers"]');
    function tick() {
      const now = Date.now(); let near = null;
      for (const t of st.timers) {
        let left = t.state === "run" ? t.end - now : t.state === "pause" ? t.left : t.state === "done" ? 0 : t.total;
        if (t.state === "run" && left <= 0) { t.state = "done"; save(); ring(t.name + " - time is up"); drawTimers(); return; }
        panel.setMeter("tm-" + t.id, (1 - left / t.total) * 100, t.state === "done" ? "done" : fmt(left) + (t.state === "pause" ? "  paused" : ""));
        if (t.state === "run" && (near == null || left < near)) near = left;
      }
      const d = new Date(now), hm = two(d.getHours()) + ":" + two(d.getMinutes()), day = d.toDateString();
      for (const a of st.alarms) if (a.on && a.time === hm && a.last !== day) {
        a.last = day; if (!a.repeat) a.on = false; save(); ring((a.name || "alarm") + " - " + a.time); drawAlarms();
      }
      if (st.sw.start) swOut.textContent = fmtSw(swTotal());
      const p = st.pomo;
      if (p.state === "run") {
        if (p.end - now <= 0) {
          if (p.phase === "work") { p.phase = p.round % 4 === 0 ? "long" : "break"; ring("pomodoro: round " + p.round + " done - take a " + (p.phase === "long" ? "long " : "") + "break"); }
          else { p.round = p.phase === "long" ? 1 : p.round + 1; p.phase = "work"; ring("pomodoro: break over - back to work"); }
          p.left = POMO[p.phase]; p.end = now + p.left; save(); drawPomo();
        }
        pOut.textContent = fmt(p.end - now);
        if (near == null || p.end - now < near) near = p.end - now;
      }
      if (tab) { if (near != null) tab.dataset.badge = fmt(near); else delete tab.dataset.badge; } // remaining time next to the tab name
    }

    // timers that ran out while Nightdeck was closed
    for (const t of st.timers) if (t.state === "run" && t.end < Date.now() - 3000) { t.state = "done"; log(t.name + " ended while nightdeck was closed"); }
    if (st.pomo.state === "run" && st.pomo.end < Date.now() - 3000) { st.pomo.state = "pause"; st.pomo.left = POMO[st.pomo.phase]; }
    save(); bStop.style.display = "none";
    root.append(sub("countdowns"),
      h("div", { class: "nd-row" }, tName, tTime, btn("start", addFromForm, "nd-on"), bPreset), presetRow, tList,
      h("div", { class: "nd-row" }, dim("sound"), sSound, btn("test", () => tone(st.sound)), bStop),
      sub("alarms"), h("div", { class: "nd-row" }, aTime, aName, bRepeat, bAlarm), aList,
      h("div", { class: "nd-two" },
        h("div", null, sub("stopwatch"), swOut, h("div", { class: "nd-row" }, bSw, bLap, bSwReset), laps),
        h("div", null, sub("pomodoro"), pOut, h("div", { class: "nd-row" }, bPomo, bPomoReset), pInfo)));
    drawPresets(); drawTimers(); drawAlarms(); drawSw(); drawPomo();
    setInterval(tick, 250);
  })();

  /* ---------- screenshot ---------- */
  (function () {
    const root = $c("capture"); if (!root) return;
    const dim = t => h("span", { class: "nd-dim", text: t }), sub = t => h("div", { class: "nd-sub", text: t });
    const two = n => String(n).padStart(2, "0");
    let cfg = { format: "png", copy: false, hotkey: false, accel: "Control+Alt+P", screen: "", dirShown: "" }, busy = false, sureDel = "";
    const opt = { hide: !!store.get("shothide", true), edit: !!store.get("shotedit", false), delay: Number(store.get("shotdelay", 0)) || 0 };
    const status = dim("");
    const toggle = (label, get, set) => { const b = btn(label, async () => { await set(!get()); b.classList.toggle("nd-on", !!get()); }); b.classList.toggle("nd-on", !!get()); return b; };
    async function setCfg(o) { try { cfg = await api("capSet", o); } catch (e) { log("capture: " + e.message); } drawCfg(); return cfg; }

    // what to capture
    const sTarget = h("select", { class: "nd-input", title: "which screen to capture" });
    sTarget.addEventListener("change", () => { if (sTarget.value !== "all") setCfg({ screen: sTarget.value }); });
    const sDelay = h("select", { class: "nd-input", title: "wait before capturing" });
    for (const s of [0, 3, 5, 10]) sDelay.append(h("option", { value: String(s), text: s ? s + " s delay" : "no delay" }));
    sDelay.value = String(opt.delay); sDelay.addEventListener("change", () => { opt.delay = Number(sDelay.value); store.set("shotdelay", opt.delay); });
    const bHide = toggle("hide nightdeck", () => opt.hide, v => { opt.hide = v; store.set("shothide", v); });
    const bEdit = toggle("edit before saving", () => opt.edit, v => { opt.edit = v; store.set("shotedit", v); });
    const bCopy = toggle("copy to clipboard", () => cfg.copy, v => setCfg({ copy: v }));
    function fillTargets(screens) {
      const keep = sTarget.value || cfg.screen; sTarget.textContent = ""; sRec.textContent = "";
      for (const s of screens) { sTarget.append(h("option", { value: s.id, text: s.label })); if (s.sid) sRec.append(h("option", { value: s.sid, text: s.label })); }
      if (screens.length > 1) sTarget.append(h("option", { value: "all", text: "all screens in one picture" }));
      if ([...sTarget.options].some(o => o.value === keep)) sTarget.value = keep;
    }
    const loadImg = url => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error("the picture could not be read")); im.src = url; });
    async function compose(images) { // puts the pictures of several screens side by side as they stand on the desk
      const minX = Math.min(...images.map(i => i.x)), minY = Math.min(...images.map(i => i.y));
      const cv = document.createElement("canvas"); cv.width = Math.max(...images.map(i => i.x + i.w)) - minX; cv.height = Math.max(...images.map(i => i.y + i.h)) - minY;
      const g = cv.getContext("2d"); g.fillStyle = "#000"; g.fillRect(0, 0, cv.width, cv.height);
      for (const i of images) g.drawImage(await loadImg(i.url), i.x - minX, i.y - minY, i.w, i.h);
      return cv;
    }
    function done(r) {
      status.textContent = "saved: " + r.file + (r.copied ? "  (also copied)" : "");
      log("screenshot saved (" + r.width + " x " + r.height + ")" + (r.copied ? " and copied" : "")); loadRecent();
    }
    async function shoot(kind, id, region) {
      if (busy) return; busy = true;
      try {
        for (let s = opt.delay; s > 0; s--) { status.textContent = "capturing in " + s + " ..."; await new Promise(r => setTimeout(r, 1000)); }
        status.textContent = "capturing ...";
        const edit = region || opt.edit;
        if (!edit && kind !== "all") done(await api("capShot", { kind, id, hide: opt.hide }));
        else {
          const cv = await compose((await api("capGrab", { kind, id, hide: opt.hide })).images);
          if (edit) openEditor(cv, region ? "crop" : "arrow"); else done(await api("capSave", cv.toDataURL("image/png")));
        }
      } catch (e) { status.textContent = "capture failed: " + e.message; log("screenshot failed: " + e.message); }
      busy = false;
    }
    const target = () => sTarget.value === "all" ? ["all", ""] : ["screen", sTarget.value];
    const bShot = btn("take screenshot", () => shoot(...target(), false), "nd-on");
    const bRegion = btn("select a region", () => shoot(...target(), true));

    // single window
    const picker = h("div", { class: "nd-wpick" }); picker.style.display = "none";
    const bWin = btn("pick a window", async () => {
      const show = picker.style.display === "none"; picker.style.display = show ? "" : "none"; bWin.classList.toggle("nd-on", show);
      if (!show) return;
      picker.textContent = ""; picker.append(dim("reading the open windows ..."));
      try {
        const s = await api("capSources", true); picker.textContent = "";
        if (!s.windows.length) picker.append(dim("no capturable windows found - minimised windows do not show up"));
        for (const w of s.windows) {
          const b = h("button", { class: "nd-btn nd-wthumb", title: w.name }, h("img", { src: w.thumb, alt: "" }), h("span", { text: w.name }));
          b.addEventListener("click", () => { picker.style.display = "none"; bWin.classList.remove("nd-on"); shoot("window", w.sid, false); });
          picker.append(b);
        }
      } catch (e) { picker.textContent = ""; picker.append(dim(e.message)); }
    });

    // editor: cut out a region, draw arrows, boxes and text, then save
    const ed = h("div", { class: "nd-ed" }); ed.style.display = "none";
    const edCv = h("canvas", { class: "nd-edcv" }), edText = h("input", { class: "nd-input", placeholder: "text to place", maxlength: "80", size: "18" });
    let base = null, shapes = [], crop = null, tool = "arrow", color = "#ff4d4d", drag = null;
    const lw = () => Math.max(3, Math.round(base.width / 450)), fsz = () => Math.max(18, Math.round(base.width / 45));
    function drawShapes(g, k, list) {
      for (const s of list) {
        g.strokeStyle = g.fillStyle = s.color; g.lineWidth = Math.max(1.5, lw() * k); g.lineCap = "round"; g.lineJoin = "round"; g.setLineDash([]);
        if (s.type === "box") g.strokeRect(Math.min(s.x1, s.x2) * k, Math.min(s.y1, s.y2) * k, Math.abs(s.x2 - s.x1) * k, Math.abs(s.y2 - s.y1) * k);
        else if (s.type === "arrow") {
          const a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1), hl = lw() * 5 * k;
          g.beginPath(); g.moveTo(s.x1 * k, s.y1 * k); g.lineTo(s.x2 * k, s.y2 * k);
          g.moveTo(s.x2 * k - hl * Math.cos(a - 0.45), s.y2 * k - hl * Math.sin(a - 0.45)); g.lineTo(s.x2 * k, s.y2 * k); g.lineTo(s.x2 * k - hl * Math.cos(a + 0.45), s.y2 * k - hl * Math.sin(a + 0.45)); g.stroke();
        } else if (s.type === "text") {
          g.font = "600 " + fsz() * k + "px 'Segoe UI', Arial, sans-serif"; g.textBaseline = "top"; g.lineWidth = Math.max(2, fsz() * k / 7); g.strokeStyle = "rgba(0,0,0,.75)";
          g.strokeText(s.text, s.x1 * k, s.y1 * k); g.fillText(s.text, s.x1 * k, s.y1 * k);
        }
      }
    }
    const norm = d => ({ x: Math.round(Math.min(d.x1, d.x2)), y: Math.round(Math.min(d.y1, d.y2)), w: Math.round(Math.abs(d.x2 - d.x1)), h: Math.round(Math.abs(d.y2 - d.y1)) });
    function drawEd() {
      if (!base) return;
      const W = Math.max(200, ed.clientWidth || 440), k = W / base.width, H = Math.round(base.height * k), dpr = window.devicePixelRatio || 1;
      edCv.style.height = H + "px"; edCv.width = Math.round(W * dpr); edCv.height = Math.round(H * dpr);
      const g = edCv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.drawImage(base, 0, 0, W, H);
      drawShapes(g, k, drag && tool !== "crop" ? shapes.concat([Object.assign({ type: tool, color }, drag)]) : shapes);
      const c = drag && tool === "crop" ? norm(drag) : crop;
      if (c && c.w > 2 && c.h > 2) { // everything outside the chosen region is dimmed
        g.fillStyle = "rgba(0,0,0,.6)"; g.fillRect(0, 0, W, c.y * k); g.fillRect(0, (c.y + c.h) * k, W, H - (c.y + c.h) * k);
        g.fillRect(0, c.y * k, c.x * k, c.h * k); g.fillRect((c.x + c.w) * k, c.y * k, W - (c.x + c.w) * k, c.h * k);
        g.setLineDash([5, 4]); g.lineWidth = 1; g.strokeStyle = "#9bd64a"; g.strokeRect(c.x * k + .5, c.y * k + .5, c.w * k, c.h * k); g.setLineDash([]);
      }
      edInfo.textContent = (crop ? crop.w + " x " + crop.h + " cut from " : "") + base.width + " x " + base.height;
      for (const b of toolBtns) b.classList.toggle("nd-on", b.dataset.tool === tool);
      for (const b of colBtns) b.classList.toggle("nd-on", b.dataset.col === color);
    }
    const pos = e => { const r = edCv.getBoundingClientRect(); return [Math.max(0, Math.min(base.width, (e.clientX - r.left) / r.width * base.width)), Math.max(0, Math.min(base.height, (e.clientY - r.top) / r.height * base.height))]; };
    edCv.addEventListener("pointerdown", e => {
      if (!base) return; const [x, y] = pos(e);
      if (tool === "text") { const t = edText.value.trim(); if (!t) { log("capture: type the text first, then click where it should go"); edText.focus(); return; } shapes.push({ type: "text", x1: x, y1: y, text: t, color }); drawEd(); return; }
      drag = { x1: x, y1: y, x2: x, y2: y }; try { edCv.setPointerCapture(e.pointerId); } catch (x) {}
    });
    edCv.addEventListener("pointermove", e => { if (!drag) return; const [x, y] = pos(e); drag.x2 = x; drag.y2 = y; drawEd(); });
    const endDrag = () => {
      if (!drag) return; const d = drag; drag = null;
      if (Math.abs(d.x2 - d.x1) + Math.abs(d.y2 - d.y1) > 8) { if (tool === "crop") crop = norm(d); else shapes.push(Object.assign({ type: tool, color }, d)); }
      drawEd();
    };
    edCv.addEventListener("pointerup", endDrag); edCv.addEventListener("pointercancel", endDrag);
    const toolBtns = [["crop", "region"], ["arrow", "arrow"], ["box", "box"], ["text", "text"]].map(([k, label]) => { const b = btn(label, () => { tool = k; drawEd(); }); b.dataset.tool = k; return b; });
    const colBtns = ["#ff4d4d", "#ffd34d", "#9bd64a", "#4fc3d9", "#ffffff"].map(c => { const b = h("button", { class: "nd-btn nd-col", title: "colour", onclick: () => { color = c; drawEd(); } }); b.style.background = c; b.dataset.col = c; return b; });
    const edInfo = dim("");
    function closeEditor(msg) { base = null; shapes = []; crop = null; drag = null; ed.style.display = "none"; if (msg) status.textContent = msg; }
    function exportCv() {
      const c = crop || { x: 0, y: 0, w: base.width, h: base.height }, cv = document.createElement("canvas"); cv.width = Math.max(1, c.w); cv.height = Math.max(1, c.h);
      const g = cv.getContext("2d"); g.translate(-c.x, -c.y); g.drawImage(base, 0, 0); drawShapes(g, 1, shapes); return cv;
    }
    function openEditor(cv, startTool) {
      base = cv; shapes = []; crop = null; drag = null; tool = startTool; ed.style.display = ""; drawEd();
      status.textContent = startTool === "crop" ? "drag over the part you want, then press save" : "draw on the capture, then press save";
      try { ed.scrollIntoView({ block: "nearest" }); } catch (e) {}
    }
    ed.append(h("div", { class: "nd-row" }, toolBtns, colBtns, edText),
      h("div", { class: "nd-row" }, btn("undo", () => { if (shapes.length) shapes.pop(); else crop = null; drawEd(); }), btn("whole picture", () => { crop = null; drawEd(); }),
        btn("save", async () => { try { const r = await api("capSave", exportCv().toDataURL("image/png")); closeEditor(); done(r); } catch (e) { log("screenshot failed: " + e.message); } }, "nd-on"),
        btn("discard", () => closeEditor("capture discarded"), "nd-danger"), edInfo), edCv);
    if (window.ResizeObserver) new ResizeObserver(() => { if (base) drawEd(); }).observe(ed);

    // settings: format, folder, hotkey
    const sFormat = h("select", { class: "nd-input", title: "file format" });
    sFormat.append(h("option", { value: "png", text: "png - sharp" }), h("option", { value: "jpg", text: "jpg - smaller" }));
    sFormat.addEventListener("change", () => setCfg({ format: sFormat.value }));
    const dirOut = h("span", { class: "nd-dim nd-path" });
    const hk = h("input", { class: "nd-input", placeholder: "Control+Alt+P", size: "18", spellcheck: "false" }), hkState = dim("");
    const bHk = btn("hotkey", () => setCfg({ accel: hk.value.trim() || "Control+Alt+P", hotkey: !cfg.hotkey }).then(c => log(!c.hotkey ? "screenshot hotkey off" : c.hotkeyOk ? "screenshot hotkey " + c.accel + " on" : "screenshot hotkey " + c.accel + " is not available")));
    function drawCfg() {
      sFormat.value = cfg.format; dirOut.textContent = cfg.dirShown || ""; dirOut.title = cfg.dirShown || ""; bCopy.classList.toggle("nd-on", !!cfg.copy);
      if (document.activeElement !== hk) hk.value = cfg.accel || "";
      bHk.classList.toggle("nd-on", !!cfg.hotkey); hkState.textContent = !cfg.hotkey ? "off" : cfg.hotkeyOk ? "active - captures the chosen screen from anywhere" : "not available - another program uses it";
    }

    // newest captures
    const recent = h("div", { class: "nd-recent" });
    async function loadRecent() {
      let r; try { r = await api("capList"); } catch (e) { return; }
      recent.textContent = "";
      if (!r.files.length) recent.append(dim("nothing captured yet"));
      for (const f of r.files) {
        const act = (a, okMsg) => api("capDo", a, f.file).then(() => { if (okMsg) log(okMsg); if (a === "delete") loadRecent(); }).catch(e => { log("capture: " + e.message); loadRecent(); });
        const d = new Date(f.time), when = two(d.getDate()) + "." + two(d.getMonth() + 1) + ". " + two(d.getHours()) + ":" + two(d.getMinutes());
        const pic = f.video ? h("div", { class: "nd-rvid", text: "video  " + size(f.size) }) : h("img", { src: f.thumb, alt: "" });
        pic.title = "open " + f.name; pic.addEventListener("click", () => act("open"));
        const del = btn(sureDel === f.file ? "sure?" : "x", () => { if (sureDel !== f.file) { sureDel = f.file; loadRecent(); return; } sureDel = ""; act("delete", f.name + " moved to the recycle bin"); }, sureDel === f.file ? "nd-danger" : "");
        del.title = "Delete (goes to the recycle bin)";
        recent.append(h("div", { class: "nd-rcard" }, pic, h("span", { class: "nd-dim", text: when }),
          h("span", { class: "nd-row" }, f.video ? null : btn("copy", () => act("copy", f.name + " copied")), btn("folder", () => act("show")), del)));
      }
    }

    // screen recording (video only, no sound)
    let rec = null, recT = null, recAt = 0;
    const sRec = h("select", { class: "nd-input", title: "what to record" }), recInfo = dim("saved as .webm video in the capture folder, without sound");
    const bRecWin = btn("list windows", async () => {
      try { const s = await api("capSources", true); fillTargets(s.screens); for (const w of s.windows) sRec.append(h("option", { value: w.sid, text: "window: " + w.name.slice(0, 40) })); log("capture: " + s.windows.length + " windows added to the recording list"); }
      catch (e) { log("capture: " + e.message); }
    });
    function drawRec() {
      bRec.textContent = rec ? "stop recording" : "start recording"; bRec.classList.toggle("nd-danger", !!rec); bRec.classList.toggle("nd-on", !rec); sRec.disabled = !!rec; bRecWin.disabled = !!rec;
      if (rec) { const s = Math.floor((Date.now() - recAt) / 1000); recInfo.textContent = "recording  " + two(Math.floor(s / 60)) + ":" + two(s % 60); }
    }
    const bRec = btn("start recording", async () => {
      if (rec) { try { rec.stop(); } catch (e) {} return; }
      if (!sRec.value) { log("capture: nothing to record was found"); return; }
      let stream = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: sRec.value, maxFrameRate: 30, maxWidth: 3840, maxHeight: 2160 } } });
        const type = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find(t => MediaRecorder.isTypeSupported(t));
        await api("recStart");
        const mr = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8000000 }); let chain = Promise.resolve();
        mr.ondataavailable = e => { if (e.data && e.data.size) chain = chain.then(() => e.data.arrayBuffer()).then(b => api("recChunk", new Uint8Array(b))).catch(() => {}); };
        mr.onstop = async () => {
          clearInterval(recT); stream.getTracks().forEach(t => t.stop()); await chain; rec = null;
          try { const r = await api("recStop"); recInfo.textContent = r ? "saved: " + r.file : "nothing was recorded"; if (r) log("recording saved (" + size(r.size) + ")"); } catch (e) { log("recording: " + e.message); }
          drawRec(); loadRecent();
        };
        stream.getVideoTracks()[0].addEventListener("ended", () => { if (rec) { try { rec.stop(); } catch (e) {} } });
        mr.start(1000); rec = mr; recAt = Date.now(); recT = setInterval(drawRec, 500); log("recording started");
      } catch (e) {
        log("recording failed: " + e.message); if (stream) stream.getTracks().forEach(t => t.stop());
        try { await api("recStop"); } catch (x) {} rec = null;
      }
      drawRec();
    }, "nd-on");

    root.append(h("div", { class: "nd-row" }, sTarget, bShot, bRegion, bWin), picker,
      h("div", { class: "nd-row" }, sDelay, bHide, bCopy, bEdit), status, ed,
      sub("recent captures"), recent,
      sub("screen recording"), h("div", { class: "nd-row" }, sRec, bRecWin, bRec), recInfo,
      sub("settings"), h("div", { class: "nd-row" }, sFormat, btn("change folder", () => setCfg({ pickDir: true }).then(loadRecent)), btn("default folder", () => setCfg({ resetDir: true }).then(loadRecent)),
        btn("open folder", () => api("openShots").catch(e => log("could not open folder: " + e.message)))), dirOut,
      h("div", { class: "nd-row" }, bHk, hk, hkState));
    async function refresh() {
      await setCfg({});
      try { fillTargets((await api("capSources", false)).screens); } catch (e) {}
      loadRecent();
    }
    onTab.capture = () => { if (!rec) refresh(); else loadRecent(); };
    refresh();
  })();

  /* ---------- calculators and converters ---------- */
  (function () {
    const root = $c("tools"); if (!root) return;
    const num = v => parseFloat(String(v).replace(",", "."));
    const show = v => isFinite(v) ? String(+v.toPrecision(12)) : "not a number";
    // ---- shared: copy a result, and the calculation history (kept between restarts) ----
    const copy = t => api("copyText", t).then(() => log("copied " + t)).catch(e => log("copy failed: " + e.message));
    const isNum = t => /^-?[\d.]+(e[+-]?\d+)?$/i.test(t);
    let hist = store.get("calchist", []); if (!Array.isArray(hist)) hist = [];
    const histBoxes = [];
    function drawHist() {
      for (const { box, inp, run } of histBoxes) {
        box.textContent = "";
        if (!hist.length) { box.append(h("span", { class: "nd-dim", text: "press Enter to keep a result here" })); continue; }
        for (const it of hist) {
          const el = h("div", { class: "nd-hitem", title: "click to use again" }, h("span", { text: it.q }), h("output", { text: "= " + it.r }));
          el.addEventListener("click", () => { inp.value = it.q; run(); inp.focus(); }); box.append(el);
        }
      }
    }
    function keep(q, r) { hist = [{ q, r }].concat(hist.filter(x => x.q !== q)).slice(0, 30); store.set("calchist", hist); drawHist(); }
    const clearHist = () => { hist = []; store.set("calchist", hist); drawHist(); };
    // memory keys for standard and scientific (the stored number stays after a restart)
    let mem = Number(store.get("calcmem", 0)) || 0; const memOuts = [];
    function drawMem() { for (const o of memOuts) o.textContent = mem ? "memory = " + show(mem) : "memory empty"; }
    function memRow(c) {
      const o = h("span", { class: "nd-dim" }); memOuts.push(o);
      const cur = () => { const r = c.out.textContent.slice(2); return isNum(r) ? parseFloat(r) : null; };
      const set = v => { mem = v; store.set("calcmem", mem); drawMem(); };
      return h("div", { class: "nd-row nd-mem" },
        btn("MC", () => set(0)),
        btn("MR", () => { const t = "(" + show(mem) + ")", a = c.inp.selectionStart == null ? c.inp.value.length : c.inp.selectionStart; c.inp.value = c.inp.value.slice(0, a) + t + c.inp.value.slice(c.inp.selectionEnd == null ? a : c.inp.selectionEnd); c.inp.focus(); c.run(); }),
        btn("M+", () => { const v = cur(); if (v != null) set(mem + v); }), btn("M-", () => { const v = cur(); if (v != null) set(mem - v); }), o);
    }

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
    const modes = ["standard", "scientific", "graphing", "programmer", "date", "percent", "unit price", "password", "text", "converter", "colour"];
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
      inp.addEventListener("keydown", e => {
        const r = out.textContent.slice(2);
        if (e.key === "Enter" && isNum(r)) { log(label + ": " + inp.value + " = " + r); keep(inp.value.trim(), r); }
        if (e.key === "Escape") { inp.value = ""; run(); }
      });
      const cp = btn("copy", () => { const r = out.textContent.slice(2); if (isNum(r)) copy(r); });
      const box = h("div", { class: "nd-hist2" }); histBoxes.push({ box, inp, run });
      return { inp, out, run, cp, box };
    }
    const std = calcRow("e.g. (12,5 + 3) * 4", () => ({}), "calc");
    section("standard", h("div", { class: "nd-row" }, std.inp, std.out, std.cp), memRow(std),
      h("span", { class: "nd-dim", text: "+  -  *  /  %  ^  ( )   -   type on the keyboard, Enter keeps the result in the history, Escape clears" }),
      h("div", { class: "nd-row" }, h("span", { class: "nd-sub", text: "history" }), btn("clear history", clearHist)), std.box);
    onShow.standard = () => { drawHist(); std.inp.focus(); };

    // ---- scientific ----
    let deg = store.get("deg", true);
    const sci = calcRow("e.g. sin(30) + sqrt(16) * pi", () => ({ deg }), "sci");
    const degBtn = btn("", () => { deg = !deg; store.set("deg", deg); degBtn.textContent = deg ? "degrees" : "radians"; sci.run(); });
    degBtn.textContent = deg ? "degrees" : "radians";
    const fnRow = h("div", { class: "nd-row nd-fns" });
    for (const f of ["sin(", "cos(", "tan(", "asin(", "acos(", "atan(", "sqrt(", "cbrt(", "ln(", "log(", "exp(", "abs(", "pi", "e", "^", "!", "(", ")"])
      fnRow.append(btn(f, () => { const a = sci.inp.selectionStart == null ? sci.inp.value.length : sci.inp.selectionStart; sci.inp.value = sci.inp.value.slice(0, a) + f + sci.inp.value.slice(sci.inp.selectionEnd == null ? a : sci.inp.selectionEnd); sci.inp.focus(); sci.inp.selectionStart = sci.inp.selectionEnd = a + f.length; sci.run(); }));
    section("scientific", h("div", { class: "nd-row" }, sci.inp, sci.out, sci.cp), memRow(sci), h("div", { class: "nd-row" }, h("span", { class: "nd-dim", text: "angles in" }), degBtn), fnRow,
      h("span", { class: "nd-dim", text: "also: sinh cosh tanh log2 floor ceil round, and root(27;3) pow(2;8) mod(7;3) min(a;b) max(a;b)" }),
      h("div", { class: "nd-sub", text: "history" }), sci.box);
    onShow.scientific = () => { drawHist(); sci.inp.focus(); };
    drawHist(); drawMem();

    // ---- graphing: up to four functions, scroll to zoom, drag to move, hover to read values ----
    const GCOL = ["#4fc3d9", "#9bd64a", "#ffd34d", "#ff6b6b"];
    let gSaved = store.get("graphs", null); if (!Array.isArray(gSaved)) gSaved = [store.get("graph", "sin(x) * x"), "", "", ""];
    const gIns = GCOL.map((c, k) => { const el = h("input", { class: "nd-input nd-grow", value: gSaved[k] || "", placeholder: k ? "another function (optional)" : "e.g. x^2 - 3", spellcheck: "false" }); el.style.borderLeft = "3px solid " + c; return el; });
    const gMin = h("input", { class: "nd-input", value: store.get("gmin", "-10"), size: "8" }), gMax = h("input", { class: "nd-input", value: store.get("gmax", "10"), size: "8" });
    const gMsg = h("span", { class: "nd-dim" }), cv = h("canvas", { class: "nd-graph" });
    let hoverX = null, gDrag = null;
    function step(range) { const raw = range / 8, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p; return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p; }
    const gRange = () => { const a = num(gMin.value), b = num(gMax.value); return isFinite(a) && isFinite(b) && a < b ? [a, b] : null; };
    function setRange(a, b) { const f = v => String(+v.toPrecision(4)); gMin.value = f(a); gMax.value = f(b); draw(); }
    function draw() {
      const w = cv.clientWidth, hh = cv.clientHeight; if (!w || !hh) return;
      const dpr = window.devicePixelRatio || 1; cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr);
      const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, hh);
      const r = gRange(); if (!r) { gMsg.textContent = "check the x range"; return; }
      const [x0, x1] = r; store.set("gmin", gMin.value); store.set("gmax", gMax.value);
      store.set("graphs", gIns.map(i => i.value)); store.set("graph", gIns[0].value);
      const series = []; let bad = false;
      gIns.forEach((inp, k) => {
        const f = inp.value.trim(); if (!f) return;
        try { const pts = []; for (let p = 0; p <= w; p++) { const y = evaluate(f, { vars: { x: x0 + (x1 - x0) * p / w } }); pts.push(y != null && isFinite(y) ? y : null); } series.push({ k, f, pts }); }
        catch (e) { bad = true; }
      });
      const fin = series.flatMap(s => s.pts.filter(v => v != null)).sort((a, b) => a - b);
      if (!fin.length) { gMsg.textContent = bad ? "cannot read a formula - use x, e.g. x^2 - 3" : "nothing to draw in this range"; return; }
      let y0 = fin[Math.floor(fin.length * 0.02)], y1 = fin[Math.max(0, Math.ceil(fin.length * 0.98) - 1)];
      if (y0 === y1) { y0 -= 1; y1 += 1; } const pad = (y1 - y0) * 0.1; y0 -= pad; y1 += pad;
      const X = x => (x - x0) / (x1 - x0) * w, Y = y => hh - (y - y0) / (y1 - y0) * hh;
      g.font = '10px "IBM Plex Mono", monospace'; g.lineWidth = 1;
      const sx = step(x1 - x0), sy = step(y1 - y0), lab = v => String(+v.toPrecision(6));
      for (let x = Math.ceil(x0 / sx) * sx; x <= x1; x += sx) { g.strokeStyle = Math.abs(x) < sx / 2 ? "#7d8891" : "#232a30"; g.beginPath(); g.moveTo(X(x), 0); g.lineTo(X(x), hh); g.stroke(); g.fillStyle = "#7d8891"; g.fillText(lab(Math.abs(x) < sx / 2 ? 0 : x), X(x) + 3, hh - 4); }
      for (let y = Math.ceil(y0 / sy) * sy; y <= y1; y += sy) { g.strokeStyle = Math.abs(y) < sy / 2 ? "#7d8891" : "#232a30"; g.beginPath(); g.moveTo(0, Y(y)); g.lineTo(w, Y(y)); g.stroke(); g.fillStyle = "#7d8891"; g.fillText(lab(Math.abs(y) < sy / 2 ? 0 : y), 3, Y(y) - 3); }
      for (const s of series) {
        g.strokeStyle = GCOL[s.k]; g.lineWidth = 2; g.beginPath(); let pen = false, last = 0;
        s.pts.forEach((y, p) => { if (y == null) { pen = false; return; } const py = Y(y); if (pen && Math.abs(py - last) > hh) pen = false; if (pen) g.lineTo(p, py); else g.moveTo(p, py); pen = true; last = py; });
        g.stroke();
      }
      if (hoverX == null) { gMsg.textContent = (bad ? "one formula cannot be read.  " : "") + "scroll to zoom, drag to move, point at the graph to read values"; return; }
      const xv = x0 + (x1 - x0) * hoverX / w, parts = ["x = " + lab(xv)];
      g.strokeStyle = "#dfe6ea"; g.setLineDash([3, 3]); g.lineWidth = 1; g.beginPath(); g.moveTo(hoverX, 0); g.lineTo(hoverX, hh); g.stroke(); g.setLineDash([]);
      for (const s of series) {
        let y = null; try { y = evaluate(s.f, { vars: { x: xv } }); } catch (e) {}
        parts.push("f" + (s.k + 1) + " = " + (y != null && isFinite(y) ? lab(y) : "-"));
        if (y != null && isFinite(y) && y >= y0 && y <= y1) { g.fillStyle = GCOL[s.k]; g.beginPath(); g.arc(hoverX, Y(y), 4, 0, 2 * Math.PI); g.fill(); }
      }
      gMsg.textContent = parts.join("    ");
    }
    for (const e of gIns.concat([gMin, gMax])) e.addEventListener("input", draw);
    cv.addEventListener("mousemove", e => {
      if (gDrag) { const r = gDrag.r, d = (e.clientX - gDrag.x) / cv.clientWidth * (r[1] - r[0]); setRange(r[0] - d, r[1] - d); return; }
      hoverX = e.offsetX; draw();
    });
    cv.addEventListener("mouseleave", () => { hoverX = null; draw(); });
    cv.addEventListener("mousedown", e => { const r = gRange(); if (r) { gDrag = { x: e.clientX, r }; hoverX = null; } });
    window.addEventListener("mouseup", () => { gDrag = null; });
    cv.addEventListener("wheel", e => {
      e.preventDefault(); const r = gRange(); if (!r) return;
      const f = e.deltaY > 0 ? 1.25 : 0.8, cx = r[0] + (r[1] - r[0]) * e.offsetX / cv.clientWidth;
      setRange(cx - (cx - r[0]) * f, cx + (r[1] - cx) * f);
    }, { passive: false });
    if (window.ResizeObserver) new ResizeObserver(draw).observe(cv);
    onShow.graphing = draw;
    section("graphing", h("div", { class: "nd-row" }, h("span", { class: "nd-dim", text: "y =" }), gIns[0]), h("div", { class: "nd-row" }, gIns[1], gIns[2], gIns[3]),
      h("div", { class: "nd-row" }, h("span", { class: "nd-dim", text: "x from" }), gMin, h("span", { class: "nd-dim", text: "to" }), gMax, btn("reset view", () => setRange(-10, 10))), cv, gMsg);

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
    for (const k of ["HEX", "DEC", "OCT", "BIN"]) { pOut[k] = h("output", { class: "nd-wrap" }); pRows.append(h("div", { class: "nd-info" }, h("span", { text: k }), h("span", { class: "nd-row nd-ipcopy" }, pOut[k], btn("copy", () => { const t = pOut[k].textContent.replace(/ /g, ""); if (t && t !== "?") copy(t); })))); }
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

    // ---- percent, VAT and discount ----
    const pctRuns = [], s6 = x => show(Math.round(x * 1e6) / 1e6), money = x => (Math.round(x * 100) / 100).toFixed(2);
    function pctRow(parts, calc) { // "@key=default" is an input box, anything else is a label
      const ins = {}, out = h("output", { class: "nd-result", text: "=" }), row = h("div", { class: "nd-row" });
      for (const p of parts) {
        if (p[0] !== "@") { row.append(h("span", { class: "nd-dim", text: p })); continue; }
        const [k, def] = p.slice(1).split("=");
        ins[k] = h("input", { class: "nd-input", size: "8", value: store.get("pct-" + k, def || "") });
        ins[k].addEventListener("input", () => { store.set("pct-" + k, ins[k].value); run(); }); row.append(ins[k]);
      }
      const run = () => { const v = {}; for (const k in ins) v[k] = num(ins[k].value); out.textContent = Object.values(v).some(x => !isFinite(x)) ? "=" : "= " + calc(v); };
      row.append(out, btn("copy", () => { const m = /^= (-?[\d.]+)/.exec(out.textContent); if (m) copy(m[1]); }));
      pctRuns.push(run); return row;
    }
    section("percent",
      h("div", { class: "nd-sub", text: "percent" }),
      pctRow(["@p1=19", "% of", "@v1=100"], v => s6(v.p1 * v.v1 / 100)),
      pctRow(["@a2=25", "is what % of", "@b2=200"], v => s6(v.a2 / v.b2 * 100) + " %"),
      pctRow(["change from", "@a3=80", "to", "@b3=100"], v => { const d = (v.b3 - v.a3) / Math.abs(v.a3) * 100; return isFinite(d) ? (d >= 0 ? "+" : "") + s6(d) + " %" : "?"; }),
      h("div", { class: "nd-sub", text: "vat (19% normal, 7% reduced)" }),
      pctRow(["net", "@n4=100", "plus", "@r4=19", "% vat"], v => money(v.n4 * (1 + v.r4 / 100)) + "   (vat " + money(v.n4 * v.r4 / 100) + ")"),
      pctRow(["gross", "@g5=119", "with", "@r5=19", "% vat"], v => { const n = v.g5 / (1 + v.r5 / 100); return money(n) + " net   (vat " + money(v.g5 - n) + ")"; }),
      h("div", { class: "nd-sub", text: "discount" }),
      pctRow(["price", "@p6=50", "minus", "@d6=20", "%"], v => money(v.p6 * (1 - v.d6 / 100)) + "   (you save " + money(v.p6 * v.d6 / 100) + ")"));
    onShow.percent = () => pctRuns.forEach(r => r());

    // ---- unit price comparison ----
    const UP = { g: ["kg", 0.001], kg: ["kg", 1], ml: ["litre", 0.001], l: ["litre", 1], piece: ["piece", 1] };
    const upRows = [], upOut = h("div", { class: "nd-kv" });
    function upCalc() {
      upOut.textContent = "";
      const res = upRows.map(r => { const p = num(r.pr.value), s = num(r.sz.value), u = UP[r.un.value]; store.set("up" + r.k, { n: r.nm.value, p: r.pr.value, s: r.sz.value, u: r.un.value }); return p > 0 && s > 0 ? { n: r.nm.value.trim() || "product " + (r.k + 1), base: u[0], per: p / (s * u[1]) } : null; }).filter(Boolean);
      if (!res.length) { upOut.append(h("span", { class: "nd-dim", text: "enter a price and a size for at least one product" })); return; }
      const bases = [...new Set(res.map(r => r.base))];
      for (const b of bases) {
        const grp = res.filter(r => r.base === b), best = grp.reduce((a, r) => r.per < a.per ? r : a);
        for (const r of grp) upOut.append(h("div", { class: "nd-info" + (grp.length > 1 && r === best ? " nd-best" : "") }, h("span", { text: r.n }),
          h("output", { text: money(r.per) + " per " + b + (grp.length < 2 ? "" : r === best ? "   cheapest" : "   " + s6((r.per / best.per - 1) * 100) + "% more") })));
      }
      if (bases.length > 1) upOut.append(h("span", { class: "nd-dim", text: "weight, volume and pieces are compared separately" }));
    }
    function upRow(k) {
      const st = store.get("up" + k, {}) || {};
      const nm = h("input", { class: "nd-input", size: "14", placeholder: "product " + (k + 1), value: st.n || "" });
      const pr = h("input", { class: "nd-input", size: "7", placeholder: "price", value: st.p || "" }), sz = h("input", { class: "nd-input", size: "7", placeholder: "size", value: st.s || "" });
      const un = h("select", { class: "nd-input" }); for (const u of Object.keys(UP)) un.append(h("option", { value: u, text: u })); un.value = UP[st.u] ? st.u : "g";
      for (const e of [nm, pr, sz, un]) e.addEventListener("input", upCalc);
      upRows.push({ k, nm, pr, sz, un });
      return h("div", { class: "nd-row" }, nm, pr, h("span", { class: "nd-dim", text: "for" }), sz, un);
    }
    section("unit price", h("div", { class: "nd-sub", text: "which is cheaper?" }), upRow(0), upRow(1), upRow(2), upOut,
      btn("clear", () => { for (const r of upRows) { r.nm.value = r.pr.value = r.sz.value = ""; } upCalc(); }));
    onShow["unit price"] = upCalc;

    // ---- password generator (made on this PC, nothing is stored) ----
    const pwSet = { lower: "abcdefghijklmnopqrstuvwxyz", upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ", digits: "0123456789", symbols: "!@#$%^&*()-_=+[]{};:,.?/" };
    const pwOpt = { lower: true, upper: true, digits: true, symbols: true, similar: false };
    const pwLen = h("input", { class: "nd-input", type: "number", min: "6", max: "128", value: "20", size: "5" });
    const pwOut = h("output", { class: "nd-result nd-pw" }), pwStr = h("span", { class: "nd-dim" });
    function rnd(n) { const a = new Uint32Array(1), lim = Math.floor(0x100000000 / n) * n; do crypto.getRandomValues(a); while (a[0] >= lim); return a[0] % n; }
    function genPw() {
      const len = Math.max(6, Math.min(128, Math.round(num(pwLen.value)) || 20));
      const sets = Object.keys(pwSet).filter(k => pwOpt[k]).map(k => pwOpt.similar ? pwSet[k].replace(/[Il1O0o|]/g, "") : pwSet[k]);
      if (!sets.length) { pwOut.textContent = "pick at least one kind of character"; pwStr.textContent = ""; return; }
      const all = sets.join(""), ch = sets.map(s => s[rnd(s.length)]); // at least one of each chosen kind
      while (ch.length < len) ch.push(all[rnd(all.length)]);
      for (let i = ch.length - 1; i > 0; i--) { const j = rnd(i + 1); [ch[i], ch[j]] = [ch[j], ch[i]]; }
      pwOut.textContent = ch.join("");
      const bits = Math.round(len * Math.log2(all.length));
      pwStr.textContent = "strength: " + (bits < 50 ? "weak" : bits < 80 ? "fair" : bits < 110 ? "strong" : "very strong") + "  (" + bits + " bits)";
    }
    pwLen.addEventListener("input", genPw);
    const pwBtns = [["lower", "a-z"], ["upper", "A-Z"], ["digits", "0-9"], ["symbols", "!@#"], ["similar", "no look-alikes"]].map(([k, label]) => {
      const b = btn(label, () => { pwOpt[k] = !pwOpt[k]; b.classList.toggle("nd-on", pwOpt[k]); genPw(); }); b.classList.toggle("nd-on", pwOpt[k]); return b;
    });
    section("password", h("div", { class: "nd-row" }, h("span", { class: "nd-dim", text: "length" }), pwLen, pwBtns), pwOut,
      h("div", { class: "nd-row" }, btn("new password", genPw, "nd-on"), btn("copy", () => { if (pwOut.textContent.length >= 6 && !/ /.test(pwOut.textContent)) api("copyText", pwOut.textContent).then(() => log("password copied")).catch(e => log("copy failed: " + e.message)); }), pwStr),
      h("span", { class: "nd-dim", text: "made with a secure random source on this pc. nothing is saved, and the password is not written to the console." }));
    onShow.password = () => { if (!pwOut.textContent) genPw(); };

    // ---- text tools ----
    const tx = h("textarea", { class: "nd-input nd-txt", placeholder: "paste or type text here", spellcheck: "false" }), txInfo = h("span", { class: "nd-dim" });
    let txPrev = null;
    const txCount = () => { const t = tx.value; txInfo.textContent = t.length + " characters, " + (t.trim().match(/\S+/g) || []).length + " words, " + (t ? t.split("\n").length : 0) + " lines"; };
    tx.addEventListener("input", txCount);
    const change = f => () => { try { const v = f(tx.value); txPrev = tx.value; tx.value = v; } catch (e) { log("text tools: that text cannot be decoded"); } txCount(); };
    const byLine = f => change(t => f(t.split(/\r?\n/)).join("\n"));
    const b64e = t => { let s = ""; for (const x of new TextEncoder().encode(t)) s += String.fromCharCode(x); return btoa(s); };
    const b64d = t => new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(t.replace(/\s+/g, "")), c => c.charCodeAt(0)));
    section("text", tx, txInfo,
      h("div", { class: "nd-row" }, btn("UPPER", change(t => t.toUpperCase())), btn("lower", change(t => t.toLowerCase())), btn("Title Case", change(t => t.toLowerCase().replace(/(^|[\s(\-"])(\S)/g, (m, a, b) => a + b.toUpperCase()))),
        btn("trim lines", byLine(a => a.map(l => l.trim()))), btn("remove empty lines", byLine(a => a.filter(l => l.trim())))),
      h("div", { class: "nd-row" }, btn("remove duplicates", byLine(a => [...new Set(a)])), btn("sort A-Z", byLine(a => a.slice().sort((x, y) => x.localeCompare(y)))), btn("reverse lines", byLine(a => a.slice().reverse()))),
      h("div", { class: "nd-row" }, btn("base64 encode", change(b64e)), btn("base64 decode", change(b64d)), btn("url encode", change(encodeURIComponent)), btn("url decode", change(decodeURIComponent))),
      h("div", { class: "nd-row" }, btn("undo", () => { if (txPrev != null) { tx.value = txPrev; txPrev = null; txCount(); } }),
        btn("copy", () => { if (tx.value) api("copyText", tx.value).then(() => log("text copied (" + tx.value.length + " characters)")).catch(e => log("copy failed: " + e.message)); }),
        btn("clear", () => { txPrev = tx.value; tx.value = ""; txCount(); }, "nd-danger")));
    onShow.text = txCount;


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
      uAlso.textContent = uCat.value === "currency" ? rateNote : ""; bRates.style.display = uCat.value === "currency" ? "" : "none";
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
    async function loadRates(force) {
      if (!force && Object.keys(U.currency).length && rateNote.indexOf("saved copy") < 0) return;
      const saved = store.get("rates", null);
      try { const d = await api("rates"); store.set("rates", d); useRates(d, false); log("currency rates loaded (" + d.updated + ")"); }
      catch (e) { if (force) log("currency rates could not be refreshed - " + (saved ? "using the saved copy" : "no internet?")); if (saved) useRates(saved, true); else rateNote = "currency rates need an internet connection"; }
      if (uCat.value === "currency") fill();
    }
    uCat.addEventListener("change", () => { store.set("ucat", uCat.value); fill(); if (uCat.value === "currency") loadRates(); });
    for (const e of [uVal, uFrom, uTo]) e.addEventListener("input", conv);
    const swap = btn("swap", () => { const a = uFrom.value; uFrom.value = uTo.value; uTo.value = a; conv(); });
    // favourite conversions
    let favs = store.get("ufavs", []); if (!Array.isArray(favs)) favs = [];
    const favRow = h("div", { class: "nd-row" });
    function drawFavs() {
      favRow.textContent = "";
      if (!favs.length) { favRow.append(h("span", { class: "nd-dim", text: "press pin to keep a conversion here" })); return; }
      favs.forEach((f, i) => favRow.append(h("span", { class: "nd-preset" }, btn(f[1] + " \u2192 " + f[2], () => {
        if (!U[f[0]]) return; uCat.value = f[0]; store.set("ucat", f[0]); store.set("upick-" + f[0], [f[1], f[2]]); fill(); if (f[0] === "currency") loadRates();
      }), h("button", { class: "nd-btn", text: "x", title: "Remove", onclick: () => { favs.splice(i, 1); store.set("ufavs", favs); drawFavs(); } }))));
    }
    const pin = btn("pin", () => { const f = [uCat.value, uFrom.value, uTo.value]; if (!f[1] || favs.some(x => x.join() === f.join())) return; favs.push(f); favs = favs.slice(-12); store.set("ufavs", favs); drawFavs(); });
    const cpU = btn("copy", () => { const m = /^= (-?[\d.e+]+)/i.exec(uOut.textContent); if (m) copy(m[1]); });
    const bRates = btn("refresh rates", () => loadRates(true));
    section("converter", h("div", { class: "nd-row" }, uCat, uVal, uFrom, h("span", { class: "nd-dim", text: "to" }), uTo, swap, pin), h("div", { class: "nd-row" }, uOut, cpU, bRates), uAlso,
      h("div", { class: "nd-sub", text: "favourites" }), favRow);
    onShow.converter = () => { drawFavs(); fill(); if (uCat.value === "currency") loadRates(); };

    // ---- colour picker ----
    const col = h("input", { type: "color", class: "nd-color", value: store.get("color", "#4fc3d9") }), colOut = h("div", { class: "nd-kv" }), pal = h("div", { class: "nd-row nd-pal" });
    const hexRgb = hex => [1, 3, 5].map(n => parseInt(hex.slice(n, n + 2), 16));
    const rgb = hex => "rgb(" + hexRgb(hex).join(", ") + ")";
    function hsl(hex) {
      const [r, g, b] = hexRgb(hex).map(v => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2; let hh = 0, s = 0;
      if (mx !== mn) { const d = mx - mn; s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn); hh = (mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60; }
      return "hsl(" + Math.round(hh) + ", " + Math.round(s * 100) + "%, " + Math.round(l * 100) + "%)";
    }
    function showCol() {
      colOut.textContent = "";
      for (const [k, v] of [["hex", col.value.toUpperCase()], ["rgb", rgb(col.value)], ["hsl", hsl(col.value)]])
        colOut.append(h("div", { class: "nd-info" }, h("span", { text: k }), h("span", { class: "nd-row nd-ipcopy" }, h("output", { text: v }), btn("copy", () => copy(v)))));
      store.set("color", col.value);
    }
    col.addEventListener("input", showCol);
    let palette = store.get("palette", []); if (!Array.isArray(palette)) palette = [];
    function drawPal() {
      pal.textContent = "";
      if (!palette.length) pal.append(h("span", { class: "nd-dim", text: "no saved colours yet" }));
      palette.forEach((c, i) => {
        const sw = h("button", { class: "nd-btn nd-col", title: c.toUpperCase() + " - click to use, right-click to remove" }); sw.style.background = c;
        sw.addEventListener("click", () => { col.value = c; showCol(); });
        sw.addEventListener("contextmenu", e => { e.preventDefault(); palette.splice(i, 1); store.set("palette", palette); drawPal(); });
        pal.append(sw);
      });
    }
    const bSaveCol = btn("save colour", () => { const c = col.value.toLowerCase(); palette = [c].concat(palette.filter(x => x !== c)).slice(0, 24); store.set("palette", palette); drawPal(); });
    const bDrop = btn("pick from screen", async () => {
      if (!window.EyeDropper) { log("colour: picking from the screen is not available here"); return; }
      try {
        const r = await new EyeDropper().open(), m = /^#?([0-9a-f]{6})/i.exec(r && r.sRGBHex || "");
        if (m) { col.value = "#" + m[1].toLowerCase(); showCol(); log("picked " + col.value.toUpperCase()); }
      } catch (e) {} // cancelled with Escape
    });
    section("colour", h("div", { class: "nd-row" }, col, bDrop, bSaveCol), colOut, h("div", { class: "nd-sub", text: "palette" }), pal,
      h("span", { class: "nd-dim", text: "click a saved colour to use it, right-click to remove it" }));
    showCol(); drawPal();

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
    const names = { appsDark: "dark mode for apps", sysDark: "dark mode for taskbar and start", showExt: "show file extensions", showHidden: "show hidden files",
      transparency: "transparency effects", icons: "desktop icons", autoHide: "hide the taskbar automatically", toasts: "notification banners" };
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
      tray.inp.checked = s.tray; hot.inp.checked = s.hotkey; login.inp.checked = s.login; onTop.inp.checked = !!s.onTop; startTray.inp.checked = !!s.startTray; setOpa(Math.round((s.opacity || 1) * 100)); if (document.activeElement !== accel) accel.value = s.accel;
      hkNote.textContent = s.hotkey ? (s.hotkeyOk ? "active" : "could not be registered - another program may use it") : "";
    }
    const setS = async (k, v, label) => { try { const s = await api("settingSet", k, v); showSettings(s); log(label); } catch (e) { log("setting not saved: " + e.message); api("settingsGet").then(showSettings).catch(() => {}); } };
    const tray = toggle("tray icon (closing keeps it running)", on => setS("tray", on, "tray icon " + (on ? "on" : "off")));
    const hot = toggle("hotkey to show or hide nightdeck", on => setS("hotkey", on, "global hotkey " + (on ? "on" : "off")));
    const login = toggle("start with Windows", on => setS("login", on, "start with Windows " + (on ? "on" : "off")));
    const setAccel = btn("set", () => setS("accel", accel.value, "hotkey set to " + accel.value));
    accel.addEventListener("keydown", e => { if (e.key === "Enter") setAccel.click(); });

    // audio devices and microphone
    const outSel = h("select", { class: "nd-input nd-grow" }), inSel = h("select", { class: "nd-input nd-grow" }), micNote = h("span", { class: "nd-dim" });
    const mic = toggle("mute microphone", async (on, inp) => {
      try { const r = await api("micMute", on); if (r.ok) { inp.checked = r.mute; log("microphone " + (r.mute ? "muted" : "on")); } else { inp.checked = !on; log("microphone: " + r.msg); } }
      catch (e) { inp.checked = !on; log("microphone: " + e.message); }
    });
    async function loadDevices() {
      try {
        const r = await api("audioDevices"); if (!r.ok) { micNote.textContent = r.msg; return; } micNote.textContent = "";
        for (const [s, list] of [[outSel, r.out], [inSel, r.in]]) {
          s.textContent = ""; if (!list.length) s.append(h("option", { value: "", text: "none found" }));
          for (const d of list) { s.append(h("option", { value: d.id, text: d.name })); if (d.def) s.value = d.id; }
        }
        mic.inp.checked = !!r.micMute; mic.inp.disabled = !r.mic;
      } catch (e) { micNote.textContent = e.message; }
    }
    for (const [s, label] of [[outSel, "sound output"], [inSel, "microphone"]]) s.addEventListener("change", async () => {
      if (!s.value) return;
      try { const r = await api("audioDefault", s.value); log(r.ok ? label + ": " + s.options[s.selectedIndex].text : label + " not changed: " + r.msg); } catch (e) { log(label + ": " + e.message); }
      loadDevices(); loadMixer();
    });
    // volume per program
    const mixer = h("div", { class: "nd-kv" });
    async function loadMixer() {
      try {
        const r = await api("appVolumes"); mixer.textContent = "";
        if (!r.ok) { mixer.append(h("span", { class: "nd-dim", text: r.msg })); return; }
        if (!r.list.length) mixer.append(h("span", { class: "nd-dim", text: "no program is using sound right now" }));
        for (const a of r.list) {
          const sl = slider(a.name); sl.set(a.vol);
          const mu = toggle("mute", async (on, inp) => { try { const x = await api("appVolume", a.pid, null, on); if (!x.ok) { inp.checked = !on; log(a.name + ": " + x.msg); } else log(a.name + (on ? " muted" : " unmuted")); } catch (e) { inp.checked = !on; } });
          mu.inp.checked = a.mute;
          sl.inp.addEventListener("change", async () => { try { const x = await api("appVolume", a.pid, Number(sl.inp.value), null); if (x.ok) log(a.name + " volume " + x.vol + "%"); else sl.note(x.msg); } catch (e) { sl.note(e.message); } });
          mixer.append(h("div", { class: "nd-mix" }, sl.el, mu.el));
        }
      } catch (e) { mixer.textContent = e.message; }
    }
    // night light
    const night = toggle("night light", async (on, inp) => {
      try { const r = await api("nightLight", on); if (r.ok) { inp.checked = r.on; log("night light " + (r.on ? "on" : "off")); } else { inp.checked = !on; log("night light: " + r.msg); } }
      catch (e) { inp.checked = !on; log("night light: " + e.message); }
    });
    // wi-fi and bluetooth
    const radios = h("div", { class: "nd-grid2" }), radioNote = h("span", { class: "nd-dim" });
    async function loadRadios(r) {
      try {
        r = r || await api("radios"); radios.textContent = "";
        if (!r.ok && !(r.list && r.list.length)) { radioNote.textContent = r.msg; return; }
        radioNote.textContent = r.list.length ? "" : "no wi-fi or bluetooth hardware found";
        for (const x of r.list) {
          const label = x.kind === "WiFi" ? "wi-fi" : "bluetooth";
          const t = toggle(label, async (on, inp) => {
            inp.disabled = true;
            try { const y = await api("radioSet", x.kind, on); log(label + (y.ok ? " " + (on ? "on" : "off") : ": " + y.msg)); loadRadios(y); } catch (e) { log(label + ": " + e.message); loadRadios(); }
          });
          t.inp.checked = x.on; radios.append(t.el);
        }
      } catch (e) { radioNote.textContent = e.message; }
    }
    // wallpaper
    const wpStyle = h("select", { class: "nd-input", title: "how the picture fills the screen" });
    for (const s of ["fill", "fit", "stretch", "center", "span"]) wpStyle.append(h("option", { value: s, text: s }));
    wpStyle.value = store.get("wpstyle", "fill"); wpStyle.addEventListener("change", () => store.set("wpstyle", wpStyle.value));
    const wpNote = h("span", { class: "nd-dim nd-path", text: "span stretches one picture across both screens" });
    const wpBtn = btn("choose picture", async () => {
      try { const r = await api("wallpaper", wpStyle.value); if (r && r.ok) { wpNote.textContent = r.file; log("wallpaper set"); } else if (r) log("wallpaper: " + r.msg); } catch (e) { log("wallpaper: " + e.message); }
    });
    // drives
    const drives = h("div", { class: "nd-kv" });
    async function loadDrives() {
      try {
        const list = await api("drives"); drives.textContent = "";
        for (const d of list) {
          const id = "dr-" + String(d.root).replace(/\W/g, "");
          drives.append(h("div", { class: "nd-mix" }, h("div", { class: "nd-meter", "data-meter": id }, h("div", null, "drive " + String(d.root).replace(/[\\/]+$/, ""), h("output")), h("div", { class: "nd-meterbar" }, h("i"))),
            btn("open", () => api("openDrive", d.root).catch(e => log("could not open the drive: " + e.message)))));
          panel.setMeter(id, (d.total - d.free) / d.total * 100, gb(d.free) + " GB free of " + Math.round(d.total / 1073741824) + " GB");
        }
      } catch (e) { drives.textContent = e.message; }
    }
    // more cleanup
    const more = h("div", { class: "nd-kv" }), moreConfirm = h("div", { class: "nd-row" });
    async function scanMore() {
      more.textContent = ""; moreConfirm.textContent = ""; more.append(h("span", { class: "nd-dim", text: "scanning..." }));
      try {
        const r = await api("cleanCats"); more.textContent = "";
        if (!r.length) more.append(h("span", { class: "nd-dim", text: "only available on Windows" }));
        for (const c of r) more.append(h("div", { class: "nd-info" }, h("span", { text: c.label + (c.admin ? " *" : "") }), h("span", { class: "nd-row nd-ipcopy" },
          h("output", { text: c.bytes ? size(c.bytes) : "empty" }),
          c.bytes ? btn("clear", () => {
            moreConfirm.textContent = "";
            moreConfirm.append(h("span", { text: "delete " + size(c.bytes) + " of " + c.label + "? " + (c.note || "") }), btn("yes, delete", async () => {
              moreConfirm.textContent = "";
              try { const x = await api("cleanCat", c.id); log(c.label + ": freed " + size(x.freed) + (x.kept ? ", " + x.kept + " in use kept" : "") + (x.msg ? " - " + x.msg : "")); } catch (e) { log(c.label + ": " + e.message); }
              scanMore();
            }, "nd-danger"), btn("cancel", () => { moreConfirm.textContent = ""; }));
          }) : null)));
      } catch (e) { more.textContent = e.message; }
    }
    // windows settings pages
    const links = [["display", "display"], ["sound", "sound"], ["bluetooth", "bluetooth"], ["apps", "apps"], ["update", "windows update"], ["storage", "storage"],
      ["nightlight", "night light"], ["notifications", "notifications"], ["power", "power"], ["devices", "device manager"], ["taskmgr", "task manager"], ["control", "control panel"]];
    const linkRow = h("div", { class: "nd-row" }, links.map(([k, l]) => btn(l, () => api("openSetting", k).catch(e => log("could not open " + l + ": " + e.message)))));
    // nightdeck window and data
    const onTop = toggle("always on top", on => setS("onTop", on, "always on top " + (on ? "on" : "off")));
    const startTray = toggle("start hidden in the tray (needs the tray icon)", on => setS("startTray", on, "start hidden " + (on ? "on" : "off")));
    const opa = slider("window opacity"); opa.inp.min = "50";
    const setOpa = v => { opa.set(v); opa.inp.style.setProperty("--p", ((v - 50) * 2) + "%"); };
    opa.inp.addEventListener("input", () => opa.inp.style.setProperty("--p", ((opa.inp.value - 50) * 2) + "%"));
    opa.inp.addEventListener("change", () => setS("opacity", Number(opa.inp.value) / 100, "window opacity " + opa.inp.value + "%"));
    const nConfirm = h("div", { class: "nd-row" });
    const bBackup = btn("back up nightdeck", async () => {
      const data = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith("ndu-")) data[k] = localStorage.getItem(k); }
      try { const f = await api("backupSave", data); if (f) log("backup saved: " + f); } catch (e) { log("backup failed: " + e.message); }
    });
    const bRestore = btn("restore from backup", () => {
      nConfirm.textContent = "";
      nConfirm.append(h("span", { text: "replace all nightdeck data and settings with a backup? nightdeck restarts afterwards." }), btn("yes, choose file", async () => {
        nConfirm.textContent = "";
        try {
          const local = await api("backupLoad"); if (!local) return;
          for (const k of Object.keys(localStorage)) if (k.startsWith("ndu-")) localStorage.removeItem(k);
          for (const k in local) localStorage.setItem(k, local[k]);
          log("backup restored - restarting"); setTimeout(() => api("appRestart").catch(() => {}), 500);
        } catch (e) { log("restore failed: " + e.message); }
      }, "nd-danger"), btn("cancel", () => { nConfirm.textContent = ""; }));
    });

    root.append(
      h("div", { class: "nd-sub", text: "sound and screen" }), h("div", { class: "nd-two" }, h("div", { class: "nd-kv" }, vol.el, mute.el), h("div", { class: "nd-kv" }, bri.el, night.el)),
      h("div", { class: "nd-row" }, h("span", { class: "nd-dim nd-lab", text: "output" }), outSel), h("div", { class: "nd-row" }, h("span", { class: "nd-dim nd-lab", text: "input" }), inSel, mic.el), micNote,
      h("div", { class: "nd-row" }, h("span", { class: "nd-sub", text: "volume per program" }), btn("refresh", loadMixer)), mixer,
      h("div", { class: "nd-sub", text: "windows" }), h("div", { class: "nd-grid2" }, Object.values(sw).map(t => t.el)),
      h("span", { class: "nd-dim", text: "file settings show in folders you open next, or after pressing F5. notification banners may need a sign-out to switch fully." }),
      h("div", { class: "nd-sub", text: "wi-fi and bluetooth" }), radios, radioNote,
      h("div", { class: "nd-sub", text: "wallpaper" }), h("div", { class: "nd-row" }, wpStyle, wpBtn), wpNote,
      h("div", { class: "nd-row" }, h("span", { class: "nd-sub", text: "drives" }), btn("refresh", loadDrives), btn("open storage settings", () => api("openSetting", "storage").catch(e => log(e.message)))), drives,
      h("div", { class: "nd-sub", text: "cleanup" }), h("div", { class: "nd-kv" }, row("temporary files", cTemp), row("recycle bin", cBin)),
      h("div", { class: "nd-row" }, btn("scan", scan), clearTemp, clearBin), cConfirm,
      h("div", { class: "nd-row" }, h("span", { class: "nd-sub", text: "more cleanup" }), btn("scan", scanMore), h("span", { class: "nd-dim", text: "* needs windows permission" })), more, moreConfirm,
      h("div", { class: "nd-sub", text: "windows settings" }), linkRow,
      h("div", { class: "nd-sub", text: "nightdeck" }), h("div", { class: "nd-grid2" }, tray.el, login.el, hot.el, onTop.el, startTray.el),
      h("div", { class: "nd-row" }, h("span", { class: "nd-dim", text: "hotkey keys" }), accel, setAccel, hkNote),
      h("div", { class: "nd-kv" }, opa.el), h("div", { class: "nd-row" }, bBackup, bRestore), nConfirm);

    let loaded = false;
    async function load() {
      api("settingsGet").then(showSettings).catch(() => {});
      loadDevices(); loadMixer(); loadDrives();
      if (loaded) return; loaded = true;
      loadRadios();
      api("nightLight", null).then(r => { if (r.ok) night.inp.checked = r.on; else { night.inp.disabled = true; night.el.title = r.msg; } }).catch(() => {});
      api("volume", null, null).then(r => { if (r.ok) { vol.set(r.level); mute.inp.checked = r.mute; } else vol.note(r.msg); }).catch(e => vol.note(e.message));
      api("brightness", null).then(r => { if (r.ok) bri.set(r.level); else { bri.note("not supported"); bri.inp.disabled = true; } }).catch(e => bri.note(e.message));
      api("switchesGet").then(r => { if (r.ok) for (const id in sw) sw[id].inp.checked = !!r[id]; }).catch(() => {});
    }
    onTab.control = load;
  })();

  /* ---------- BETA: features being tried out ---------- */
  (function () {
    const root = $c("beta"); if (!root) return;
    let cfg = null;
    const sub = t => h("div", { class: "nd-sub", text: t });
    const note = t => h("span", { class: "nd-dim", text: t || "" });
    function toggle(label, fn) {
      const inp = h("input", { type: "checkbox" }), el = h("label", { class: "nd-opt" }, inp, h("span"), label);
      inp.addEventListener("change", () => fn(inp.checked, inp));
      return { el, inp };
    }
    const info = (k) => { const o = h("output", { text: "-" }); return { el: h("div", { class: "nd-info" }, h("span", { text: k }), o), o }; };
    const fmtDur = s => { s = Math.round(s); const hh = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return hh ? hh + "h " + String(m).padStart(2, "0") + "m" : m ? m + "m" : s + "s"; };
    async function set(key, v, msg) {
      try { cfg = await api("betaSet", key, v); if (msg) log(msg); show(); return true; } catch (e) { log("beta: " + e.message); show(); return false; }
    }

    // 1. feature switches
    const FEATS = [["profiles", "profiles"], ["game", "game mode"], ["gpu", "gpu details"], ["overlay", "overlay on screen"], ["monitors", "screens"],
      ["palette", "command search"], ["schedule", "scheduled actions"], ["alerts", "heavy program alerts"], ["usage", "usage time"], ["remote", "remote control for claude"]];
    const feat = {}, sec = {};
    for (const [id, label] of FEATS) feat[id] = toggle(label, on => set("feat", { id, on }, label + " " + (on ? "on" : "off")).then(() => { if (on) loadSec(id); }));

    // 2. profiles
    const pName = h("input", { class: "nd-input", placeholder: "profile name, e.g. gaming", maxlength: "40" });
    const pList = h("div"), pNote = h("div", { class: "nd-row" });
    const bSave = btn("save current settings", async () => {
      bSave.disabled = true; bSave.textContent = "reading...";
      try { const list = await api("profSave", pName.value); cfg.profiles = list; log("profile saved: " + pName.value.trim()); pName.value = ""; drawProfiles(); }
      catch (e) { log("profile: " + e.message); }
      bSave.disabled = false; bSave.textContent = "save current settings";
    });
    function profText(p) {
      const t = [];
      if (p.planName) t.push(p.planName); if (p.volume != null) t.push("volume " + p.volume + "%" + (p.mute ? " muted" : ""));
      if (p.outName) t.push(p.outName); if (p.night != null) t.push("night light " + (p.night ? "on" : "off"));
      if (p.sw) t.push("dark mode " + (p.sw.appsDark ? "on" : "off"));
      return t.join(", ");
    }
    function drawProfiles() {
      pList.textContent = "";
      if (!cfg.profiles.length) { pList.append(note("no profiles yet - set windows the way you like it, then save it here.")); return; }
      for (const p of cfg.profiles) {
        const bApply = btn("apply", async () => {
          bApply.disabled = true;
          try { await api("profApply", p.name); } // the app writes the result to the console
          catch (e) { log("profile: " + e.message); }
          bApply.disabled = false;
        });
        const bDel = btn("delete", () => {
          pNote.textContent = "";
          pNote.append(h("span", { text: "delete profile " + p.name + "?" }), btn("yes, delete", async () => {
            pNote.textContent = ""; try { const list = await api("profDelete", p.name); cfg.profiles = list; drawProfiles(); log("profile deleted: " + p.name); } catch (e) { log(e.message); }
          }, "nd-danger"), btn("cancel", () => { pNote.textContent = ""; }));
        });
        pList.append(h("div", { class: "nd-tr nd-prof" }, h("span", { text: p.name, title: profText(p) }), h("span", { class: "nd-dim", text: profText(p) }), h("div", { class: "nd-row" }, bApply, bDel)));
      }
    }
    sec.profiles = h("div", { class: "nd-bsec" }, sub("profiles"), h("div", { class: "nd-row" }, pName, bSave),
      note("saves the power plan, volume, sound output, night light, dark mode and transparency."), pList, pNote);

    // 3. game mode
    const bGame = btn("game mode: off", async () => {
      const on = !cfg.game.active; bGame.disabled = true; bGame.textContent = on ? "starting..." : "restoring...";
      try { const r = await api("gameMode", on); cfg.game.active = r.active; cfg.game.since = Date.now(); }
      catch (e) { log("game mode: " + e.message); }
      bGame.disabled = false; drawGame();
    });
    const gApps = h("div", { class: "nd-row" }), gSel = h("select", { class: "nd-input" }), gForce = toggle("force close (for programs that hide in the tray)", on => set("gameForce", on, "force close " + (on ? "on" : "off")));
    const bAdd = btn("add", () => { if (gSel.value) set("gameApps", cfg.game.apps.concat(gSel.value), "game mode will close " + gSel.value); });
    async function loadRunning() {
      try {
        const list = (await api("procs")).filter(p => !p.protected && p.win).map(p => p.name).sort((a, b) => a.localeCompare(b));
        gSel.textContent = ""; gSel.append(h("option", { value: "", text: "running programs..." }), ...list.map(n => h("option", { value: n, text: n })));
      } catch (e) {}
    }
    function drawGame() {
      bGame.textContent = "game mode: " + (cfg.game.active ? "on" : "off"); bGame.classList.toggle("nd-on", cfg.game.active);
      gForce.inp.checked = cfg.game.force;
      gApps.textContent = "";
      if (!cfg.game.apps.length) gApps.append(note("no programs chosen"));
      for (const n of cfg.game.apps) gApps.append(btn(n + "  ×", () => set("gameApps", cfg.game.apps.filter(x => x !== n), n + " removed from game mode")));
    }
    sec.game = h("div", { class: "nd-bsec" }, sub("game mode"), h("div", { class: "nd-row" }, bGame, note("high performance, no notification banners, chosen programs closed. turning it off puts everything back.")),
      h("div", { class: "nd-row" }, h("span", { class: "nd-dim", text: "close these" }), gSel, bAdd, btn("refresh", loadRunning)), gApps, gForce.el);

    // 4. gpu details
    const G = { name: info("graphics"), temp: info("temperature"), use: info("usage"), fan: info("fan"), mem: info("memory"), pow: info("power"), clk: info("core clock"), mclk: info("memory clock"), ps: info("power state"), drv: info("driver") };
    const gpuNote = note("");
    async function loadGpu() {
      try {
        const g = await api("gpuStats");
        if (!g.ok) { gpuNote.textContent = g.msg; return; }
        gpuNote.textContent = "";
        const n = k => g[k] === "" ? null : Number(g[k]);
        G.name.o.textContent = g.name || "-"; G.drv.o.textContent = g.driver_version || "-"; G.ps.o.textContent = g.pstate || "-";
        G.temp.o.textContent = n("temperature.gpu") != null ? Math.round(n("temperature.gpu")) + " °C" : "-";
        G.use.o.textContent = n("utilization.gpu") != null ? n("utilization.gpu") + "%" : "-";
        G.fan.o.textContent = n("fan.speed") != null ? n("fan.speed") + "%" : "-";
        G.mem.o.textContent = n("memory.total") ? (n("memory.used") / 1024).toFixed(1) + " / " + (n("memory.total") / 1024).toFixed(1) + " GB" : "-";
        G.pow.o.textContent = n("power.draw") != null ? Math.round(n("power.draw")) + " W" + (n("power.limit") ? " of " + Math.round(n("power.limit")) + " W" : "") : "-";
        G.clk.o.textContent = n("clocks.gr") != null ? n("clocks.gr") + " MHz" + (n("clocks.max.gr") ? " (max " + n("clocks.max.gr") + ")" : "") : "-";
        G.mclk.o.textContent = n("clocks.mem") != null ? n("clocks.mem") + " MHz" : "-";
      } catch (e) { gpuNote.textContent = e.message; }
    }
    sec.gpu = h("div", { class: "nd-bsec" }, sub("gpu details"), h("div", { class: "nd-two" }, h("div", { class: "nd-kv" }, G.name.el, G.temp.el, G.use.el, G.fan.el, G.mem.el),
      h("div", { class: "nd-kv" }, G.pow.el, G.clk.el, G.mclk.el, G.ps.el, G.drv.el)), gpuNote);

    // 5. overlay
    const oCorner = h("select", { class: "nd-input" }, [["tr", "top right"], ["tl", "top left"], ["br", "bottom right"], ["bl", "bottom left"]].map(([v, t]) => h("option", { value: v, text: t })));
    oCorner.addEventListener("change", () => set("corner", oCorner.value, "overlay moved to the " + oCorner.selectedOptions[0].text));
    sec.overlay = h("div", { class: "nd-bsec" }, sub("overlay"), h("div", { class: "nd-row" }, h("span", { class: "nd-dim", text: "corner" }), oCorner),
      note("shows cpu, memory and gpu on the main screen; clicks go through it. games in exclusive full screen cover it - use borderless or windowed. it is a normal window and does not touch the game."));

    // 6. screens
    const mList = h("div", { class: "nd-kv" }), mNote = note("");
    async function loadMon() {
      try {
        const r = await api("monitors", null, null); mList.textContent = "";
        if (!r.ok) { mNote.textContent = r.msg; return; }
        mNote.textContent = r.list.some(m => m.bright < 0) ? "screens without a slider do not allow brightness control (ddc/ci may be off in the screen's own menu)." : "";
        for (const m of r.list) {
          const label = "screen " + (m.i + 1) + (m.main ? " (main)" : "") + " - " + m.size;
          if (m.bright < 0) { mList.append(h("div", { class: "nd-info" }, h("span", { text: label }), h("output", { text: "no brightness control" }))); continue; }
          const out = h("output", { text: m.bright }), inp = h("input", { type: "range", min: "0", max: "100", value: String(m.bright) });
          inp.style.setProperty("--p", m.bright + "%");
          inp.addEventListener("input", () => { inp.style.setProperty("--p", inp.value + "%"); out.textContent = inp.value; });
          inp.addEventListener("change", async () => {
            try { const x = await api("monitors", m.i, Number(inp.value)), it = x.ok && x.list.find(s => s.i === m.i); log(it && it.bright >= 0 ? label + " brightness " + it.bright + "%" : "the screen did not accept the change"); }
            catch (e) { log("brightness: " + e.message); }
          });
          mList.append(h("label", { class: "nd-slider" }, h("div", null, label, out), inp));
        }
      } catch (e) { mNote.textContent = e.message; }
    }
    const modeBtn = (t, m, msg) => btn(t, async () => { try { const r = await api("screenMode", m); log(r.ok ? msg : "screens: " + r.msg); setTimeout(loadMon, 3000); } catch (e) { log(e.message); } });
    sec.monitors = h("div", { class: "nd-bsec" }, h("div", { class: "nd-row" }, h("span", { class: "nd-sub", text: "screens" }), btn("refresh", loadMon)), mList, mNote,
      h("div", { class: "nd-row" }, modeBtn("main screen only", "one", "second screen off"), modeBtn("extend (both)", "extend", "both screens on"), modeBtn("duplicate", "clone", "screens duplicated")));

    // 7. command search
    const kIn = h("input", { class: "nd-input", size: "20", spellcheck: "false" }), kNote = note("");
    sec.palette = h("div", { class: "nd-bsec" }, sub("command search"), h("div", { class: "nd-row" }, h("span", { class: "nd-dim", text: "hotkey" }), kIn,
      btn("set", () => set("palKey", kIn.value, "command search hotkey: " + kIn.value.trim())), kNote),
      note("press the hotkey anywhere, or ctrl + k inside nightdeck, then type what you want to do."));
    const pal = h("div", { class: "nd-pal-wrap" }), pIn = h("input", { class: "nd-input", placeholder: "type to search every button and switch...", spellcheck: "false" }), pRes = h("div", { class: "nd-pal-list" });
    pal.append(h("div", { class: "nd-pal-box" }, pIn, pRes)); pal.style.display = "none"; document.body.append(pal);
    let items = [], sel = 0;
    function collect() {
      const out = [], seen = new Set();
      document.querySelectorAll(".nd-tab").forEach(t => out.push({ tab: t.dataset.tab, text: "open " + t.textContent.trim().toLowerCase(), run: () => panel.select(t.dataset.tab) }));
      document.querySelectorAll(".nd-pane").forEach(p => {
        const tab = p.dataset.pane;
        p.querySelectorAll("button.nd-btn, label.nd-opt").forEach(el => {
          const text = el.textContent.replace(/\s+/g, " ").trim().toLowerCase(); if (!text || text.length > 60 || el.disabled || el.closest("[data-nopal]")) return;
          const key = tab + "|" + text; if (seen.has(key)) return; seen.add(key);
          out.push({ tab, text, run: () => { panel.select(tab); setTimeout(() => { el.scrollIntoView({ block: "center" }); el.click(); }, 60); } });
        });
      });
      return out;
    }
    function draw() {
      const q = pIn.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const list = items.filter(it => q.every(w => (it.text + " " + it.tab).includes(w))).slice(0, 40);
      sel = Math.min(sel, Math.max(0, list.length - 1)); pRes.textContent = "";
      list.forEach((it, i) => pRes.append(h("div", { class: "nd-pal-item" + (i === sel ? " nd-sel" : ""), onclick: () => go(it) }, h("span", { text: it.text }), h("small", { text: it.tab }))));
      const s = pRes.children[sel]; if (s) s.scrollIntoView({ block: "nearest" });
      pRes._list = list;
    }
    function close() { pal.style.display = "none"; }
    function go(it) { close(); log("command: " + it.text); it.run(); }
    window.ndPalette = () => { if (!cfg || !cfg.on.palette) return; items = collect(); pIn.value = ""; sel = 0; pal.style.display = ""; draw(); pIn.focus(); };
    pIn.addEventListener("input", () => { sel = 0; draw(); });
    pIn.addEventListener("keydown", e => {
      const list = pRes._list || [];
      if (e.key === "ArrowDown") { sel = Math.min(list.length - 1, sel + 1); draw(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
      else if (e.key === "Enter") { if (list[sel]) go(list[sel]); }
      else if (e.key === "Escape") close();
    });
    pal.addEventListener("mousedown", e => { if (e.target === pal) close(); });
    document.addEventListener("keydown", e => { if (e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === "k" || e.key === "K")) { e.preventDefault(); window.ndPalette(); } });

    // 8. scheduled actions
    const ACT = [["lock", "lock the pc"], ["sleep", "sleep"], ["screenoff", "screens off"], ["shutdown", "shut down (1 minute warning)"], ["restart", "restart (1 minute warning)"],
      ["game-on", "game mode on"], ["game-off", "game mode off"], ["night-on", "night light on"], ["night-off", "night light off"], ["mute", "mute sound"]];
    const sKind = h("select", { class: "nd-input" }, h("option", { value: "time", text: "at a time" }), h("option", { value: "start", text: "when a program starts" }));
    const sTime = h("input", { class: "nd-input", type: "time", value: "23:00" });
    const sDays = h("select", { class: "nd-input" }, [["daily", "every day"], ["weekdays", "monday - friday"], ["weekends", "weekend"], ["once", "once"]].map(([v, t]) => h("option", { value: v, text: t })));
    const sProc = h("input", { class: "nd-input", placeholder: "program, e.g. steam", size: "16", spellcheck: "false" });
    const sAct = h("select", { class: "nd-input" });
    let openTarget = "";
    function fillActs() {
      const keep = sAct.value; sAct.textContent = "";
      sAct.append(...ACT.map(([v, t]) => h("option", { value: v, text: t })), ...cfg.profiles.map(p => h("option", { value: "profile:" + p.name, text: "apply profile " + p.name })),
        h("option", { value: "open:", text: openTarget ? "open " + openTarget.replace(/^.*[\\/]/, "") : "open a program or file..." }));
      if ([...sAct.options].some(o => o.value === keep)) sAct.value = keep;
    }
    sAct.addEventListener("change", async () => {
      if (sAct.value !== "open:") return;
      try { const f = await api("pick", "file"); if (f) { openTarget = f; fillActs(); sAct.value = "open:"; } } catch (e) { log(e.message); }
    });
    const syncKind = () => { const t = sKind.value === "time"; sTime.style.display = sDays.style.display = t ? "" : "none"; sProc.style.display = t ? "none" : ""; };
    sKind.addEventListener("change", syncKind); syncKind();
    const sList = h("div");
    const actText = a => a.startsWith("profile:") ? "apply profile " + a.slice(8) : a.startsWith("open:") ? "open " + a.slice(5).replace(/^.*[\\/]/, "") : ((ACT.find(x => x[0] === a) || [a, a])[1]);
    const dayText = { daily: "every day", weekdays: "mon - fri", weekends: "weekend", once: "once" };
    function drawSched() {
      sList.textContent = "";
      if (!cfg.sched.length) { sList.append(note("nothing scheduled")); return; }
      for (const r of cfg.sched) {
        const when = r.kind === "time" ? r.time + " " + dayText[r.days] : "when " + r.proc + " starts";
        const t = toggle(when + "  →  " + actText(r.action), on => set("sched", cfg.sched.map(x => x.id === r.id ? Object.assign({}, x, { on }) : x), "schedule " + (on ? "on" : "off") + ": " + when));
        t.inp.checked = r.on;
        sList.append(h("div", { class: "nd-row nd-srow" }, t.el, btn("×", () => set("sched", cfg.sched.filter(x => x.id !== r.id), "schedule removed: " + when))));
      }
    }
    const bAddS = btn("add", () => {
      let action = sAct.value; if (action === "open:") { if (!openTarget) { log("choose a program or file to open first"); return; } action = "open:" + openTarget; }
      const r = { kind: sKind.value, time: sTime.value, days: sDays.value, proc: sProc.value, action, on: true };
      set("sched", cfg.sched.concat(r), "scheduled: " + (r.kind === "time" ? r.time : "when " + r.proc.trim() + " starts") + " → " + actText(action)).then(ok => { if (ok) sProc.value = ""; });
    });
    sec.schedule = h("div", { class: "nd-bsec" }, sub("scheduled actions"), h("div", { class: "nd-row" }, sKind, sTime, sDays, sProc, sAct, bAddS), sList,
      note("runs while nightdeck is open (also hidden in the tray). program rules notice a start within about 10 seconds."));

    // 9. heavy program alerts
    const num = (v, min, max, step) => h("input", { class: "nd-input", type: "number", min, max, step, value: String(v), style: "width:70px" });
    const aCpu = num(80, 10, 100, 5), aMem = num(4, 0.5, 64, 0.5), aMin = num(3, 1, 60, 1), aLog = h("div");
    function drawAlerts() {
      aCpu.value = cfg.alerts.cpu; aMem.value = cfg.alerts.memGb; aMin.value = cfg.alerts.mins; aLog.textContent = "";
      if (!cfg.alertLog.length) aLog.append(note("no alerts yet"));
      for (const a of cfg.alertLog) aLog.append(h("div", { class: "nd-info" }, h("span", { text: a.msg }), h("output", { text: new Date(a.t).toLocaleString([], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) })));
    }
    sec.alerts = h("div", { class: "nd-bsec" }, sub("heavy program alerts"),
      h("div", { class: "nd-row" }, h("span", { class: "nd-dim", text: "cpu over" }), aCpu, h("span", { class: "nd-dim", text: "% or memory over" }), aMem, h("span", { class: "nd-dim", text: "GB for" }), aMin, h("span", { class: "nd-dim", text: "min" }),
        btn("save", () => set("alerts", { cpu: Number(aCpu.value), memGb: Number(aMem.value), mins: Number(aMin.value) }, "alert limits saved"))),
      h("div", { class: "nd-row" }, h("span", { class: "nd-dim", text: "recent alerts" }), btn("clear", () => set("alertClear", true, "alerts cleared"))), aLog,
      note("one windows notification per program, at most every 30 minutes. cpu is a share of the whole processor."));

    // 10. usage time
    let uWeek = false;
    const uList = h("div"), uTotal = note(""), uNote = h("div", { class: "nd-row" });
    const bToday = btn("today", () => { uWeek = false; loadUsage(); }), bWeek = btn("last 7 days", () => { uWeek = true; loadUsage(); });
    async function loadUsage() {
      bToday.classList.toggle("nd-on", !uWeek); bWeek.classList.toggle("nd-on", uWeek);
      try {
        const u = await api("usageGet"), sum = {};
        for (const d of u.days) if (uWeek || d.day === u.today) for (const n in d.apps) sum[n] = (sum[n] || 0) + d.apps[n];
        const list = Object.entries(sum).sort((a, b) => b[1] - a[1]), max = list.length ? list[0][1] : 1, total = list.reduce((a, b) => a + b[1], 0);
        uList.textContent = ""; uTotal.textContent = list.length ? "total " + fmtDur(total) : "";
        if (!list.length) uList.append(note("nothing counted yet - time is counted while a program is in front and you are at the pc."));
        for (const [n, s] of list.slice(0, 15)) {
          const ic = u.icons[n] ? h("img", { class: "nd-uicon", src: u.icons[n], alt: "" }) : h("span", { class: "nd-uicon" });
          const bar = h("i"); bar.style.width = Math.max(2, s / max * 100) + "%";
          uList.append(h("div", { class: "nd-urow" }, ic, h("span", { text: n }), h("div", { class: "nd-ubar" }, bar), h("output", { text: fmtDur(s) })));
        }
      } catch (e) { uList.textContent = e.message; }
    }
    const bReset = btn("reset", () => {
      uNote.textContent = "";
      uNote.append(h("span", { text: "delete all counted usage time?" }), btn("yes, delete", async () => { uNote.textContent = ""; try { await api("usageReset"); log("usage time reset"); loadUsage(); } catch (e) { log(e.message); } }, "nd-danger"), btn("cancel", () => { uNote.textContent = ""; }));
    });
    sec.usage = h("div", { class: "nd-bsec" }, h("div", { class: "nd-row" }, h("span", { class: "nd-sub", text: "usage time" }), bToday, bWeek, btn("refresh", loadUsage), bReset, uTotal), uNote, uList);

    // 11. remote control for claude
    const rState = note(""), rDir = h("span", { class: "nd-dim nd-pw", text: "" });
    sec.remote = h("div", { class: "nd-bsec" }, h("div", { class: "nd-row" }, h("span", { class: "nd-sub", text: "remote control for claude" }), rState,
      btn("add one hour", () => set("feat", { id: "remote", on: true }).then(() => log(cfg.on.remote ? "remote control on until " + new Date(cfg.remoteUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + " (4 hours at most)" : "remote control could not be switched on")))),
      note("lets claude read nightdeck's values and change settings that can be undone, by putting small request files in this folder. it cannot start or close programs, delete files or shut down. every change is written in the console. it switches itself off when the time runs out: one hour, and each \"add one hour\" adds another (4 hours at most)."), rDir);
    function drawRemote() {
      rState.textContent = cfg.on.remote && cfg.remoteUntil ? "on until " + new Date(cfg.remoteUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "off";
      rDir.textContent = cfg.remoteDir || "";
    }

    root.append(sub("features"), h("div", { class: "nd-grid2", "data-nopal": "1" }, FEATS.map(([id]) => feat[id].el)),
      note("these are test features. switch off what you do not use - background ones only run while switched on."),
      ...FEATS.map(([id]) => sec[id]));

    function show() {
      if (!cfg) return;
      for (const [id] of FEATS) { feat[id].inp.checked = !!cfg.on[id]; sec[id].style.display = cfg.on[id] ? "" : "none"; }
      drawProfiles(); drawGame(); drawSched(); drawAlerts(); fillActs(); drawRemote();
      oCorner.value = cfg.corner; if (document.activeElement !== kIn) kIn.value = cfg.palKey;
      kNote.textContent = cfg.on.palette && !cfg.palOk ? "windows did not accept this hotkey - another program may use it" : "";
    }
    function loadSec(id) {
      if (id === "gpu") loadGpu(); else if (id === "monitors") loadMon(); else if (id === "usage") loadUsage(); else if (id === "game") loadRunning();
    }
    let first = true, gpuT = null;
    async function load() {
      try { cfg = await api("betaGet"); show(); } catch (e) { log("beta: " + e.message); return; }
      for (const [id] of FEATS) if (cfg.on[id] && (first || id === "gpu" || id === "usage")) loadSec(id);
      first = false;
      clearInterval(gpuT); gpuT = setInterval(() => { if (active !== "beta") { clearInterval(gpuT); return; } if (cfg.on.gpu) loadGpu(); }, 3000);
    }
    onTab.beta = load;
    if (ND.api) api("betaGet").then(c => { if (!cfg) { cfg = c; show(); } }).catch(() => {}); // the search hotkey works before the tab is opened
  })();

  // open the tab that was open last time
  const lastTab = store.get("tab", "system");
  panel.select(document.querySelector('[data-pane="' + lastTab + '"]') ? lastTab : "system");
})();
