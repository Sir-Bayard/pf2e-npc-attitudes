/**
 * PF2e NPC Attitudes
 * How the people the party has met feel about them.
 *
 * Each NPC actor carries a flag with whether the party has met them, their attitude (GM Core's
 * Hostile to Helpful), what the players are shown when that differs, a public one-line description,
 * the name and portrait the party knows them by, and the party's shared notes. Players can only add
 * and remove their own notes; those go through the GM's client.
 *
 * The name shown to players is the record's "known as" name, else the actor's prototype token name.
 * The actor's own name is shown to the GM only. The portrait shown to players is the record's
 * portrait, else the prototype token image, else the actor image.
 */

const MOD = "pf2e-npc-attitudes";
const FLAG = "npc";
const NOTE_MAX = 40;
const NOTE_CHARS = 4000;
const CHIPS_KEY = `${MOD}.chips`;

const ATTITUDES = [
  { id: "hostile", label: "Hostile", icon: "fa-face-angry" },
  { id: "unfriendly", label: "Unfriendly", icon: "fa-face-frown" },
  { id: "indifferent", label: "Indifferent", icon: "fa-face-meh" },
  { id: "friendly", label: "Friendly", icon: "fa-face-smile" },
  { id: "helpful", label: "Helpful", icon: "fa-face-smile-beam" },
];
const UNKNOWN = { id: "unknown", label: "Unknown", icon: "fa-circle-question" };
const attitude = (id) => ATTITUDES.find((a) => a.id === id) ?? null;

/* ------------------------------------------------------------------ */
/* Data                                                               */
/* ------------------------------------------------------------------ */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const isPrimaryGM = () => game.user.isGM && game.users.activeGM?.id === game.user.id;
const FP = () => foundry.applications.apps.FilePicker.implementation;

/** Party notes as a list of entries. Older records hold one string; it becomes the first entry. */
function noteEntries(notes) {
  if (Array.isArray(notes)) return notes.filter((e) => e && typeof e.text === "string").map((e) => ({ by: e.by ?? null, at: e.at ?? null, text: e.text }));
  const text = String(notes ?? "").trim();
  return text ? [{ by: null, at: null, text }] : [];
}

/** Add an entry, dropping the oldest while over the caps. */
function appendNote(list, entry) {
  const out = [...list, { by: entry.by ?? null, at: entry.at ?? null, text: String(entry.text ?? "").slice(0, NOTE_CHARS) }];
  const chars = () => out.reduce((n, e) => n + e.text.length, 0);
  while (out.length > NOTE_MAX || chars() > NOTE_CHARS) out.shift();
  return out;
}

const sameNote = (e, at, by) => String(e.at ?? "") === String(at ?? "") && String(e.by ?? "") === String(by ?? "");

/** The NPC record on an actor, with defaults filled in. */
function record(actor) {
  const f = actor?.flags?.[MOD]?.[FLAG] ?? {};
  return {
    met: !!f.met,
    metAt: f.metAt ?? null,
    attitude: f.attitude ?? null,
    shown: f.shown ?? "same",
    blurb: f.blurb ?? "",
    knownAs: f.knownAs ?? "",
    portrait: f.portrait ?? "",
    notes: noteEntries(f.notes),
    pcs: f.pcs ?? {},
  };
}

/** What a player may know of the record: the shown attitude, never the real one. */
function publicRecord(actor) {
  const r = record(actor);
  return {
    met: r.met,
    attitude: shownAttitude(r).id,
    blurb: r.blurb,
    knownAs: knownName(actor),
    portrait: playerImg(actor, r),
    notes: r.notes,
    pcs: Object.fromEntries(shownOverrides(r).map(({ pc, a }) => [pc.id, a.id])),
  };
}

/** The party's characters, for attitudes toward one character in particular. */
function partyMembers() {
  const members = game.actors.party?.members?.filter((a) => a.type === "character") ?? [];
  const list = members.length ? members : game.actors.filter((a) => a.type === "character" && a.hasPlayerOwner);
  return [...list].sort((a, b) => pcName(a).localeCompare(pcName(b)));
}

const pcName = (pc) => pc.prototypeToken?.name?.trim() || pc.name;

/** Attitudes toward particular characters that differ from the NPC's general one, as players may see them. */
function shownOverrides(r) {
  if (r.shown !== "same") return [];
  return partyMembers()
    .map((pc) => ({ pc, a: attitude(r.pcs[pc.id]) }))
    .filter(({ a }) => a && a.id !== r.attitude);
}

