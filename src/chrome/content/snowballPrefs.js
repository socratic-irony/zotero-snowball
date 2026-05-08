var SnowballPrefs = {
  args: null,

  // Pref name -> { type, default, [min, max], [maxLength] }
  // Bounds are enforced on save so users can't persist nonsense values
  // (negative limits, runaway maxes, multi-MB API keys).
  schema: {
    openAlexAPIKey:        { type: "string",  default: "",   maxLength: 256 },
    semanticScholarAPIKey: { type: "string",  default: "",   maxLength: 256 },
    includeForward:        { type: "boolean", default: true },
    includeBackward:       { type: "boolean", default: true },
    skipAlreadyInLibrary:  { type: "boolean", default: true },
    maxSeeds:              { type: "number",  default: 50,    min: 1,    max: 500 },
    maxForwardPerSeed:     { type: "number",  default: 100,   min: 0,    max: 1000 },
    maxBackwardPerSeed:    { type: "number",  default: 100,   min: 0,    max: 1000 },
    maxCandidatesTotal:    { type: "number",  default: 500,   min: 1,    max: 10000 },
    requestTimeoutMs:      { type: "number",  default: 30000, min: 1000, max: 120000 }
  },

  _pendingValues: null,

  onLoad(args) {
    try {
      this.args = args || {};
      for (const [name, spec] of Object.entries(this.schema)) {
        const input = document.getElementById(`pref-${name}`);
        if (!input) continue;
        const value = this.args.plugin
          ? this.args.plugin.pref(name, spec.default)
          : spec.default;
        if (spec.type === "boolean") {
          input.checked = !!value;
        } else {
          input.value = (value === null || value === undefined) ? "" : String(value);
        }
        // Reflect bounds in the input so the OS-level UI helps with
        // invalid input even before save() runs.
        if (spec.type === "number" && input.type === "number") {
          if (Number.isFinite(spec.min)) input.min = String(spec.min);
          if (Number.isFinite(spec.max)) input.max = String(spec.max);
        }
        if (spec.type === "string" && Number.isFinite(spec.maxLength)) {
          input.maxLength = spec.maxLength;
        }
        // Editing any field after the inline confirm panel has appeared
        // resets the flow so the user can click plain "Save" again.
        input.addEventListener("input", () => {
          if (this._pendingValues) {
            this._pendingValues = null;
            this._hideAdjustments();
          }
        });
      }
    } catch (error) {
      try {
        if (typeof SnowballLog !== "undefined") {
          SnowballLog.error("Prefs init failed", { error: SnowballLog.formatError(error) });
        } else if (typeof Zotero !== "undefined") {
          Zotero.debug?.(`Snowball Prefs init failed: ${error?.stack || error}`);
        }
      } catch (_) { /* ignore */ }
    }
  },

  /**
   * Coerce + validate every input, collecting issues so the user is told
   * about them rather than discovering them later as silent fallbacks.
   */
  validate() {
    const result = { values: {}, errors: [] };
    for (const [name, spec] of Object.entries(this.schema)) {
      const input = document.getElementById(`pref-${name}`);
      if (!input) continue;
      if (spec.type === "boolean") {
        result.values[name] = !!input.checked;
        continue;
      }
      if (spec.type === "number") {
        const raw = String(input.value || "").trim();
        const n = Number(raw);
        if (raw && !Number.isFinite(n)) {
          result.errors.push(`${name}: must be a number.`);
          result.values[name] = spec.default;
          continue;
        }
        const clamped = Math.max(
          Number.isFinite(spec.min) ? spec.min : -Infinity,
          Math.min(
            Number.isFinite(spec.max) ? spec.max : Infinity,
            Math.trunc(Number.isFinite(n) ? n : spec.default)
          )
        );
        if (Number.isFinite(n) && clamped !== Math.trunc(n)) {
          result.errors.push(
            `${name}: clamped to ${clamped} (allowed range ${spec.min}–${spec.max}).`
          );
        }
        result.values[name] = clamped;
        continue;
      }
      // string
      let s = String(input.value || "").trim();
      if (Number.isFinite(spec.maxLength) && s.length > spec.maxLength) {
        s = s.slice(0, spec.maxLength);
        result.errors.push(`${name}: truncated to ${spec.maxLength} characters.`);
      }
      // Defensive: API keys must look key-shaped (printable ASCII), not an
      // accidentally pasted multi-line block.
      if (/[\r\n\t]/.test(s)) {
        result.errors.push(`${name}: removed whitespace/newline characters.`);
        s = s.replace(/[\r\n\t]+/g, "");
      }
      result.values[name] = s;
    }
    return result;
  },

  /**
   * First Save click. If the user's input was clean, persist and close.
   * If anything was adjusted, surface the diff inline and switch the
   * footer to "Save anyway" instead of popping a [JavaScript Application]
   * confirm dialog.
   */
  save() {
    try {
      const { values, errors } = this.validate();
      if (errors.length) {
        this._pendingValues = values;
        this._showAdjustments(errors);
        return;
      }
      this._commit(values);
    } catch (error) {
      this._showError(error);
    }
  },

  /** Second click — user said "Save anyway" after seeing the inline diff. */
  saveConfirmed() {
    try {
      const values = this._pendingValues;
      this._pendingValues = null;
      this._hideAdjustments();
      if (!values) return;
      this._commit(values);
    } catch (error) {
      this._showError(error);
    }
  },

  _commit(values) {
    for (const [name, value] of Object.entries(values)) {
      this.args.plugin.setPref(name, value);
    }
    window.close();
  },

  _showAdjustments(errors) {
    const panel = document.getElementById("snowball-prefs-confirm");
    const list  = document.getElementById("snowball-prefs-confirm-details");
    if (panel && list) {
      list.replaceChildren();
      for (const e of errors) {
        const li = document.createElementNS("http://www.w3.org/1999/xhtml", "li");
        li.textContent = String(e);
        list.appendChild(li);
      }
      panel.removeAttribute("hidden");
    }
    // Swap the primary button: "Save" → "Save anyway".
    document.getElementById("snowball-prefs-save")?.setAttribute("hidden", "hidden");
    document.getElementById("snowball-prefs-save-anyway")?.removeAttribute("hidden");
  },

  _hideAdjustments() {
    document.getElementById("snowball-prefs-confirm")?.setAttribute("hidden", "hidden");
    document.getElementById("snowball-prefs-save")?.removeAttribute("hidden");
    document.getElementById("snowball-prefs-save-anyway")?.setAttribute("hidden", "hidden");
  },

  _showError(error) {
    try {
      if (typeof SnowballLog !== "undefined") {
        SnowballLog.error("Prefs save failed", { error: SnowballLog.formatError(error) });
      }
    } catch (_) { /* ignore */ }
    const panel = document.getElementById("snowball-prefs-confirm");
    const list  = document.getElementById("snowball-prefs-confirm-details");
    const friendly = (typeof formatUserError === "function")
      ? formatUserError(error)
      : (error?.message || String(error));
    if (panel && list) {
      list.replaceChildren();
      const li = document.createElementNS("http://www.w3.org/1999/xhtml", "li");
      li.textContent = `Couldn't save: ${friendly}`;
      list.appendChild(li);
      panel.removeAttribute("hidden");
    }
  }
};
