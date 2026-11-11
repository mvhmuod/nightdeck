/* Nightdeck panel kit - v1.0
   Usage:
     const panel = Nightdeck.create("#app", {
       title: "My Panel",
       tabs: { general: [ {id:"dark", label:"dark mode", on:true}, {id:"vol", label:"volume", range:70} ] },
       presets: { loud: {vol:100} },
       onChange(id, value, all) { ... }
     });
     panel.get("vol"); panel.set("vol", 20); panel.values(); panel.reset(); panel.log("hi");
*/
(function (global) {
  function esc(s){ return String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

  function create(target, opts) {
    const host = typeof target === "string" ? document.querySelector(target) : target;
    if (!host) throw new Error("Nightdeck: target not found");
    const o = Object.assign({ title:"Nightdeck", tabs:{}, presets:{}, console:true, version:"v1.0", onChange:null, onLog:null, onSelect:null }, opts);
    const defs = {}, els = {};
    const names = Object.keys(o.tabs);

    host.classList.add("nd-root");
    host.innerHTML =
      '<section class="nd-win nd-menu"><div class="nd-body"><div class="nd-side">' +
      '<h1 class="nd-title">' + esc(o.title) + '</h1><div class="nd-tabs" role="tablist"></div></div>' +
      '<div class="nd-panes"></div></div><div class="nd-foot"><button class="nd-btn" data-act="reset">reset</button>' +
      Object.keys(o.presets).map(p => '<button class="nd-btn" data-preset="' + esc(p) + '">' + esc(p) + '</button>').join("") +
      '<small>' + esc(o.version) + '</small></div></section>' +
      (o.console ? '<section class="nd-win nd-console"><div class="nd-inner"><h2 class="nd-ctitle">Console</h2><div class="nd-log" aria-live="polite"></div></div></section>' : "");

    const tabsEl = host.querySelector(".nd-tabs"), panesEl = host.querySelector(".nd-panes"), logEl = host.querySelector(".nd-log");

    names.forEach(name => {
      const t = document.createElement("button");
      t.className = "nd-tab"; t.setAttribute("role","tab"); t.textContent = name; t.dataset.tab = name;
      tabsEl.append(t);
      const p = document.createElement("div"); p.className = "nd-pane"; p.dataset.pane = name;
      p.innerHTML = o.tabs[name].map(it => {
        if (it.custom) return '<div class="nd-custom" data-custom="' + esc(it.custom) + '"></div>';
        if (it.meter) return '<div class="nd-meter" data-meter="' + esc(it.id) + '"><div>' + esc(it.label) + '<output></output></div><div class="nd-meterbar"><i></i></div></div>';
        if (it.info) return '<div class="nd-info" data-info="' + esc(it.id) + '"><span>' + esc(it.label) + '</span><output></output></div>';
        if (it.range !== undefined) { defs[it.id] = Number(it.range);
          return '<label class="nd-slider"><div>' + esc(it.label) + '<output></output></div><input type="range" min="' + (it.min ?? 0) + '" max="' + (it.max ?? 100) + '" value="' + Number(it.range) + '" data-id="' + esc(it.id) + '"></label>'; }
        defs[it.id] = !!it.on;
        return '<label class="nd-opt"><input type="checkbox" data-id="' + esc(it.id) + '"' + (it.on ? " checked" : "") + '><span></span>' + esc(it.label) + '</label>';
      }).join("");
      panesEl.append(p);
    });
    host.querySelectorAll("[data-id]").forEach(el => { els[el.dataset.id] = el; if (el.type === "range") paint(el); });

    function paint(r){ const pct = (r.value - r.min) / (r.max - r.min) * 100; r.style.setProperty("--p", pct + "%"); r.closest(".nd-slider").querySelector("output").textContent = r.value; }
    function read(el){ return el.type === "checkbox" ? el.checked : Number(el.value); }
    function log(msg){ if (o.onLog) o.onLog(String(msg)); if (!logEl) return; const t = new Date().toTimeString().slice(0,8); logEl.insertAdjacentHTML("beforeend", "<i>[" + t + "]</i> " + esc(msg) + "\n"); logEl.scrollTop = logEl.scrollHeight; }
    function values(){ const v = {}; for (const id in els) v[id] = read(els[id]); return v; }
    function get(id){ return els[id] ? read(els[id]) : undefined; }
    function set(id, value, silent){
      const el = els[id]; if (!el) return;
      if (el.type === "checkbox") el.checked = !!value; else { el.value = value; paint(el); }
      if (!silent) fire(id);
    }
    function fire(id){ const v = get(id); log(id + " = " + (v === true ? "on" : v === false ? "off" : v)); if (o.onChange) o.onChange(id, v, values()); }
    function select(name){
      host.querySelectorAll(".nd-tab").forEach(t => t.setAttribute("aria-selected", String(t.dataset.tab === name)));
      host.querySelectorAll(".nd-pane").forEach(p => p.classList.toggle("nd-show", p.dataset.pane === name));
      if (o.onSelect) o.onSelect(name);
    }
    function setMeter(id, pct, text, hot){
      const m = host.querySelector('[data-meter="' + id + '"]'); if (!m) return;
      pct = Math.max(0, Math.min(100, Number(pct) || 0));
      m.querySelector("output").textContent = text !== undefined ? text : Math.round(pct) + "%";
      // Animate the fill, so the colour changes at the moment the bar passes each threshold.
      const bar = m.querySelector("i"), from = m._cur === undefined ? 0 : m._cur, start = performance.now(), ms = 700;
      const paint = v => {
        bar.style.width = v + "%";
        const full = Math.round(v) >= 100;
        bar.classList.toggle("nd-full", full);
        bar.classList.toggle("nd-hot", !full && (hot === undefined ? v > 50 : !!hot));
      };
      cancelAnimationFrame(m._raf);
      const step = now => {
        const t = Math.min(1, (now - start) / ms), e = 1 - Math.pow(1 - t, 3);
        m._cur = from + (pct - from) * e; paint(m._cur);
        if (t < 1) m._raf = requestAnimationFrame(step);
      };
      m._raf = requestAnimationFrame(step);
    }
    function setInfo(id, text){ const r = host.querySelector('[data-info="' + id + '"] output'); if (r) r.textContent = text; }
    function reset(){ for (const id in defs) set(id, defs[id], true); log("all settings reset to defaults"); if (o.onChange) o.onChange(null, null, values()); }
    function preset(name){ const p = o.presets[name]; if (!p) return; for (const id in p) set(id, p[id], true); log("preset " + name + " applied"); if (o.onChange) o.onChange(null, null, values()); }

    tabsEl.addEventListener("click", e => { if (e.target.dataset.tab) select(e.target.dataset.tab); });
    panesEl.addEventListener("input", e => { if (e.target.type === "range") paint(e.target); });
    panesEl.addEventListener("change", e => { if (e.target.dataset.id) fire(e.target.dataset.id); });
    host.querySelector(".nd-foot").addEventListener("click", e => {
      if (e.target.dataset.act === "reset") reset();
      else if (e.target.dataset.preset) preset(e.target.dataset.preset);
    });

    if (names.length) select(names[0]);
    log("welcome to " + String(o.title).toLowerCase());
    log(Object.keys(els).length ? "loaded " + Object.keys(els).length + " settings in " + names.length + " tabs" : "loaded " + names.length + " tabs");
    return { get, set, values, reset, preset, select, log, setMeter, setInfo, el: host };
  }

  global.Nightdeck = { create, version: "1.0" };
})(window);