/** The attitude the players see: the true one, another one, or Unknown. */
function shownAttitude(r) {
  if (r.shown === "unknown") return UNKNOWN;
  if (r.shown && r.shown !== "same") return attitude(r.shown) ?? UNKNOWN;
  return attitude(r.attitude) ?? UNKNOWN;
}

/** The name the party knows: the record's "known as", else the prototype token name. */
function knownName(actor) {
  return record(actor).knownAs || actor.prototypeToken?.name?.trim() || actor.name;
}

/** The image players see: the record's portrait, else the prototype token image, else the actor image. */
/** Art that came with a stat block (the system's or a Paizo token pack's): it names the real creature, so players don't get it. */
const SHIPPED_ART = /^(?:systems\/pf2e\/|modules\/(?:pf2e-tokens-|pathfinder-tokens|pf2e-bestiary-|pf2e-monster-core|pf2e-npc-core)|icons\/)/i;
/**
 * The art players see: the record's own portrait, else the actor's portrait unless it is a stand-in's shipped art
 * (then the token, which the GM chose), else whatever is left. Full art, cropped to the card; a click opens it whole.
 */
function playerImg(actor, r = record(actor)) {
  if (r.portrait) return r.portrait;
  const img = actor.img ?? "";
  if (img && !SHIPPED_ART.test(img)) return img;
  return actor.prototypeToken?.texture?.src || img;
}

/**
 * An NPC actor no player owns, or one that already has a record here: an NPC the GM lends a player for a fight
 * (owner permission) keeps its card. Player-owned summons and companions with no record stay out of the list.
 */
function isNPC(actor) {
  return actor?.type === "npc" && (!actor.hasPlayerOwner || !!actor.flags?.[MOD]?.npc);
}

/** Cast: an actor with flags.<scope>.cast for one of the scopes in the castFlagScopes setting. */
function isCast(actor) {
  const scopes = String(game.settings.get(MOD, "castFlagScopes") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return scopes.some((s) => !!actor.flags?.[s]?.cast);
}

async function update(actor, changes) {
  await actor.update({ [`flags.${MOD}.${FLAG}`]: changes });
}

/** Set or clear one character's attitude override. */
async function setTowards(actor, pcId, id) {
  if (!game.user.isGM || !isNPC(actor)) return;
  if (attitude(id)) return update(actor, { pcs: { [pcId]: id } });
  await actor.update({ [`flags.${MOD}.${FLAG}.pcs.-=${pcId}`]: null });
}

async function markMet(actor, met = true) {
  if (!game.user.isGM || !isNPC(actor)) return;
  await update(actor, { met, metAt: met ? (record(actor).metAt ?? game.time.worldTime) : null });
}

async function setAttitude(actor, id, { shown } = {}) {
  if (!game.user.isGM || !isNPC(actor)) return;
  const changes = { attitude: attitude(id) ? id : null };
  if (shown !== undefined) changes.shown = shown;
  await update(actor, changes);
}

/** The name players see. Empty falls back to the prototype token name. */
async function setKnownAs(actor, name) {
  if (!game.user.isGM || !isNPC(actor)) return;
  await update(actor, { knownAs: String(name ?? "").trim() });
}

/** Show players the actor's real name. */
const reveal = (actor) => setKnownAs(actor, actor.name);

/**
 * After the GM sets an attitude: offer to match the disposition of this actor's tokens on the
 * current scene. Hostile offers Hostile; Friendly and Helpful offer Friendly. Never automatic.
 */
async function offerDisposition(actor, id) {
  const D = CONST.TOKEN_DISPOSITIONS;
  const want = id === "hostile" ? D.HOSTILE : id === "friendly" || id === "helpful" ? D.FRIENDLY : null;
  if (want === null || !canvas.scene) return;
  const tokens = canvas.scene.tokens.filter((t) => t.actorId === actor.id && t.disposition !== want);
  if (!tokens.length) return;
  const label = want === D.HOSTILE ? "Hostile" : "Friendly";
  const n = tokens.length;
  const ok = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Token disposition" },
    content: `<p><strong>${esc(knownName(actor))}</strong> has ${n === 1 ? "a token" : `${n} tokens`} on this scene whose disposition isn't ${label}. Set ${n === 1 ? "it" : "them"} to ${label}?</p>`,
  });
  if (!ok) return;
  await canvas.scene.updateEmbeddedDocuments("Token", tokens.map((t) => ({ _id: t.id, disposition: want })));
}

