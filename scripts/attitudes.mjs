/**
 * PF2e NPC Attitudes: how the people the party has met feel about them.
 *
 * Each NPC actor carries a flag (see record) with whether the party has met them, their attitude (GM Core's Hostile
 * to Helpful), what the players are shown when that differs, attitudes toward particular characters, a public
 * one-line description, the name and portrait the party knows them by, and the party's shared notes. Players can only
 * add and remove their own notes; those go through the GM's client.
 *
 * Players see the name from knownName and the portrait from playerImg; the actor's own name is shown to the GM only.
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

/** Party notes as a list of entries. A legacy record's single string becomes the first entry. */
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
    group: typeof f.group === "string" ? f.group : "",
    archived: !!f.archived,
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
    group: r.group,
    archived: r.archived,
  };
}

/* ------------------------------------------------------------------ */
/* Groups and the archive                                             */
/* ------------------------------------------------------------------ */

const GROUP_MAX = 60;
/** The GM's groups, in order: the setting's list, then any name an NPC carries that the list lacks. */
function groupNames() {
  const listed = (game.settings.get(MOD, "groups") ?? []).filter((g) => typeof g === "string" && g);
  const used = game.actors.filter(isNPC).map((a) => record(a).group).filter(Boolean);
  return [...new Set([...listed, ...used])];
}
const cleanGroup = (name) => String(name ?? "").replace(/\s+/g, " ").trim().slice(0, GROUP_MAX);

/** Put an NPC in a group (an empty name takes it out); a new name joins the list of groups. */
async function setGroup(actor, name) {
  if (!game.user.isGM || !isNPC(actor)) return;
  const group = cleanGroup(name);
  if (group && !(game.settings.get(MOD, "groups") ?? []).includes(group)) await game.settings.set(MOD, "groups", [...(game.settings.get(MOD, "groups") ?? []), group]);
  await update(actor, { group });
}

