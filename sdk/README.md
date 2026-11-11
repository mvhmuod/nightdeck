# Nightdeck panel kit

A small dark control-panel UI (sidebar tabs, checkboxes, sliders, presets, console) in plain HTML, CSS and JavaScript. No build step and no dependencies.

## Open it

Double-click `index.html`. It opens in your browser. `examples/demo.html` shows the panel driving something on the page.

## Files

- `nightdeck.js` - the library (`Nightdeck.create`)
- `nightdeck.css` - the styles; colours are the `--nd-*` variables at the top
- `index.html` - demo
- `examples/demo.html` - second demo with a live preview

## Use it in your own page

```html
<link rel="stylesheet" href="nightdeck.css">
<div id="app"></div>
<script src="nightdeck.js"></script>
<script>
  const panel = Nightdeck.create("#app", {
    title: "My Panel",
    tabs: {
      general: [
        { id: "dark", label: "dark mode", on: true },   // checkbox
        { id: "volume", label: "volume", range: 70 }     // slider (optional min, max)
      ]
    },
    presets: { loud: { volume: 100 } },
    onChange(id, value, all) { console.log(id, value, all); }
  });
</script>
```

## API

| Call | What it does |
|---|---|
| `panel.get(id)` | current value (true/false or number) |
| `panel.set(id, value)` | change a value and fire `onChange` |
| `panel.values()` | all values as one object |
| `panel.reset()` | back to defaults |
| `panel.preset(name)` | apply a preset |
| `panel.select(tab)` | switch tab |
| `panel.log(text)` | write a line to the console pane |

Options: `title`, `tabs`, `presets`, `onChange`, `console` (false hides the console pane), `version` (footer text).

Fonts load from Google Fonts when online; offline it falls back to system fonts.