/* Party notes: written directly by the GM, through the GM's client for everyone else. */

const writeNotes = (actor, list) => actor.update({ [`flags.${MOD}.${FLAG}.notes`]: list });

function emit(msg) {
  if (!game.users.activeGM) return ui.notifications.warn("A GM has to be logged in to save notes.");
  game.socket.emit(`module.${MOD}`, msg);
}

async function addNote(actor, text) {
  text = String(text ?? "").trim().slice(0, NOTE_CHARS);
  if (!text) return;
  const entry = { by: game.user.id, at: Date.now(), text };
  if (game.user.isGM) return writeNotes(actor, appendNote(record(actor).notes, entry));
  emit({ type: "note", actorId: actor.id, entry });
}

/** The GM removes any entry; a player only their own. */
async function deleteNote(actor, at, by) {
  if (game.user.isGM) return writeNotes(actor, record(actor).notes.filter((e) => !sameNote(e, at, by)));
  if (String(by ?? "") !== game.user.id) return;
  emit({ type: "noteDelete", actorId: actor.id, at, by });
}

function onSocket(msg) {
  if (!isPrimaryGM()) return;
  const actor = game.actors.get(msg?.actorId);
  if (!actor || !isNPC(actor) || !record(actor).met) return;
  if (msg.type === "note") {
    const by = String(msg.entry?.by ?? "");
    const text = String(msg.entry?.text ?? "").trim().slice(0, NOTE_CHARS);
    if (!game.users.get(by) || !text) return;
    return writeNotes(actor, appendNote(record(actor).notes, { by, at: Date.now(), text }));
  }
  if (msg.type === "noteDelete") {
    const by = String(msg.by ?? "");
    if (!by) return; // entries without an author (older notes) are the GM's to remove
    return writeNotes(actor, record(actor).notes.filter((e) => !sameNote(e, msg.at, by)));
  }
}

/** Post what the players see of an NPC to chat. Only ever from the Announce button or the API. */
async function announce(actor) {
  if (!game.user.isGM) return;
  const mode = game.settings.get(MOD, "announce");
  if (mode === "off") return ui.notifications.warn("Announcements are turned off in this module's settings.");
  const r = record(actor);
  const a = shownAttitude(r);
  const name = esc(knownName(actor));
  const towards = shownOverrides(r).map(({ pc, a }) => `${a.label.toLowerCase()} to ${esc(pcName(pc))}`).join(", ");
  const content = `<div class="npa-chat"><i class="fa-regular ${a.icon}"></i> <strong>${name}</strong> ${a.id === "unknown" ? "is hard to read" : `seems ${a.label.toLowerCase()} toward the party`}${towards ? ` (${towards})` : ""}.${r.blurb ? ` <em>${esc(r.blurb)}</em>` : ""}</div>`;
  await ChatMessage.create({
    content,
    speaker: { alias: "People" },
    whisper: mode === "gm" ? ChatMessage.getWhisperRecipients("GM").map((u) => u.id) : [],
  }).catch(console.error);
}

/* ------------------------------------------------------------------ */
/* Window                                                             */
/* ------------------------------------------------------------------ */

const openApps = new Set();
let refreshTimer = null;
const TYPING = "textarea, input[type=text], input[type=search], select";
function refresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    for (const app of openApps) {
      if (!app.rendered) continue;
      // Don't redraw under someone who is typing: wait until they leave the field.
      const active = document.activeElement;
      if (active && app.element.contains(active) && active.matches(TYPING)) {
        if (!app._deferred) {
          app._deferred = true;
          active.addEventListener("blur", () => {
            app._deferred = false;
            setTimeout(refresh, 50);
          }, { once: true });
        }
        continue;
      }
      app.render();
    }
  }, 250);
}

function loadChips() {
  try {
    const c = JSON.parse(localStorage.getItem(CHIPS_KEY) ?? "{}");
    return { cast: !!c.cast, metOnly: c.metOnly !== false };
  } catch {
    return { cast: false, metOnly: true };
  }
}

function saveChips(state) {
  try {
    localStorage.setItem(CHIPS_KEY, JSON.stringify({ cast: state.cast, metOnly: state.metOnly }));
  } catch {}
}