/** Archive an NPC (out of the story for now, still on record) or bring them back. */
async function setArchived(actor, archived = true) {
  if (!game.user.isGM || !isNPC(actor)) return;
  await update(actor, { archived: !!archived });
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

/** The name the party knows: the record's "known as", else the prototype token name, else the actor name. */
function knownName(actor) {
  return record(actor).knownAs || actor.prototypeToken?.name?.trim() || actor.name;
}

/**
 * Shipped art (the system's, a Paizo module's, Foundry's icons) can name the real creature, so players don't see it.
 */
const SHIPPED_ART = /^(?:systems\/pf2e\/|modules\/(?:pf2e-tokens-|pathfinder-tokens|pf2e-bestiary-|pf2e-monster-core|pf2e-npc-core)|icons\/)/i;
/**
 * The art players see: the record's portrait, else the actor image unless it is shipped art, else the prototype token
 * image (which the GM chose), else the actor image. Full art, cropped to the card; a click opens it whole.
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
    if (!by) return; // entries without an author are the GM's to remove
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
    return { cast: !!c.cast, metOnly: c.metOnly !== false, sort: c.sort === "recent" ? "recent" : "name", view: typeof c.view === "string" ? c.view : "all" };
  } catch {
    return { cast: false, metOnly: true, sort: "name", view: "all" };
  }
}

function saveChips(state) {
  try {
    localStorage.setItem(CHIPS_KEY, JSON.stringify({ cast: state.cast, metOnly: state.metOnly, sort: state.sort, view: state.view }));
  } catch {}
}

/* ------------------------------------------------------------------ */
/* Window memory                                                      */
/* ------------------------------------------------------------------ */

/*
 * Window memory, shared verbatim with the author's other modules (keep the copies in sync). A window made with
 * rememberWindow keeps the size and place the user gives it, in this browser, and restores from minimized at full
 * size: Foundry's restore animation can stall at the title bar's height (seen on Foundry 14.370, core windows too)
 * and Foundry sets the size while it runs, which would leave the window a strip.
 */

/** Wait for an element's own transitions to end; a hidden tab pauses them, so after a second they're finished by hand. */
async function settleWindow(el) {
  const anims = el?.getAnimations?.() ?? [];
  if (!anims.length) return;
  await Promise.race([Promise.all(anims.map((a) => a.finished.catch(() => null))), new Promise((r) => setTimeout(r, 1200))]);
  for (const a of el.getAnimations?.() ?? []) {
    try {
      a.finish();
    } catch {
      /* an animation that can't finish (infinite) is left alone */
    }
  }
}

/**
 * Give an ApplicationV2 class window memory.
 * @param {typeof ApplicationV2} Base
 * @param {string} key          localStorage key for this window
 * @param {object} [opts]
 * @param {boolean|"width"} [opts.size] what to keep besides the place: true for width and height, "width" for a window
 *   whose height fits its content, false for a window sized wholly by its content
 */
function rememberWindow(Base, key, { size = true } = {}) {
  const MIN_W = 240, MIN_H = 120;
  const load = () => {
    let v;
    try {
      v = JSON.parse(globalThis.localStorage?.getItem(key) ?? "null");
    } catch {
      return {};
    }
    if (!v || typeof v !== "object") return {};
    const W = globalThis.innerWidth ?? 1920, H = globalThis.innerHeight ?? 1080;
    const out = {};
    // A size saved while the window was collapsed is no size at all.
    if (size === true && v.width >= MIN_W && v.height >= MIN_H) {
      out.width = Math.min(v.width, W);
      out.height = Math.min(v.height, H);
    } else if (size === "width" && v.width >= MIN_W) out.width = Math.min(v.width, W);
    const w = out.width ?? MIN_W, h = out.height ?? MIN_H;
    if (Number.isFinite(v.left)) out.left = Math.max(0, Math.min(v.left, W - w));
    if (Number.isFinite(v.top)) out.top = Math.max(0, Math.min(v.top, H - h));
    return out;
  };
  let timer = null;
  const save = (position) => {
    // Copy now: Foundry hands over its own live position object, which may change before the save runs.
    const pos = { left: position.left, top: position.top, width: position.width, height: position.height };
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const v = { left: pos.left, top: pos.top };
        if (size) v.width = pos.width;
        if (size === true) v.height = pos.height;
        globalThis.localStorage?.setItem(key, JSON.stringify(v));
      } catch {
        /* no storage: the window opens where Foundry puts it */
      }
    }, 300);
  };

  return class extends Base {
    #beforeMin = null;
    #restoring = false;
    #restore = null;

    constructor(options = {}) {
      super(foundry.utils.mergeObject({ position: load() }, options, { inplace: false }));
    }

    /** Restore a minimized window before drawing it: a draw that ends while it's collapsed takes the title bar's size. */
    async render(options = {}, _options = {}) {
      if ((this.minimized || this.#restore) && (options === true || options?.force)) {
        const open = this.rendered;
        await this.maximize();
        // Closed while it was being restored: don't open it again.
        if (open && !this.rendered) return this;
      }
      return super.render(options, _options);
    }

    async minimize() {
      if (!this.minimized && this.rendered) {
        const auto = this.options.position ?? {};
        this.#beforeMin = {
          width: auto.width === "auto" ? "auto" : this.position.width,
          height: auto.height === "auto" ? "auto" : this.position.height,
        };
      }
      return super.minimize();
    }

    maximize() {
      // A restore already under way is the one to wait for.
      if (this.#restore) return this.#restore;
      if (!this.minimized) return super.maximize();
      this.#restore = this.#restoreWhole().finally(() => (this.#restore = null));
      return this.#restore;
    }

    async #restoreWhole() {
      const was = this.#beforeMin;
      this.#restoring = true;
      try {
        const pending = super.maximize();
        for (const a of this.element?.getAnimations?.() ?? []) {
          try {
            a.finish();
          } catch {
            /* nothing to finish */
          }
        }
        await pending;
        await settleWindow(this.element);
        // Not if it was closed or minimized again meanwhile.
        if (was && this.rendered && !this.minimized) this.setPosition(was);
      } finally {
        this.#restoring = false;
      }
    }

    /** Remember the size and place the user gives the window (not while it's minimized or being restored). */
    _onPosition(position) {
      super._onPosition?.(position);
      if (!this.rendered || this.minimized || this.#restoring) return;
      if (![position.left, position.top].every(Number.isFinite)) return;
      if (size && !(position.width >= MIN_W)) return;
      if (size === true && !(position.height >= MIN_H)) return;
      save(position);
    }
  };
}