class PeopleApp extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "pf2e-npc-attitudes",
    classes: ["npa-app"],
    tag: "div",
    window: { title: "People", icon: "fa-solid fa-address-book", resizable: true },
    position: { width: 880, height: 680 },
    actions: {
      npaFilter: PeopleApp.#onFilter,
      npaChip: PeopleApp.#onChip,
      npaMarkSelected: PeopleApp.#onMarkSelected,
      npaMet: PeopleApp.#onMet,
      npaOpen: PeopleApp.#onOpen,
      npaView: PeopleApp.#onView,
      npaAnnounce: PeopleApp.#onAnnounce,
      npaPickPortrait: PeopleApp.#onPickPortrait,
      npaAddNote: PeopleApp.#onAddNote,
      npaDeleteNote: PeopleApp.#onDeleteNote,
    },
  };

  state = { filter: "all", search: "", openPer: new Set(), ...loadChips() };

  get isGM() {
    return game.user.isGM;
  }

  people() {
    const list = game.actors.filter(isNPC).map((actor) => ({ actor, r: record(actor) }));
    return list
      .filter(({ r }) => r.met || (this.isGM && !this.state.metOnly))
      .filter(({ actor }) => !this.isGM || !this.state.cast || isCast(actor))
      .filter(({ actor, r }) => {
        const a = this.isGM ? attitude(r.attitude) ?? UNKNOWN : shownAttitude(r);
        if (this.state.filter !== "all" && a.id !== this.state.filter) return false;
        const q = this.state.search.trim().toLowerCase();
        if (!q) return true;
        const hay = `${knownName(actor)} ${this.isGM ? actor.name : ""} ${r.blurb}`.toLowerCase();
        return hay.includes(q);
      })
      .sort((x, y) => Number(y.r.met) - Number(x.r.met) || knownName(x.actor).localeCompare(knownName(y.actor)));
  }

  async _renderHTML() {
    const el = document.createElement("div");
    el.className = "npa";
    const people = this.people();
    const filters = [{ id: "all", label: "Everyone" }, ...ATTITUDES, UNKNOWN]
      .map((a) => `<a data-action="npaFilter" data-id="${a.id}" class="${this.state.filter === a.id ? "active" : ""}">${a.icon ? `<i class="fa-regular ${a.icon}"></i> ` : ""}${a.label}</a>`)
      .join("");
    const chip = (id, label, tip) => `<a data-action="npaChip" data-chip="${id}" class="${this.state[id] ? "active" : ""}" data-tooltip="${tip}">${label}</a>`;
    const gm = this.isGM
      ? `<div class="npa-gm">
          <nav class="npa-filters">${chip("metOnly", "Met only", "Hide NPCs the party hasn't met")}${chip("cast", "Cast", "Only actors marked as Cast by the campaign module")}</nav>
          <button type="button" data-action="npaMarkSelected"><i class="fa-solid fa-user-plus"></i> Mark selected tokens as met</button>
        </div>`
      : "";
    const cards = people.length ? people.map((p) => this.#card(p)).join("") : `<p class="npa-empty">${this.isGM && this.state.metOnly ? "Nobody marked as met yet. Turn off 'Met only' to start, or select tokens and mark them." : "The party hasn't met anyone yet."}</p>`;
    el.innerHTML = `<header class="npa-head">
        <input type="search" name="npaSearch" placeholder="Search names" value="${esc(this.state.search)}">
        <nav class="npa-filters">${filters}</nav>
        ${gm}
      </header>
      <section class="npa-body"><div class="npa-cards">${cards}</div></section>`;
    return el;
  }

  #card({ actor, r }) {
    const shown = shownAttitude(r);
    const name = esc(knownName(actor));
    const img = esc(playerImg(actor, r));
    const notes = this.#notes(actor, r);
    if (!this.isGM) {
      return `<article class="npa-card att-${shown.id}">
          <img src="${img}" alt="${name}" data-action="npaView" data-id="${actor.id}" data-tooltip="See the full picture">
          <div class="npa-main">
            <h3>${name}</h3>
            <div class="npa-att"><i class="fa-regular ${shown.icon}"></i> ${shown.label}</div>
            ${this.#overrides(shownOverrides(r))}
            ${r.blurb ? `<p class="npa-blurb">${esc(r.blurb)}</p>` : ""}
            ${notes}
          </div>
        </article>`;
    }
    const truth = attitude(r.attitude) ?? UNKNOWN;
    const opts = (sel, extra = []) => [...extra, ...ATTITUDES].map((a) => `<option value="${a.id}" ${a.id === sel ? "selected" : ""}>${a.label}</option>`).join("");
    const realName = actor.name !== knownName(actor) ? `<span class="npa-real" data-tooltip="The actor's name, GM only">${esc(actor.name)}</span>` : "";
    return `<article class="npa-card att-${truth.id} ${r.met ? "" : "npa-unmet"}">
        <img src="${img}" alt="${name}" data-action="npaOpen" data-id="${actor.id}" data-tooltip="Open sheet">
        <div class="npa-main">
          <h3>${name} ${realName}</h3>
          <div class="npa-row">
            <label>Attitude <select data-field="attitude" data-id="${actor.id}">${opts(r.attitude ?? "", [{ id: "", label: "Not set" }])}</select></label>
            <label data-tooltip="What the players see. Use this when someone hides how they feel.">Players see <select data-field="shown" data-id="${actor.id}">${opts(r.shown, [{ id: "same", label: "The same" }, UNKNOWN])}</select></label>
            <label class="npa-met"><input type="checkbox" data-action="npaMet" data-id="${actor.id}" ${r.met ? "checked" : ""}> Met</label>
            <button type="button" data-action="npaAnnounce" data-id="${actor.id}" data-tooltip="Post what the players see of this NPC to chat"><i class="fa-solid fa-bullhorn"></i> Announce</button>
          </div>
          ${r.shown !== "same" && r.met ? `<div class="npa-att npa-shown">Players see: <i class="fa-regular ${shown.icon}"></i> ${shown.label}${Object.keys(r.pcs).length ? ", and none of the per-character attitudes" : ""}</div>` : ""}
          ${this.#perCharacter(actor, r)}
          <div class="npa-row npa-ident">
            <label data-tooltip="The name players see. Empty: the prototype token name.">Known as <input type="text" data-field="knownAs" data-id="${actor.id}" value="${esc(r.knownAs)}" placeholder="${esc(actor.prototypeToken?.name?.trim() || actor.name)}"></label>
            <label data-tooltip="The image players see. Empty: the prototype token image.">Portrait <input type="text" data-field="portrait" data-id="${actor.id}" value="${esc(r.portrait)}" placeholder="${esc(actor.prototypeToken?.texture?.src || actor.img)}"><a data-action="npaPickPortrait" data-id="${actor.id}" data-tooltip="Pick an image"><i class="fa-solid fa-file-image"></i></a></label>
          </div>
          <input type="text" data-field="blurb" data-id="${actor.id}" value="${esc(r.blurb)}" placeholder="One line the players see: who they are, where the party met them">
          ${notes}
        </div>
      </article>`;
  }

  #overrides(list) {
    if (!list.length) return "";
    return `<div class="npa-pcs">${list.map(({ pc, a }) => `<span class="npa-pc att-${a.id}"><i class="fa-regular ${a.icon}"></i> ${a.label} to ${esc(pcName(pc))}</span>`).join("")}</div>`;
  }

  #perCharacter(actor, r) {
    const pcs = partyMembers();
    if (!pcs.length) return "";
    const set = pcs.filter((pc) => attitude(r.pcs[pc.id]));
    const summary = set.length ? set.map((pc) => `${esc(pcName(pc))}: ${attitude(r.pcs[pc.id]).label}`).join(", ") : "Same toward everyone";
    const rows = pcs.map((pc) => `<label>${esc(pcName(pc))} <select data-field="pc" data-pc="${pc.id}" data-id="${actor.id}">${[{ id: "", label: "As above" }, ...ATTITUDES].map((a) => `<option value="${a.id}" ${a.id === (r.pcs[pc.id] ?? "") ? "selected" : ""}>${a.label}</option>`).join("")}</select></label>`).join("");
    const open = this.state.openPer.has(actor.id) ? "open" : "";
    return `<details class="npa-per" data-id="${actor.id}" ${open}><summary>Toward each character: <span>${summary}</span></summary><div class="npa-per-grid">${rows}</div></details>`;
  }

  /** Party notes: one line per entry, newest last, with who wrote it. */
  #notes(actor, r) {
    const items = r.notes.map((e) => {
      const who = e.by ? game.users.get(e.by)?.name ?? "Someone" : "Party";
      const when = e.at ? new Date(e.at).toLocaleDateString() : "";
      const mine = this.isGM || (e.by && e.by === game.user.id);
      const del = mine ? ` <a data-action="npaDeleteNote" data-id="${actor.id}" data-at="${esc(e.at ?? "")}" data-by="${esc(e.by ?? "")}" data-tooltip="Remove this note"><i class="fa-solid fa-xmark"></i></a>` : "";
      return `<li><strong data-tooltip="${esc(when)}">${esc(who)}</strong> ${esc(e.text)}${del}</li>`;
    }).join("");
    return `<div class="npa-notes"><span>Party notes</span>${items ? `<ul class="npa-note-list">${items}</ul>` : ""}
      <div class="npa-note-add"><input type="text" name="npaNote" data-id="${actor.id}" maxlength="${NOTE_CHARS}" placeholder="Add a note for the party"><button type="button" data-action="npaAddNote" data-id="${actor.id}" data-tooltip="Add note"><i class="fa-solid fa-plus"></i></button></div></div>`;
  }

  _replaceHTML(result, content) {
    // Keep the scroll position across re-renders.
    const top = content.querySelector(".npa-body")?.scrollTop ?? 0;
    content.replaceChildren(result);
    const body = content.querySelector(".npa-body");
    if (body) body.scrollTop = top;
  }

  _onFirstRender() {
    openApps.add(this);
  }

  _onClose() {
    openApps.delete(this);
  }

  _onRender() {
    const search = this.element.querySelector("input[name=npaSearch]");
    search?.addEventListener("input", (e) => {
      this.state.search = e.target.value;
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => this.render().then(() => {
        const s = this.element.querySelector("input[name=npaSearch]");
        s?.focus();
        s?.setSelectionRange(s.value.length, s.value.length);
      }), 250);
    });
    for (const input of this.element.querySelectorAll("[data-field]")) {
      input.addEventListener("change", (e) => this.#onField(e.target));
    }
    for (const input of this.element.querySelectorAll("input[name=npaNote]")) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.#submitNote(input);
        }
      });
    }
    for (const d of this.element.querySelectorAll("details.npa-per")) {
      d.addEventListener("toggle", () => (d.open ? this.state.openPer.add(d.dataset.id) : this.state.openPer.delete(d.dataset.id)));
    }
  }

  async #onField(target) {
    const actor = game.actors.get(target.dataset.id);
    if (!actor || !game.user.isGM) return;
    const field = target.dataset.field;
    if (field === "attitude") {
      await setAttitude(actor, target.value);
      return offerDisposition(actor, target.value);
    }
    if (field === "shown") return update(actor, { shown: target.value });
    if (field === "blurb") return update(actor, { blurb: target.value.trim() });
    if (field === "knownAs") return setKnownAs(actor, target.value);
    if (field === "portrait") return update(actor, { portrait: target.value.trim() });
    if (field === "pc") return setTowards(actor, target.dataset.pc, target.value);
  }

  async #submitNote(input) {
    const actor = game.actors.get(input.dataset.id);
    const text = input.value.trim();
    if (!actor || !text) return;
    input.value = "";
    await addNote(actor, text);
  }

  static #onFilter(event, target) {
    this.state.filter = target.dataset.id;
    this.render();
  }

  static #onChip(event, target) {
    const id = target.dataset.chip;
    this.state[id] = !this.state[id];
    saveChips(this.state);
    this.render();
  }

  static async #onMarkSelected() {
    const tokens = (canvas.tokens?.controlled ?? []).filter((t) => isNPC(t.actor));
    const seeds = new Map();
    let skipped = 0;
    for (const t of tokens) {
      const actor = t.actor.isToken ? game.actors.get(t.actor.id) : t.actor;
      if (!actor) { skipped++; continue; } // an unlinked token whose actor is gone: nothing to record on
      if (seeds.has(actor)) continue;
      // The token's name is the name the party saw: keep it when it differs from the prototype and nothing is set yet.
      const name = t.document.name?.trim() ?? "";
      seeds.set(actor, name && name !== actor.prototypeToken?.name?.trim() && !record(actor).knownAs ? name : "");
    }
    if (!seeds.size) return ui.notifications.warn(skipped ? "The selected tokens' actors no longer exist in the sidebar." : "Select one or more NPC tokens first.");
    for (const [actor, knownAs] of seeds) {
      await markMet(actor, true);
      if (knownAs) await setKnownAs(actor, knownAs);
    }
    ui.notifications.info(`Marked ${seeds.size} as met.${skipped ? ` Skipped ${skipped} whose actor no longer exists.` : ""}`);
  }

  static async #onMet(event, target) {
    const actor = game.actors.get(target.dataset.id);
    if (actor) await markMet(actor, target.checked);
  }

  static #onOpen(event, target) {
    game.actors.get(target.dataset.id)?.sheet?.render(true);
  }
  /** The full picture, in Foundry's image viewer (players: the picture only, under the known name). */
  static #onView(event, target) {
    const actor = game.actors.get(target.dataset.id);
    if (!actor) return;
    const src = playerImg(actor);
    if (!src) return;
    new foundry.applications.apps.ImagePopout({ src, window: { title: knownName(actor) }, uuid: null }).render({ force: true });
  }

  static async #onAnnounce(event, target) {
    const actor = game.actors.get(target.dataset.id);
    if (actor) await announce(actor);
  }

  static #onPickPortrait(event, target) {
    const actor = game.actors.get(target.dataset.id);
    if (!actor) return;
    new (FP())({
      type: "image",
      current: record(actor).portrait || playerImg(actor),
      callback: (path) => update(actor, { portrait: path }),
    }).render(true);
  }

  static async #onAddNote(event, target) {
    const input = this.element.querySelector(`input[name=npaNote][data-id="${target.dataset.id}"]`);
    if (input) await this.#submitNote(input);
  }

  static async #onDeleteNote(event, target) {
    const actor = game.actors.get(target.dataset.id);
    if (actor) await deleteNote(actor, target.dataset.at, target.dataset.by);
  }

  static open() {
    const existing = [...openApps][0];
    if (existing) return existing.render({ force: true });
    return new PeopleApp().render({ force: true });
  }
}