class PeopleApp extends rememberWindow(foundry.applications.api.ApplicationV2, `${MOD}.size`) {
  static DEFAULT_OPTIONS = {
    id: "pf2e-npc-attitudes",
    classes: ["npa-app"],
    tag: "div",
    window: { title: "People", icon: "fa-solid fa-address-book", resizable: true },
    position: { width: 880, height: 680 },
    actions: {
      npaFilter: PeopleApp.#onFilter,
      npaView: PeopleApp.#onViewGroup,
      npaSort: PeopleApp.#onSort,
      npaArchive: PeopleApp.#onArchive,
      npaChip: PeopleApp.#onChip,
      npaMarkSelected: PeopleApp.#onMarkSelected,
      npaMet: PeopleApp.#onMet,
      npaOpen: PeopleApp.#onOpen,
      npaPicture: PeopleApp.#onView,
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

  /** Everyone this user may list before the sidebar, attitude and search narrow it: players see only who they've met. */
  base() {
    return game.actors.filter(isNPC).map((actor) => ({ actor, r: record(actor) }))
      .filter(({ r }) => r.met || (this.isGM && !this.state.metOnly))
      .filter(({ actor }) => !this.isGM || !this.state.cast || isCast(actor));
  }

  /** Does a person belong in the sidebar's chosen view? A search looks in every view, the archive included. */
  inView(r) {
    const v = this.state.view;
    if (this.state.search.trim()) return true;
    if (v === "archived") return r.archived;
    if (r.archived) return false;
    if (v === "none") return !r.group;
    if (v.startsWith("group:")) return r.group === v.slice(6);
    return true;
  }

  people() {
    const byName = (x, y) => knownName(x.actor).localeCompare(knownName(y.actor));
    const recent = (x, y) => (y.r.metAt ?? -Infinity) - (x.r.metAt ?? -Infinity) || byName(x, y);
    return this.base()
      .filter(({ r }) => this.inView(r))
      .filter(({ actor, r }) => {
        const a = this.isGM ? attitude(r.attitude) ?? UNKNOWN : shownAttitude(r);
        if (this.state.filter !== "all" && a.id !== this.state.filter) return false;
        const q = this.state.search.trim().toLowerCase();
        if (!q) return true;
        const hay = `${knownName(actor)} ${this.isGM ? actor.name : ""} ${r.blurb}`.toLowerCase();
        return hay.includes(q);
      })
      .sort((x, y) => Number(y.r.met) - Number(x.r.met) || (this.state.sort === "recent" ? recent(x, y) : byName(x, y)));
  }

  /** The sidebar: Everyone, each group, No group, Archived, with counts. Players see only groups with someone they've met. */
  sidebar() {
    const all = this.base();
    const active = all.filter(({ r }) => !r.archived);
    const count = (fn) => active.filter(({ r }) => fn(r)).length;
    const names = this.isGM ? groupNames() : [...new Set(all.map(({ r }) => r.group).filter(Boolean))].filter((g) => count((r) => r.group === g));
    const row = (view, label, n, icon = "") => `<a data-action="npaView" data-view="${esc(view)}" class="${this.state.view === view ? "active" : ""}">${icon ? `<i class="fa-solid ${icon}"></i> ` : ""}<span>${esc(label)}</span><em>${n}</em></a>`;
    const none = count((r) => !r.group);
    const archived = all.filter(({ r }) => r.archived).length;
    return `<nav class="npa-side">
        ${row("all", "Everyone", active.length)}
        ${names.map((g) => row(`group:${g}`, g, count((r) => r.group === g))).join("")}
        ${none && names.length ? row("none", "No group", none) : ""}
        ${archived || this.isGM ? `<hr>${row("archived", "Archived", archived, "fa-box-archive")}` : ""}
      </nav>`;
  }

  async _renderHTML() {
    const v = this.state.view;
    // A group view that's gone (renamed, emptied, or one a player no longer sees) falls back to Everyone.
    const g = v.startsWith("group:") ? v.slice(6) : null;
    if (g !== null && !(this.isGM ? groupNames().includes(g) : this.base().some(({ r }) => r.group === g && !r.archived))) this.state.view = "all";
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
    const anyone = this.base().length > 0;
    const empty = !anyone ? (this.isGM && this.state.metOnly ? "Nobody marked as met yet. Turn off 'Met only' to start, or select tokens and mark them." : "The party hasn't met anyone yet.") : "No one here.";
    const cards = people.length ? people.map((p) => this.#card(p)).join("") : `<p class="npa-empty">${empty}</p>`;
    const sort = `<a data-action="npaSort" data-tooltip="${this.state.sort === "recent" ? "Sorted by who was met most recently. Click for A to Z." : "Sorted A to Z. Click for most recently met first."}"><i class="fa-solid ${this.state.sort === "recent" ? "fa-clock-rotate-left" : "fa-arrow-down-a-z"}"></i></a>`;
    el.innerHTML = `<header class="npa-head">
        <input type="search" name="npaSearch" placeholder="Search names" value="${esc(this.state.search)}">${sort}
        <nav class="npa-filters">${filters}</nav>
        ${gm}
      </header>
      <div class="npa-main-row">${this.sidebar()}<section class="npa-body"><div class="npa-cards">${cards}</div></section>${this.isGM ? `<datalist id="npa-group-list">${groupNames().map((g) => `<option value="${esc(g)}">`).join("")}</datalist>` : ""}</div>`;
    return el;
  }

  #card({ actor, r }) {
    const shown = shownAttitude(r);
    const name = esc(knownName(actor));
    const img = esc(playerImg(actor, r));
    const notes = this.#notes(actor, r);
    // Where a card sits, when the view doesn't say it already: its group, and Archived.
    const v = this.state.view;
    const where = [
      r.group && (v !== `group:${r.group}` || this.state.search.trim()) ? `<span class="npa-where"><i class="fa-solid fa-folder"></i> ${esc(r.group)}</span>` : "",
      r.archived && (v !== "archived" || this.state.search.trim()) ? `<span class="npa-where"><i class="fa-solid fa-box-archive"></i> Archived</span>` : "",
    ].join("");
    if (!this.isGM) {
      return `<article class="npa-card att-${shown.id} ${r.archived ? "npa-archived" : ""}">
          <img src="${img}" alt="${name}" data-action="npaPicture" data-id="${actor.id}" data-tooltip="See the full picture">
          <div class="npa-main">
            <h3>${name}</h3>${where ? `<div class="npa-wheres">${where}</div>` : ""}
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
    return `<article class="npa-card att-${truth.id} ${r.met ? "" : "npa-unmet"} ${r.archived ? "npa-archived" : ""}">
        <img src="${img}" alt="${name}" data-action="npaOpen" data-id="${actor.id}" data-tooltip="Open sheet">
        <div class="npa-main">
          <h3>${name} ${realName}</h3>${where ? `<div class="npa-wheres">${where}</div>` : ""}
          <div class="npa-row">
            <label>Attitude <select data-field="attitude" data-id="${actor.id}">${opts(r.attitude ?? "", [{ id: "", label: "Not set" }])}</select></label>
            <label data-tooltip="What the players see. Use this when someone hides how they feel.">Players see <select data-field="shown" data-id="${actor.id}">${opts(r.shown, [{ id: "same", label: "The same" }, UNKNOWN])}</select></label>
            <label class="npa-met"><input type="checkbox" data-action="npaMet" data-id="${actor.id}" ${r.met ? "checked" : ""}> Met</label>
            <button type="button" data-action="npaAnnounce" data-id="${actor.id}" data-tooltip="Post what the players see of this NPC to chat"><i class="fa-solid fa-bullhorn"></i> Announce</button>
            <button type="button" data-action="npaArchive" data-id="${actor.id}" data-tooltip="${r.archived ? "Bring them back into the lists" : "Out of the story for now: move to Archived, attitude and notes kept"}"><i class="fa-solid ${r.archived ? "fa-box-open" : "fa-box-archive"}"></i> ${r.archived ? "Bring back" : "Archive"}</button>
          </div>
          ${r.shown !== "same" && r.met ? `<div class="npa-att npa-shown">Players see: <i class="fa-regular ${shown.icon}"></i> ${shown.label}${Object.keys(r.pcs).length ? ", and none of the per-character attitudes" : ""}</div>` : ""}
          ${this.#perCharacter(actor, r)}
          <div class="npa-row npa-ident">
            <label class="npa-group" data-tooltip="Players see the group">Group <input type="text" list="npa-group-list" data-field="group" data-id="${actor.id}" value="${esc(r.group)}" maxlength="${GROUP_MAX}" placeholder="None"></label>
          </div>
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
    if (field === "group") return setGroup(actor, target.value);
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

  static #onViewGroup(event, target) {
    this.state.view = target.dataset.view;
    if (this.state.search) this.state.search = "";
    saveChips(this.state);
    this.render();
  }

  static #onSort() {
    this.state.sort = this.state.sort === "recent" ? "name" : "recent";
    saveChips(this.state);
    this.render();
  }

  static async #onArchive(event, target) {
    const actor = game.actors.get(target.dataset.id);
    if (actor) await setArchived(actor, !record(actor).archived);
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
  /** A player card's picture, whole in Foundry's image viewer, under the known name. */
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
  game.settings.register(MOD, "groups", {
    scope: "world", config: false, type: Array, default: [], onChange: () => refresh(),
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
    markMet, setAttitude, setTowards, setKnownAs, reveal, announce, addNote, knownName, setGroup, setArchived,
    groups: () => (game.user.isGM ? groupNames() : [...new Set(game.actors.filter(isNPC).map((a) => record(a)).filter((r) => r.met && r.group).map((r) => r.group))]),
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

/** Right-click an NPC in the Actors sidebar to mark them as met or not met. */
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