/* ------------------------------------------------------------------ */
/* Registration                                                       */
/* ------------------------------------------------------------------ */

Hooks.once("init", () => {
  game.settings.register(MOD, "announce", {
    name: "Announce to",
    hint: "Who the Announce button on a card posts to. Nothing is posted unless the GM presses it.",
    scope: "world", config: true, type: String, default: "all",
    choices: { all: "Everyone", gm: "Whisper to the GM", off: "Nobody (button disabled)" },
  });
  game.settings.register(MOD, "castFlagScopes", {
    name: "Cast flag scopes",
    hint: "Comma-separated module ids. An actor with flags.<id>.cast set counts as Cast for the Cast filter. Empty: the Cast chip shows no one.",
    scope: "world", config: true, type: String, default: "",
  });
});

Hooks.once("ready", () => {
  game.socket.on(`module.${MOD}`, onSocket);
  game.modules.get(MOD).api = {
    open: () => PeopleApp.open(),
    markMet, setAttitude, setTowards, setKnownAs, reveal, announce, addNote, knownName,
    record: (actor) => (game.user.isGM ? record(actor) : publicRecord(actor)),
  };
});

Hooks.on("updateActor", (actor, changes) => {
  if (changes.flags?.[MOD] || changes.prototypeToken !== undefined || changes.img !== undefined || changes.name !== undefined) refresh();
});
Hooks.on("createActor", refresh);
Hooks.on("deleteActor", refresh);

Hooks.on("getSceneControlButtons", (controls) => {
  const tools = controls.tokens?.tools;
  if (!tools) return;
  tools.npcAttitudes = {
    name: "npcAttitudes",
    title: "People",
    icon: "fa-solid fa-address-book",
    order: Object.keys(tools).length,
    button: true,
    visible: true,
    onChange: () => PeopleApp.open(),
  };
});

/** Right-click an NPC in the Actors sidebar to mark them as met. */
Hooks.on("getActorContextOptions", (app, options) => {
  const get = (li) => game.actors.get(li?.dataset?.entryId);
  options.push({
    name: "People: met / not met",
    icon: '<i class="fa-solid fa-address-book"></i>',
    condition: (li) => game.user.isGM && isNPC(get(li)),
    callback: (li) => {
      const a = get(li);
      if (a) markMet(a, !record(a).met);
    },
  });
});
