/**
 * PF2e NPC Attitudes: how the people the party has met feel about them.
 *
 * Each NPC actor carries a flag (see record) with whether the party has met them, their attitude (the system's
 * Hostile to Helpful), what the players are shown when that differs, attitudes toward particular characters, a
 * public one-line description, the name and portrait the party knows them by, the party's shared notes, a history of
 * attitude changes, and attitudes that hold only for the current scene. Players can only add and remove their own
 * notes; those go through the active GM's lead tab.
 *
 * Groups the GM names can carry an attitude of their own, or follow a Campaign Trackers reputation, for members whose
 * own attitude isn't set. Make an Impression is rolled through the system's own action; the GM applies the result.
 *
 * Players see the name from knownName and the portrait from playerImg; the actor's own name is shown to the GM only.
 * The attitude names come from the PF2e system's own list.
 */

import { esc, safe, tipAttr, labelAttr } from "./kit/safe-text.mjs";
import { gmTabs } from "./kit/gm-tabs.mjs";
import { singleWindow } from "./kit/single-window.mjs";
import { storage } from "./kit/storage.mjs";
import { rememberWindow } from "./kit/window-memory.mjs";
import { keyboardWindow } from "./kit/keyboard.mjs";
import { pf2eRules } from "./kit/pf2e-rules.mjs";

const MOD = "pf2e-npc-attitudes";
const FLAG = "npc";
const TRACKERS = "pf2e-campaign-trackers";
/** Party notes per NPC: at most this many entries, this many characters in all, this many in one note. */
const NOTE_MAX = 40;
const NOTE_CHARS = 4000;
const NOTE_LEN = 500;
/** A player may add one note every this many ms. Their own client waits a little longer, since notes can arrive closer together than they were sent. */
const NOTE_GAP = 2000;
const NOTE_SEND_GAP = 2500;
/** Attitude changes kept per NPC (the oldest go first), and the longest reason. */
const HISTORY_MAX = 50;
const WHY_LEN = 200;
/** Make an Impression results applied to an NPC that it remembers, so none is applied twice. */
const IMPRESSIONS_MAX = 50;
/** The most unmet NPCs listed as rows at once; a search narrows them. */
const UNMET_MAX = 400;
/** The image shown when the only art an NPC has is art shipped with the system or a module (a setting). */
const SILHOUETTE = "icons/svg/mystery-man.svg";
/** Where the chips were kept before they were per world and user. */
const OLD_CHIPS_KEY = `${MOD}.chips`;
const tabs = gmTabs(MOD);
const store = storage(MOD);
const rules = pf2eRules({ module: MOD, title: "PF2e NPC Attitudes", tables: ["attitudes"] });

/** Text from this module's language file: L("Key") or L("Key", { name }) (values aren't escaped: escape what goes into HTML). */
function L(key, data) {
  const k = `NPA.${key}`;
  return data ? game.i18n.format(k, data) : game.i18n.localize(k);
}

/* ------------------------------------------------------------------ */
/* Attitudes                                                          */
/* ------------------------------------------------------------------ */

/** The module's five steps, worst to best, with their icons. Their names come from the system (see attitudeLabel). */
const ORDER = ["hostile", "unfriendly", "indifferent", "friendly", "helpful"];
const ICONS = { hostile: "fa-face-angry", unfriendly: "fa-face-frown", indifferent: "fa-face-meh", friendly: "fa-face-smile", helpful: "fa-face-smile-beam" };

/** An attitude's name in the system's own list (CONFIG.PF2E.attitude), in the system's language. */
function attitudeLabel(id) {
  const r = rules.get("attitudes");
  const hit = r.ok ? r.value.find((a) => a.key === id) : null;
  return hit?.label ?? id;
}

const makeAttitude = (id) => ({ id, icon: ICONS[id], get label() { return attitudeLabel(id); } });
const ATTITUDES = ORDER.map(makeAttitude);
const UNKNOWN = { id: "unknown", icon: "fa-circle-question", get label() { return L("Unknown"); } };
const attitude = (id) => ATTITUDES.find((a) => a.id === id) ?? null;
/** An attitude moved by steps, stopping at Hostile and Helpful. */
function stepAttitude(id, by) {
  const i = ORDER.indexOf(id);
  return ORDER[Math.max(0, Math.min(ORDER.length - 1, (i < 0 ? ORDER.indexOf("indifferent") : i) + by))];
}

/* ------------------------------------------------------------------ */
/* Data                                                               */
/* ------------------------------------------------------------------ */

const FP = () => foundry.applications.apps.FilePicker.implementation;

/** A note's id: made by the client that writes it, so a note sent twice is saved once. */
const noteId = () => Math.random().toString(36).slice(2, 12).padEnd(10, "0");
const validNoteId = (id) => typeof id === "string" && /^[a-z0-9]{1,16}$/i.test(id);

/** Party notes as a list of entries. Notes from before ids have none. */
function noteEntries(notes) {
  if (!Array.isArray(notes)) return [];
  return notes.filter((e) => e && typeof e.text === "string").map((e) => ({ ...(validNoteId(e.id) ? { id: e.id } : {}), by: e.by ?? null, at: e.at ?? null, text: e.text }));
}

/** Why a note can't be added to this list ("long", "count", "chars"), or "" when it can. Old notes are never dropped. */
function noteRefusal(list, text) {
  if (text.length > NOTE_LEN) return "long";
  if (list.length >= NOTE_MAX) return "count";
  if (list.reduce((n, e) => n + e.text.length, 0) + text.length > NOTE_CHARS) return "chars";
  return "";
}

const REFUSALS = new Set(["long", "count", "chars", "fast"]);
/** The words for a refusal, or null for an unknown reason. */
function refusalText(reason) {
  if (!REFUSALS.has(reason)) return null;
  return L(`Notes.Refused.${reason}`, { len: NOTE_LEN, max: NOTE_MAX, chars: NOTE_CHARS });
}

/** The list with one entry added at the end. */
function appendNote(list, entry) {
  return [...list, { ...(validNoteId(entry.id) ? { id: entry.id } : {}), by: entry.by ?? null, at: entry.at ?? null, text: String(entry.text ?? "") }];
}

/** Whether entry e is the note named by key: same author, and the same id, or for a note without one the same time. */
const sameNote = (e, { id = null, at = null, by = null } = {}) =>
  String(e.by ?? "") === String(by ?? "") && (e.id ? e.id === id : !id && String(e.at ?? "") === String(at ?? ""));

/** Attitude changes, oldest first: { at (real time), wt (world time), from, to, pc (a character, or null for everyone), why, by }. */
function historyEntries(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((e) => e && (attitude(e.to) || e.to === null)).map((e) => ({
    at: Number.isFinite(e.at) ? e.at : null, wt: Number.isFinite(e.wt) ? e.wt : null, from: attitude(e.from) ? e.from : null, to: e.to ?? null,
    pc: typeof e.pc === "string" ? e.pc : null, why: typeof e.why === "string" ? e.why.slice(0, WHY_LEN) : "", by: typeof e.by === "string" ? e.by : null,
  }));
}

/** Attitudes for the current scene only: { attitude, pcs: { pcId: attitude } }, kept apart from the stored ones. */
function sceneEntries(s) {
  if (!s || typeof s !== "object") return { attitude: null, pcs: {} };
  const pcs = Object.fromEntries(Object.entries(s.pcs ?? {}).filter(([, v]) => attitude(v)));
  return { attitude: attitude(s.attitude) ? s.attitude : null, pcs };
}

/** The NPC record on an actor, with defaults filled in. */
function record(actor) {
  const f = actor?.flags?.[MOD]?.[FLAG] ?? {};
  return {
    met: !!f.met,
    metAt: f.metAt ?? null,
    metOn: f.metOn ?? null,
    attitude: attitude(f.attitude) ? f.attitude : null,
    shown: f.shown === "unknown" || attitude(f.shown) ? f.shown : "same",
    blurb: typeof f.blurb === "string" ? f.blurb : "",
    knownAs: typeof f.knownAs === "string" ? f.knownAs : "",
    portrait: typeof f.portrait === "string" ? f.portrait : "",
    notes: noteEntries(f.notes),
    pcs: Object.fromEntries(Object.entries(f.pcs ?? {}).filter(([, v]) => attitude(v))),
    group: typeof f.group === "string" ? f.group.replace(/\s+/g, " ").trim() : "",
    archived: !!f.archived,
    history: historyEntries(f.history),
    scene: sceneEntries(f.scene),
    impressions: Array.isArray(f.impressions) ? f.impressions.filter((k) => typeof k === "string").slice(-IMPRESSIONS_MAX) : [],
  };
}

/**
 * The attitude toward the party as it stands: this scene's, else the NPC's own, else its group's (see groupAttitude),
 * else none. `from` says which.
 */
function generalAttitude(r) {
  if (r.scene.attitude) return { id: r.scene.attitude, from: "scene" };
  if (r.attitude) return { id: r.attitude, from: "own" };
  const g = r.group ? groupAttitude(r.group) : null;
  if (g) return { id: g.id, from: "group" };
  return { id: null, from: null };
}

/** The attitude toward one character: this scene's, else the stored one, else the general one. */
function towardAttitude(r, pcId) {
  return r.scene.pcs[pcId] ?? r.pcs[pcId] ?? generalAttitude(r).id;
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
/** A typed group name as the group it means: an existing group spelled with other capitals is that group. */
function canonicalGroup(name, names = groupNames()) {
  const group = cleanGroup(name);
  return names.find((g) => g.toLowerCase() === group.toLowerCase()) ?? group;
}

/** Put an NPC in a group (an empty name takes it out). A new name shows as a group while someone is in it. */
async function setGroup(actor, name) {
  if (!game.user.isGM || !isNPC(actor)) return;
  const group = canonicalGroup(name);
  if (record(actor).group === group) return;
  await update(actor, { group });
}

/** The NPC actors in a group, archived or not. */
const groupMembers = (name) => game.actors.filter((a) => isNPC(a) && record(a).group === name);

/** Change several NPCs' records in one go: one update each, sent together. */
async function updateMany(actors, changes) {
  const updates = actors.map((a) => ({ _id: a.id, ...Object.fromEntries(Object.entries(typeof changes === "function" ? changes(a) : changes).map(([k, v]) => [`flags.${MOD}.${FLAG}.${k}`, v])) }));
  if (updates.length) await Actor.implementation.updateDocuments(updates);
}

/** Add an empty group to the list. Returns the cleaned name, or "" when there was none. */
async function addGroup(name) {
  const group = canonicalGroup(name);
  if (!game.user.isGM || !group) return "";
  const list = game.settings.get(MOD, "groups") ?? [];
  if (!list.includes(group)) await game.settings.set(MOD, "groups", [...list, group]);
  return group;
}

/** Rename a group, in the list (keeping its place), in its attitude settings and on every NPC in it. A name already in use merges the two. */
async function renameGroup(from, to) {
  from = cleanGroup(from);
  const group = cleanGroup(to).toLowerCase() === from.toLowerCase() ? cleanGroup(to) : canonicalGroup(to);
  if (!game.user.isGM || !group || group === from) return "";
  const list = groupNames();
  await updateMany(groupMembers(from), { group });
  const info = groupInfoAll();
  // Merging into a group with settings of its own keeps those; otherwise the renamed group's carry over.
  if (info[from] && !info[group]) info[group] = info[from];
  delete info[from];
  await game.settings.set(MOD, "groupInfo", info);
  await game.settings.set(MOD, "groups", [...new Set(list.map((g) => (g === from ? group : g)))]);
  return group;
}

/** Take a group off the list; its NPCs keep their records but no longer have a group. */
async function removeGroup(name) {
  if (!game.user.isGM) return;
  await updateMany(groupMembers(name), { group: "" });
  const info = groupInfoAll();
  if (info[name]) {
    delete info[name];
    await game.settings.set(MOD, "groupInfo", info);
  }
  await game.settings.set(MOD, "groups", groupNames().filter((g) => g !== name));
}

/** Move a group just before (or after) another in the list. */
async function moveGroup(name, target, after = false) {
  if (!game.user.isGM || name === target) return;
  const list = groupNames().filter((g) => g !== name);
  const at = list.indexOf(target);
  if (at < 0) return;
  list.splice(after ? at + 1 : at, 0, name);
  await game.settings.set(MOD, "groups", list);
}

/** Move a group one place up (-1) or down (1) in the list: the keyboard's way to do what dragging does. */
async function shiftGroup(name, by) {
  const list = groupNames();
  const at = list.indexOf(name);
  const to = at + by;
  if (!game.user.isGM || at < 0 || to < 0 || to >= list.length) return;
  return moveGroup(name, list[to], by > 0);
}

/** Put the groups in A to Z order (they can be dragged into another order after). */
async function sortGroups() {
  if (!game.user.isGM) return;
  await game.settings.set(MOD, "groups", [...groupNames()].sort((a, b) => a.localeCompare(b)));
}

/** Archive or bring back everyone in a group. */
async function archiveGroup(name, archived = true) {
  if (!game.user.isGM) return;
  await updateMany(groupMembers(name).filter((a) => record(a).archived !== archived), { archived });
}

/** Archive an NPC (out of the story for now, still on record) or bring them back. */
async function setArchived(actor, archived = true) {
  if (!game.user.isGM || !isNPC(actor)) return;
  await update(actor, { archived: !!archived });
}

/* ------------------------------------------------------------------ */
/* A group's own attitude, and Campaign Trackers reputations          */
/* ------------------------------------------------------------------ */

/** Every group's settings: { name: { attitude, tracker, tiers: { tierId: attitude } } }. */
function groupInfoAll() {
  const raw = game.settings.get(MOD, "groupInfo");
  return raw && typeof raw === "object" && !Array.isArray(raw) ? foundry.utils.deepClone(raw) : {};
}

/** One group's settings, cleaned. `resolved` is the reputation's attitude as the GM's client last worked it out (players read it). */
function groupInfo(name) {
  const g = groupInfoAll()[name] ?? {};
  const tiers = g.tiers && typeof g.tiers === "object" ? Object.fromEntries(Object.entries(g.tiers).filter(([, v]) => attitude(v))) : {};
  const res = g.resolved && typeof g.resolved === "object" && attitude(g.resolved.id) ? { id: g.resolved.id } : null;
  return { attitude: attitude(g.attitude) ? g.attitude : null, tracker: typeof g.tracker === "string" ? g.tracker : "", tiers, resolved: res };
}

/** Save one group's settings (null clears them). The resolved attitude is worked out again after. */
async function setGroupInfo(name, info) {
  if (!game.user.isGM || !name) return;
  const all = groupInfoAll();
  if (info) {
    const next = { attitude: attitude(info.attitude) ? info.attitude : null, tracker: info.tracker || "", tiers: info.tiers ?? {} };
    // What players see from the reputation, worked out here (any GM client can read Campaign Trackers).
    const res = resolvedFor(next, all[name]?.resolved);
    all[name] = res ? { ...next, resolved: res } : next;
  } else delete all[name];
  await game.settings.set(MOD, "groupInfo", all);
  clearGroupCache();
}

/** Campaign Trackers' API when the module is on, else null. */
function trackersApi() {
  const m = game.modules.get(TRACKERS);
  return m?.active && m.api ? m.api : null;
}

/** The reputation trackers Campaign Trackers holds, as { id, name, value, tiers: [{ id, label, min }] } (tiers lowest first). */
function reputations() {
  const api = trackersApi();
  let list = [];
  try {
    list = (api?.list?.() ?? []).filter((t) => t?.kind === "reputation");
  } catch {
    list = [];
  }
  return list.map((t) => ({
    id: t.id, name: String(t.name ?? t.id), value: Number(t.value) || 0,
    tiers: [...(t.tiers ?? [])].filter((x) => x && typeof x.id === "string").map((x) => ({ id: x.id, label: String(x.label ?? x.id), min: Number(x.min) || 0 })).sort((a, b) => a.min - b.min),
  }));
}

/** A reputation's current tier: the highest whose start the value has reached, else the lowest. */
function currentTier(rep) {
  let tier = rep.tiers[0] ?? null;
  for (const x of rep.tiers) if (rep.value >= x.min) tier = x;
  return tier;
}

/**
 * A first guess at the attitude for each tier, by its place from lowest to highest: the lowest Hostile, the highest
 * Helpful, the rest spread between. The GM changes them; no rule ties a tier to an attitude.
 */
function tierGuess(tiers) {
  const n = tiers.length;
  return Object.fromEntries(tiers.map((t, i) => [t.id, ORDER[n === 1 ? 2 : Math.round((i * (ORDER.length - 1)) / (n - 1))]]));
}

/** The attitude a reputation gives a group now, read from Campaign Trackers (which only a GM's client can read). */
function trackerAttitude(info) {
  if (!info.tracker) return null;
  const rep = reputations().find((t) => t.id === info.tracker);
  const tier = rep ? currentTier(rep) : null;
  if (!tier) return null;
  const id = info.tiers[tier.id] ?? tierGuess(rep.tiers)[tier.id];
  return attitude(id) ? { id, tracker: rep.name, tier: tier.label } : null;
}

/** Has Campaign Trackers said it's ready? Until then an empty list of trackers may only mean it's still loading. */
let trackersReady = false;

/**
 * The attitude players should see from a group's reputation: { id }, or null for none. `before` is kept while
 * Campaign Trackers is still loading.
 */
function resolvedFor(info, before = null) {
  if (!info.tracker || !trackersApi()) return null;
  const t = trackerAttitude({ ...info, tiers: info.tiers ?? {} });
  if (t) return { id: t.id };
  return !trackersReady && !reputations().length && before?.id ? { id: before.id } : null;
}

let groupCache = null;
/**
 * A group's attitude for members whose own isn't set: from the reputation it follows (when Campaign Trackers is on and
 * the tracker is there), else its own. { id, from: "tracker" | "group", tracker?, tier? }, or null. Campaign Trackers
 * keeps its trackers in the GM's client only, so a player's client takes the reputation's attitude the GM's client
 * published (see publishGroupAttitudes).
 */
function groupAttitude(name) {
  groupCache ??= new Map();
  if (groupCache.has(name)) return groupCache.get(name);
  const info = groupInfo(name);
  let out = null;
  if (info.tracker) {
    const t = game.user.isGM ? trackerAttitude(info) : game.modules.get(TRACKERS)?.active ? info.resolved : null;
    if (t) out = { id: t.id, from: "tracker", tracker: t.tracker ?? "", tier: t.tier ?? "" };
  }
  if (!out && info.attitude) out = { id: info.attitude, from: "group" };
  groupCache.set(name, out);
  return out;
}
const clearGroupCache = () => (groupCache = null);

/**
 * In the active GM's lead tab: work out each reputation-following group's attitude and store it in the group settings
 * where players' clients read it. Writes only when something changed.
 */
async function publishGroupAttitudes() {
  if (!game.user.isGM || !(await tabs.leadNow())) return;
  const all = groupInfoAll();
  let changed = false;
  for (const name of Object.keys(all)) {
    const info = groupInfo(name);
    // Trackers off: nothing to publish (players fall back to the group's own attitude, as the GM does).
    const now = resolvedFor(info, info.resolved);
    if (JSON.stringify(now) === JSON.stringify(info.resolved)) continue;
    if (now) all[name].resolved = now;
    else delete all[name].resolved;
    changed = true;
  }
  if (changed) await game.settings.set(MOD, "groupInfo", all);
}

/* ------------------------------------------------------------------ */
/* Who is who                                                         */
/* ------------------------------------------------------------------ */

/** The party's characters, for attitudes toward one character in particular. */
function partyMembers() {
  const members = game.actors.party?.members?.filter((a) => a.type === "character") ?? [];
  const list = members.length ? members : game.actors.filter((a) => a.type === "character" && a.hasPlayerOwner);
  return [...list].sort((a, b) => pcName(a).localeCompare(pcName(b)));
}

const pcName = (pc) => pc.prototypeToken?.name?.trim() || pc.name;

/** Attitudes toward particular characters that differ from the NPC's general one, as players may see them. */
function shownOverrides(r, party = partyMembers()) {
  if (r.shown !== "same") return [];
  const general = generalAttitude(r).id;
  return party
    .map((pc) => ({ pc, a: attitude(r.scene.pcs[pc.id] ?? r.pcs[pc.id]) }))
    .filter(({ a }) => a && a.id !== general);
}

/** The attitude the players see: the one as it stands, another one, or Unknown. */
function shownAttitude(r) {
  if (r.shown === "unknown") return UNKNOWN;
  if (r.shown && r.shown !== "same") return attitude(r.shown) ?? UNKNOWN;
  return attitude(generalAttitude(r).id) ?? UNKNOWN;
}

/** The name the party knows: the record's "known as", else the prototype token name, else the actor name. */
function knownName(actor, r = record(actor)) {
  return r.knownAs || actor.prototypeToken?.name?.trim() || actor.name;
}

/**
 * Shipped art (the system's, a Paizo module's, Foundry's icons) can name the real creature, so players don't see it.
 */
const SHIPPED_ART = /^(?:systems\/pf2e\/|modules\/(?:pf2e-tokens-|pathfinder-tokens|pf2e-bestiary-|pf2e-monster-core|pf2e-npc-core)|icons\/)/i;
/**
 * The art players see: the record's portrait, else the actor image unless it is shipped art, else the prototype token
 * image (which the GM chose). When the token's image is shipped art too, a silhouette if the GM's setting asks for one,
 * else that art. Full art, cropped to the card; a click opens it whole.
 */
function playerImg(actor, r = record(actor)) {
  if (r.portrait) return r.portrait;
  const img = actor.img ?? "";
  if (img && !SHIPPED_ART.test(img)) return img;
  const token = actor.prototypeToken?.texture?.src ?? "";
  if (token && !SHIPPED_ART.test(token)) return token;
  if (game.settings.get(MOD, "stockPortrait") === "silhouette") return SILHOUETTE;
  return token || img;
}

/**
 * An NPC actor no player owns, or one that already has a record here: an NPC the GM lends a player for a fight
 * (owner permission) keeps its card. Player-owned summons and companions with no record stay out of the list.
 */
function isNPC(actor) {
  return actor?.type === "npc" && (!actor.hasPlayerOwner || !!actor.flags?.[MOD]?.npc);
}

/** The module ids named in the "Cast flag scopes" setting. */
function castScopes() {
  return String(game.settings.get(MOD, "castFlagScopes") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}
/** Cast: an actor with flags.<scope>.cast for one of the scopes in the castFlagScopes setting. */
function isCast(actor, scopes = castScopes()) {
  return scopes.some((s) => !!actor.flags?.[s]?.cast);
}

/** The world actor behind a token's actor (an unlinked token's actor is a copy). */
const baseActor = (actor) => (actor?.isToken ? game.actors.get(actor.id) : actor) ?? null;

/* ------------------------------------------------------------------ */
/* Changing records                                                   */
/* ------------------------------------------------------------------ */

async function update(actor, changes) {
  await actor.update({ [`flags.${MOD}.${FLAG}`]: changes });
}

/** A date in the world's calendar: Calendaria's when it is on, else Foundry's own. "" when neither can say. */
function gameDate(wt) {
  if (!Number.isFinite(wt)) return "";
  try {
    const cal = game.modules.get("calendaria")?.active ? game.modules.get("calendaria").api ?? globalThis.CALENDARIA?.api : null;
    if (cal?.formatDate && cal.timestampToDate) return String(cal.formatDate(cal.timestampToDate(wt)));
  } catch {
    /* Foundry's own below */
  }
  try {
    return String(game.time.calendar.format(wt, "timestamp")).split(" ")[0];
  } catch {
    return "";
  }
}

/** The history with one change added, the oldest dropped past the cap. */
function withHistory(r, entry) {
  const why = String(entry.why ?? "").slice(0, WHY_LEN);
  return [...r.history, { at: Date.now(), wt: game.time.worldTime, by: game.user.id, ...entry, why }].slice(-HISTORY_MAX);
}

/** Set the NPC's attitude toward the party (null: not set), with an optional reason for its history. */
async function setAttitude(actor, id, { shown, why = "" } = {}) {
  if (!game.user.isGM || !isNPC(actor)) return;
  const r = record(actor);
  const to = attitude(id) ? id : null;
  const changes = {};
  if (to !== r.attitude) Object.assign(changes, { attitude: to, history: withHistory(r, { from: r.attitude, to, pc: null, why }) });
  if (shown !== undefined) changes.shown = shown;
  if (Object.keys(changes).length) await update(actor, changes);
}

/** Set or clear one character's attitude override, with an optional reason for its history. */
async function setTowards(actor, pcId, id, { why = "" } = {}) {
  if (!game.user.isGM || !isNPC(actor) || !pcId) return;
  const r = record(actor);
  const to = attitude(id) ? id : null;
  const from = r.pcs[pcId] ?? null;
  if (to === from) return;
  const history = withHistory(r, { from, to, pc: pcId, why });
  if (to) return actor.update({ [`flags.${MOD}.${FLAG}.pcs.${pcId}`]: to, [`flags.${MOD}.${FLAG}.history`]: history });
  await actor.update({ [`flags.${MOD}.${FLAG}.pcs.${pcId}`]: new foundry.data.operators.ForcedDeletion(), [`flags.${MOD}.${FLAG}.history`]: history });
}

/** Give the latest change in the history a reason. */
async function setLatestWhy(actor, why) {
  if (!game.user.isGM || !isNPC(actor)) return;
  const history = record(actor).history;
  if (!history.length) return;
  history.at(-1).why = String(why ?? "").trim().slice(0, WHY_LEN);
  await update(actor, { history });
}

/** Set an attitude for this scene only (pcId null: toward the party), kept apart from the stored one. id null clears it. */
async function setSceneAttitude(actor, pcId, id) {
  if (!game.user.isGM || !isNPC(actor)) return;
  const to = attitude(id) ? id : null;
  const key = pcId ? `flags.${MOD}.${FLAG}.scene.pcs.${pcId}` : `flags.${MOD}.${FLAG}.scene.attitude`;
  await actor.update({ [key]: to ?? new foundry.data.operators.ForcedDeletion() });
}

/** Clear every attitude held for this scene only, on one NPC (or on all of them when no actor is given). */
async function clearScene(actor = null) {
  if (!game.user.isGM) return;
  const list = actor ? [actor] : game.actors.filter((a) => isNPC(a) && (record(a).scene.attitude || Object.keys(record(a).scene.pcs).length));
  const updates = list.map((a) => ({ _id: a.id, [`flags.${MOD}.${FLAG}.scene`]: new foundry.data.operators.ForcedDeletion() }));
  if (updates.length) await Actor.implementation.updateDocuments(updates);
}

/** The changes that mark an NPC met (or not), keeping when they were first met. */
function metChanges(r, met) {
  return { met, metAt: met ? (r.metAt ?? game.time.worldTime) : null, metOn: met ? (r.metOn ?? Date.now()) : null };
}

async function markMet(actor, met = true) {
  if (!game.user.isGM || !isNPC(actor)) return;
  await update(actor, metChanges(record(actor), met));
}

/** The name players see. Empty falls back to the prototype token name. */
async function setKnownAs(actor, name) {
  if (!game.user.isGM || !isNPC(actor)) return;
  await update(actor, { knownAs: String(name ?? "").trim() });
}

/** Show players the actor's real name. */
const reveal = (actor) => setKnownAs(actor, actor.name);

/** The selected tokens' NPCs (world actors, each once), and how many tokens had no actor left. */
function selectedNPCs() {
  const seen = new Map();
  let skipped = 0;
  for (const t of canvas.tokens?.controlled ?? []) {
    if (!isNPC(t.actor)) continue;
    const actor = baseActor(t.actor);
    // An unlinked token whose actor is gone: nothing to record on.
    if (!actor) {
      skipped++;
      continue;
    }
    if (!seen.has(actor)) seen.set(actor, t);
  }
  return { seen, skipped };
}

/** Reveal the real names of the selected tokens' NPCs (a hotbar macro). */
async function revealSelected() {
  if (!game.user.isGM) return;
  const { seen } = selectedNPCs();
  if (!seen.size) return ui.notifications.warn(L("Notice.SelectFirst"));
  await updateMany([...seen.keys()], (a) => ({ knownAs: a.name }));
  ui.notifications.info(L("Notice.Revealed", { n: seen.size }));
}

/**
 * Mark the selected tokens' NPCs as met, with one update each. A token whose name differs from its prototype's gives
 * the name the party saw, when none is set yet. group: undefined keeps each one's group, "" takes them out of one.
 */
async function markSelected({ group } = {}) {
  if (!game.user.isGM) return;
  const { seen, skipped } = selectedNPCs();
  if (!seen.size) return ui.notifications.warn(L(skipped ? "Notice.SelectedGone" : "Notice.SelectFirst"));
  const into = group === undefined ? undefined : group ? canonicalGroup(group) : "";
  await updateMany([...seen.keys()], (actor) => {
    const r = record(actor);
    const t = seen.get(actor);
    const name = t.document.name?.trim() ?? "";
    const changes = metChanges(r, true);
    if (name && name !== actor.prototypeToken?.name?.trim() && !r.knownAs) changes.knownAs = name;
    if (into !== undefined) changes.group = into;
    return changes;
  });
  ui.notifications.info(skipped ? L("Notice.MarkedSkipped", { n: seen.size, skipped }) : L("Notice.Marked", { n: seen.size }));
}

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
  const label = game.i18n.localize(want === D.HOSTILE ? "TOKEN.DISPOSITION.HOSTILE" : "TOKEN.DISPOSITION.FRIENDLY");
  const ok = await foundry.applications.api.DialogV2.confirm({
    window: { title: L("Disposition.Title") },
    content: `<p>${L(tokens.length === 1 ? "Disposition.One" : "Disposition.Many", { name: `<strong>${esc(knownName(actor))}</strong>`, n: tokens.length, label: esc(label) })}</p>`,
  });
  if (!ok) return;
  await canvas.scene.updateEmbeddedDocuments("Token", tokens.map((t) => ({ _id: t.id, disposition: want })));
}

/* ------------------------------------------------------------------ */
/* Party notes                                                        */
/* ------------------------------------------------------------------ */

const writeNotes = (actor, list) => actor.update({ [`flags.${MOD}.${FLAG}.notes`]: list });

/**
 * One change to notes at a time, each reading the list the one before it saved. Every change goes through one client,
 * the lead tab of the active GM (see addNote), so changes made at the same moment elsewhere aren't lost.
 */
let noteQueue = Promise.resolve();
function changeNotes(fn) {
  const next = noteQueue.then(fn, fn);
  noteQueue = next.catch(() => {});
  return next;
}

/** Save a note in the lead client: "" when saved (or saved already), else why it was turned down. */
function saveNote(actor, entry) {
  return changeNotes(async () => {
    const list = record(actor).notes;
    // The same note again: sent twice, or handled by two GM tabs at a hand-over.
    if (entry.id && list.some((e) => e.id === entry.id && e.by === entry.by)) return "";
    const why = noteRefusal(list, entry.text);
    if (why) return why;
    await writeNotes(actor, appendNote(list, entry));
    return "";
  });
}

/** Remove a note in the lead client; nothing is written when no note matches. */
function removeNote(actor, key) {
  return changeNotes(async () => {
    const list = record(actor).notes;
    const left = list.filter((e) => !sameNote(e, key));
    if (left.length < list.length) await writeNotes(actor, left);
  });
}

/** Send a request to the GM's client; false (with a notice) when no GM is there to save it. */
function emit(msg) {
  if (!game.users.activeGM) {
    ui.notifications.warn(L("Notes.NoGM"));
    return false;
  }
  game.socket.emit(`module.${MOD}`, msg);
  return true;
}

let lastSent = 0;
/** Notes this client sent to the GM's client, by id, so a note turned down there goes back in the box. */
const pending = new Map();

/**
 * Add a party note as this user. True when it was saved here or sent to the lead client. The active GM's lead tab
 * saves it at once; every other client (a player, a second GM tab, an assistant GM, a macro) sends it there.
 */
async function addNote(actor, text) {
  text = String(text ?? "").trim();
  if (!actor || !text) return false;
  const why = noteRefusal(record(actor).notes, text);
  if (why) {
    ui.notifications.warn(refusalText(why));
    return false;
  }
  const id = noteId();
  if (game.user.isGM && (await tabs.leadNow())) {
    const late = await saveNote(actor, { id, by: game.user.id, at: Date.now(), text });
    if (late) ui.notifications.warn(refusalText(late));
    return !late;
  }
  const now = Date.now();
  if (!game.user.isGM && now - lastSent < NOTE_SEND_GAP) {
    ui.notifications.warn(refusalText("fast"));
    return false;
  }
  if (!emit({ type: "note", actorId: actor.id, text, id })) return false;
  if (!game.user.isGM) lastSent = now;
  for (const [k, v] of pending) if (now - v.at > 60000) pending.delete(k);
  pending.set(id, { actorId: actor.id, text, at: now });
  return true;
}

/** Remove a note named by { id, at, by }. The GM removes any; a player only their own. */
async function deleteNote(actor, key) {
  if (!game.user.isGM && String(key?.by ?? "") !== game.user.id) return;
  if (game.user.isGM && (await tabs.leadNow())) return removeNote(actor, key);
  emit({ type: "noteDelete", actorId: actor.id, id: key.id ?? null, at: key.at ?? null, by: key.by ?? "" });
}

/** The GM's client turned down a note this tab sent: say why, and put the text back if the box is empty. */
function heardRefusal(msg, senderId) {
  const why = refusalText(msg.reason);
  const sent = pending.get(msg.id);
  if (msg.to !== game.user.id || !why || !sent || !game.users.get(senderId)?.isGM) return;
  pending.delete(msg.id);
  ui.notifications.warn(why);
  const box = [...(people.current()?.element?.querySelectorAll("input[name=npaNote]") ?? [])].find((el) => el.dataset.id === sent.actorId);
  if (box && !box.value.trim()) box.value = sent.text;
}

/** In the lead client: when each player last added a note, and when they were last told to slow down. */
const lastNoteAt = new Map();
const lastRefusedAt = new Map();

/**
 * Foundry calls a module socket handler with the message and then the sender's user id (its server passes on only the
 * message and adds the id itself). Anything else isn't a message from Foundry's server, so it is dropped.
 */
function onSocketMessage(msg, ...rest) {
  if (rest.length !== 1) return;
  onSocket(msg, rest[0]).catch((err) => console.error(`${MOD} |`, err));
}

/** A note's author is the sender, and a player may remove only their own notes, whatever the message says. */
async function onSocket(msg, senderId) {
  if (tabs.handle(msg, senderId)) return;
  if (msg?.type === "noteRefused") return heardRefusal(msg, senderId);
  if (msg?.type === "impressionApply") {
    // Another GM client's Apply, done here in the lead tab.
    if (!game.users.get(senderId)?.isGM || !(await tabs.leadNow())) return;
    const message = game.messages.get(msg.messageId);
    if (message && ["scene", "lasting"].includes(msg.mode)) await applyImpression(message, String(msg.actorId ?? ""), msg.mode, !!msg.party);
    return;
  }
  if (msg?.type !== "note" && msg?.type !== "noteDelete") return;
  if (!(await tabs.leadNow())) return;
  const sender = game.users.get(senderId);
  const actor = game.actors.get(msg.actorId);
  if (!sender || !actor) return;
  if (!sender.isGM && (!isNPC(actor) || !record(actor).met)) return;
  if (msg.type === "noteDelete") {
    const by = String(msg.by ?? "");
    // A GM removes any note, those without an author included; a player only their own.
    if (!sender.isGM && (!by || by !== senderId)) return;
    return removeNote(actor, { id: validNoteId(msg.id) ? msg.id : null, at: msg.at, by });
  }
  const text = String(msg.text ?? "").trim();
  if (!text) return;
  const id = validNoteId(msg.id) ? msg.id : noteId();
  const refuse = (reason) => game.socket.emit(`module.${MOD}`, { type: "noteRefused", to: senderId, reason, id });
  const now = Date.now();
  if (!sender.isGM) {
    if (now - (lastNoteAt.get(senderId) ?? 0) < NOTE_GAP) {
      // One answer per gap: a flood of messages gets one refusal, not one each.
      if (now - (lastRefusedAt.get(senderId) ?? 0) >= NOTE_GAP) {
        lastRefusedAt.set(senderId, now);
        refuse("fast");
      }
      return;
    }
    lastNoteAt.set(senderId, now);
  }
  const why = await saveNote(actor, { id, by: senderId, at: now, text });
  if (why) refuse(why);
}

/* ------------------------------------------------------------------ */
/* Records changed by someone who isn't a GM                          */
/* ------------------------------------------------------------------ */

/**
 * A player who owns an NPC (one lent for a fight) could rewrite its record from the console. Every GM client keeps
 * each record as a GM last saw it; the lead tab puts a record a player changed back the way it was.
 */
const knownRecords = new Map();
const remember = (actor) => knownRecords.set(actor.id, JSON.stringify(actor.flags?.[MOD]?.[FLAG] ?? null));

async function guardRecord(actor, changes, userId) {
  if (!game.user.isGM) return;
  const now = JSON.stringify(actor.flags?.[MOD]?.[FLAG] ?? null);
  if (game.users.get(userId)?.isGM) return remember(actor);
  // Whatever keys the change named (a whole `flags` replaced included): only the record itself matters.
  if (!knownRecords.has(actor.id) || knownRecords.get(actor.id) === now || !tabs.isLead()) return;
  const before = JSON.parse(knownRecords.get(actor.id));
  const ops = foundry.data.operators;
  await actor.update({ [`flags.${MOD}.${FLAG}`]: before ? new ops.ForcedReplacement(before) : new ops.ForcedDeletion() });
  ui.notifications.warn(L("Notice.Undone", { user: esc(game.users.get(userId)?.name ?? "?"), name: esc(knownName(actor)) }));
}

/* ------------------------------------------------------------------ */
/* Announcements                                                      */
/* ------------------------------------------------------------------ */

/** Post what the players see of an NPC to chat. Only ever from the Announce button or the API. */
async function announce(actor) {
  if (!game.user.isGM) return;
  const mode = game.settings.get(MOD, "announce");
  if (mode === "off") return ui.notifications.warn(L("Notice.AnnounceOff"));
  const r = record(actor);
  const a = shownAttitude(r);
  const lower = (s) => s.toLocaleLowerCase(game.i18n.lang);
  const towards = shownOverrides(r).map(({ pc, a }) => L("Announce.Toward", { attitude: esc(lower(a.label)), pc: esc(pcName(pc)) })).join(", ");
  const name = `<strong>${esc(knownName(actor, r))}</strong>`;
  const line = a.id === "unknown" ? L("Announce.HardToRead", { name }) : L("Announce.Seems", { name, attitude: esc(lower(a.label)) });
  const content = `<div class="npa-chat"><i class="fa-regular ${a.icon}"></i> ${line}${towards ? ` (${towards})` : ""}.${r.blurb ? ` <em>${esc(r.blurb)}</em>` : ""}</div>`;
  await ChatMessage.create({
    content,
    speaker: { alias: L("Title") },
    whisper: mode === "gm" ? ChatMessage.getWhisperRecipients("GM").map((u) => u.id) : [],
  }).catch(console.error);
}

/* ------------------------------------------------------------------ */
/* Make an Impression                                                 */
/* ------------------------------------------------------------------ */

/** The most targets of one roll, and the penalty when there is more than one. */
const IMPRESSION_TARGETS = 5;
const IMPRESSION_SEVERAL = -2;
/** Steps the attitude moves for each degree of success, worst to best. */
const IMPRESSION_STEPS = [-1, 0, 1, 2];
const DEGREES = ["criticalFailure", "failure", "success", "criticalSuccess"];

/** A degree of success's name, in the system's own words. */
const degreeLabel = (d) => game.i18n.localize(`PF2E.Check.Result.Degree.Check.${DEGREES[d]}`);

/** The degree of success (0 to 3) of a check total against a DC, a natural 20 one better and a natural 1 one worse. */
function degreeOf(total, natural, dc) {
  let d = total >= dc + 10 ? 3 : total >= dc ? 2 : total <= dc - 10 ? 0 : 1;
  if (natural === 20) d = Math.min(3, d + 1);
  else if (natural === 1) d = Math.max(0, d - 1);
  return d;
}

/** An NPC's Will DC, or null. */
function willDC(actor) {
  const dc = actor?.saves?.will?.dc?.value ?? actor?.system?.saves?.will?.dc?.value;
  return Number.isFinite(dc) ? dc : null;
}

/** May this user start Make an Impression? A GM always; a player when the GM allows it and they own a character. */
function canImpress() {
  if (game.user.isGM) return true;
  return game.settings.get(MOD, "impressionPlayers") && impressionRollers().length > 0;
}

/** The characters this user can roll for: the GM, the party; a player, the characters they own. */
function impressionRollers() {
  if (game.user.isGM) return partyMembers();
  const party = partyMembers().filter((a) => a.isOwner);
  return party.length ? party : game.actors.filter((a) => a.type === "character" && a.isOwner);
}

/** The NPCs that can be picked as targets: met and not archived, by the name the party knows. */
function impressionTargets() {
  return game.actors.filter((a) => isNPC(a) && record(a).met && !record(a).archived).sort((a, b) => knownName(a).localeCompare(knownName(b)));
}

/** Ask who rolls, against whom, and any situation modifier, then roll. */
async function makeImpression(first = null) {
  if (!canImpress()) return ui.notifications.warn(L("Impression.NotAllowed"));
  const action = game.pf2e?.actions?.get("make-an-impression");
  if (!action) return ui.notifications.warn(L("Impression.NoAction"));
  const rollers = impressionRollers();
  if (!rollers.length) return ui.notifications.warn(L("Impression.NoCharacter"));
  const targets = impressionTargets();
  const firstId = baseActor(first)?.id ?? null;
  const mine = game.user.character && rollers.includes(game.user.character) ? game.user.character.id : rollers[0].id;
  const content = `<div class="npa-impress">
      <p class="npa-hint">${esc(L("Impression.Reminder"))}</p>
      <label class="npa-ask">${esc(L("Impression.Who"))} <select name="pc">${rollers.map((pc) => `<option value="${pc.id}" ${pc.id === mine ? "selected" : ""}>${esc(pcName(pc))}</option>`).join("")}</select></label>
      <fieldset><legend>${esc(L("Impression.Targets", { n: IMPRESSION_TARGETS, penalty: IMPRESSION_SEVERAL }))}</legend>
        <div class="npa-impress-list">${targets.map((t) => `<label><input type="checkbox" name="target" value="${t.id}" ${t.id === firstId ? "checked" : ""}> ${esc(knownName(t))}</label>`).join("")}</div>
      </fieldset>
      <label class="npa-ask">${esc(L("Impression.Situation"))} <input type="number" name="mod" value="0" step="1" min="-10" max="10"></label>
    </div>`;
  const pick = await foundry.applications.api.DialogV2.wait({
    window: { title: L("Impression.Title") },
    position: { width: 440 },
    classes: ["npa-dialog"],
    content,
    render: (event, dialog) => {
      // No more than five targets: the rest gray out once five are ticked.
      const root = dialog.element ?? dialog;
      const boxes = [...root.querySelectorAll("input[name=target]")];
      const limit = () => {
        const n = boxes.filter((b) => b.checked).length;
        for (const b of boxes) b.disabled = !b.checked && n >= IMPRESSION_TARGETS;
      };
      boxes.forEach((b) => b.addEventListener("change", limit));
      limit();
    },
    buttons: [
      { action: "roll", label: L("Impression.Roll"), icon: "fa-solid fa-dice-d20", default: true, callback: (ev, button) => ({ pc: button.form.elements.pc.value, ids: [...button.form.querySelectorAll("input[name=target]:checked")].map((b) => b.value), mod: Number(button.form.elements.mod.value) || 0 }) },
      { action: "cancel", label: L("Cancel") },
    ],
    rejectClose: false,
  });
  if (!pick || typeof pick !== "object") return;
  const pc = game.actors.get(pick.pc);
  const chosen = pick.ids.map((id) => game.actors.get(id)).filter(Boolean).slice(0, IMPRESSION_TARGETS);
  if (!pc || !chosen.length) return ui.notifications.warn(L("Impression.PickTarget"));
  return rollImpression(pc, chosen, pick.mod);
}

/** Roll Make an Impression through the system's own action, and mark its chat card with what the GM needs to apply it. */
async function rollImpression(pc, targets, mod = 0) {
  const action = game.pf2e?.actions?.get("make-an-impression");
  if (!action || !pc?.isOwner) return;
  const Modifier = game.pf2e.Modifier;
  const modifiers = [];
  if (targets.length > 1) modifiers.push(new Modifier({ slug: "npa-several-targets", label: L("Impression.SeveralLabel"), modifier: IMPRESSION_SEVERAL, type: "untyped" }));
  if (mod) modifiers.push(new Modifier({ slug: "npa-situation", label: L("Impression.SituationLabel"), modifier: mod, type: "circumstance" }));
  // One target: the system takes its Will DC and shows the result. Several: one roll, each target's result on the GM's card.
  const results = await action.use({ actors: [pc], ...(targets.length === 1 ? { target: targets[0] } : {}), modifiers });
  const message = [results].flat().map((r) => r?.message).find((m) => m?.id) ?? null;
  if (!message) return null;
  // The key names this roll; a Hero Point reroll copies it, so the two cards share one result.
  await message.update({ [`flags.${MOD}.impression`]: { pc: pc.id, targets: targets.map((t) => t.id), key: noteId() } }).catch(console.error);
  return message;
}

/**
 * Is this card one the GM may apply? The system's check for Make an Impression, marked by this module, by a GM, or by
 * a player who owns the rolling character while the GM lets players roll it; each player-chosen target met by the party.
 * (Foundry trusts the roll a client makes: what can be checked is who made it and for what.)
 */
function impressionCard(message) {
  const flag = message?.flags?.[MOD]?.impression;
  const ctx = message?.flags?.pf2e?.context;
  if (!flag || !Array.isArray(flag.targets) || !message.rolls?.[0]) return null;
  if (!(ctx?.options ?? []).includes("action:make-an-impression")) return null;
  const pc = game.actors.get(flag.pc);
  const author = message.author ?? game.users.get(message.user ?? message._source?.author);
  if (!pc || !author) return null;
  const byGM = author.isGM;
  if (!byGM && !(game.settings.get(MOD, "impressionPlayers") && pc.testUserPermission(author, "OWNER"))) return null;
  const targets = flag.targets.slice(0, IMPRESSION_TARGETS).map((id) => game.actors.get(id)).filter((a) => isNPC(a) && (byGM || record(a).met));
  return { flag, pc, targets, key: typeof flag.key === "string" && flag.key ? flag.key : message.id, msg: `msg:${message.id}` };
}

/** Each target's result for a marked chat card, worked out from the card's own roll: [{ actor, dc, degree, steps }]. */
function impressionResults(message) {
  const card = impressionCard(message);
  const roll = message?.rolls?.[0];
  if (!card) return [];
  const natural = roll.dice?.[0]?.total ?? null;
  return card.targets.map((actor) => {
    const dc = willDC(actor);
    const degree = dc === null ? null : degreeOf(roll.total, natural, dc);
    return { actor, dc, degree, steps: degree === null ? 0 : IMPRESSION_STEPS[degree] };
  });
}

/**
 * Where a result starts from. For this scene: the attitude as it stands now (this scene's first). Lasting: the stored
 * one, leaving this scene's aside. Toward the roller, or the general one for the whole party; Not set counts as Indifferent.
 */
function impressionBase(r, pcId, { party = false, scene = false } = {}) {
  const stored = r.attitude ?? (r.group ? groupAttitude(r.group)?.id : null) ?? null;
  if (party) return scene ? r.scene.attitude ?? stored : stored;
  return scene ? r.scene.pcs[pcId] ?? r.pcs[pcId] ?? r.scene.attitude ?? stored : r.pcs[pcId] ?? stored;
}

/** Has this NPC taken the result of this roll already (by the roll's key, which a reroll copies, or by the card)? */
const impressionApplied = (actor, card) => record(actor).impressions.some((k) => k === card.key || k === card.msg);

/** The GM's Apply panel on a Make an Impression card: each target's result and what applying it would do. */
function impressionPanel(message) {
  const card = impressionCard(message);
  const results = impressionResults(message);
  if (!card || !results.length) return null;
  const { pc, flag } = card;
  const applied = flag.applied ?? {};
  const rows = results.map(({ actor, dc, degree, steps }) => {
    const r = record(actor);
    const name = esc(knownName(actor, r));
    if (degree === null) return `<li><strong>${name}</strong> ${esc(L("Impression.NoDC"))}</li>`;
    const result = `${esc(degreeLabel(degree))} (${esc(L("Impression.WillDC", { dc }))})`;
    // Only the NPC's own record says a result was applied; the card's mark (which its author can change) only words it.
    if (impressionApplied(actor, card)) {
      const done = applied[actor.id];
      const text = done && attitude(done.to) ? L(done.mode === "scene" ? "Impression.AppliedScene" : "Impression.AppliedLasting", { attitude: attitudeLabel(done.to) }) : L("Impression.AppliedElsewhere");
      return `<li><strong>${name}</strong> ${result}: ${esc(text)}</li>`;
    }
    if (!steps) return `<li><strong>${name}</strong> ${result}: ${esc(L("Impression.NoChange"))}</li>`;
    const label = (base) => (base ? attitudeLabel(base) : L("Impression.NotSetIndifferent"));
    const preview = (party) => {
      const line = (scene) => {
        const base = impressionBase(r, pc.id, { party, scene });
        return party
          ? L("Impression.WouldParty", { from: label(base), to: attitudeLabel(stepAttitude(base, steps)) })
          : L("Impression.Would", { from: label(base), to: attitudeLabel(stepAttitude(base, steps)), pc: pcName(pc) });
      };
      const lasting = line(false);
      const now = line(true);
      return now === lasting ? esc(lasting) : `${esc(L("Impression.LastingPreview", { line: lasting }))}; ${esc(L("Impression.ScenePreview", { line: now }))}`;
    };
    const button = (mode) => `<button type="button" data-npa-apply="${mode}" data-actor="${actor.id}">${esc(L(mode === "scene" ? "Impression.ForScene" : "Impression.Lasting"))}</button>`;
    return `<li data-npa-row="${actor.id}"><strong>${name}</strong> ${result}: <span data-npa-for="pc">${preview(false)}</span><span data-npa-for="party" hidden>${preview(true)}</span>
        <span class="npa-apply">${button("scene")}${button("lasting")}<label><input type="checkbox" data-npa-party="${actor.id}"> ${esc(L("Impression.Party"))}</label></span></li>`;
  }).join("");
  const panel = document.createElement("div");
  panel.className = "npa-impression-apply";
  panel.innerHTML = `<p><i class="fa-solid fa-address-book" aria-hidden="true"></i> ${esc(L("Impression.GMOnly"))}</p><ul>${rows}</ul>`;
  return panel;
}

/** Results being applied in this client, so a second click (or the same card shown twice) waits its turn and stops. */
const applying = new Set();

/**
 * Apply one target's result from a marked card: for this scene or lasting, toward the roller or the whole party. The
 * NPC remembers the roll in the same update that changes its attitude, so the result can't be applied twice, whatever
 * happens to the card.
 */
async function applyImpression(message, actorId, mode, party = false) {
  if (!game.user.isGM) return;
  const fresh = game.messages.get(message?.id) ?? null;
  const card = fresh ? impressionCard(fresh) : null;
  if (!card) return;
  const lock = `${card.key}:${actorId}`;
  if (applying.has(lock)) return;
  applying.add(lock);
  try {
    const hit = impressionResults(fresh).find((x) => x.actor.id === actorId);
    if (!hit || !hit.steps || impressionApplied(hit.actor, card)) return;
    const { pc } = card;
    const r = record(hit.actor);
    const scene = mode === "scene";
    const from = impressionBase(r, pc.id, { party, scene });
    const to = stepAttitude(from, hit.steps);
    const why = L("Impression.Why", { pc: pcName(pc), result: degreeLabel(hit.degree) });
    const base = `flags.${MOD}.${FLAG}`;
    const changes = { [`${base}.impressions`]: [...r.impressions, card.key, card.msg].slice(-IMPRESSIONS_MAX) };
    if (scene) changes[party ? `${base}.scene.attitude` : `${base}.scene.pcs.${pc.id}`] = to;
    else if (party) Object.assign(changes, { [`${base}.attitude`]: to, [`${base}.history`]: withHistory(r, { from: r.attitude, to, pc: null, why }) });
    else Object.assign(changes, { [`${base}.pcs.${pc.id}`]: to, [`${base}.history`]: withHistory(r, { from: r.pcs[pc.id] ?? null, to, pc: pc.id, why }) });
    await hit.actor.update(changes);
    if (game.messages.get(fresh.id)) await fresh.update({ [`flags.${MOD}.impression.applied.${actorId}`]: { mode, party: !!party, to } }).catch(console.error);
  } finally {
    applying.delete(lock);
  }
}

/** Hook: add the GM's Apply panel to Make an Impression cards this module marked. */
function onRenderMessage(message, html) {
  if (!game.user.isGM || !message.flags?.[MOD]?.impression) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  const panel = root ? impressionPanel(message) : null;
  if (!panel) return;
  (root.querySelector(".message-content") ?? root).append(panel);
  panel.addEventListener("change", (ev) => {
    const box = ev.target.closest?.("[data-npa-party]");
    const row = box?.closest("[data-npa-row]");
    if (!row) return;
    row.querySelector('[data-npa-for="pc"]').hidden = box.checked;
    row.querySelector('[data-npa-for="party"]').hidden = !box.checked;
  });
  panel.addEventListener("click", async (ev) => {
    const button = ev.target.closest?.("[data-npa-apply]");
    if (!button) return;
    const id = button.dataset.actor;
    const party = !!panel.querySelector(`[data-npa-party="${id}"]`)?.checked;
    // Both buttons of the row go out at once: one result per target.
    panel.querySelectorAll(`[data-npa-row="${id}"] button, [data-npa-row="${id}"] input`).forEach((el) => (el.disabled = true));
    // One client applies results, the active GM's lead tab, so two GM clients can't both apply a row.
    const req = { messageId: message.id, actorId: id, mode: button.dataset.npaApply, party };
    if (await tabs.leadNow()) applyImpression(message, req.actorId, req.mode, req.party).catch(console.error);
    else if (game.users.activeGM) game.socket.emit(`module.${MOD}`, { type: "impressionApply", ...req });
  });
}

/* ------------------------------------------------------------------ */
/* Window                                                             */
/* ------------------------------------------------------------------ */

let refreshTimer = null;
const TYPING = "textarea, input[type=text], input[type=search], input[type=number], select";
/** The drag data type of a card dragged by its portrait. */
const NPC_DRAG = "application/x-npa-npc";
/** The drag data type of a group row dragged to a new place in the list. */
const GROUP_DRAG = "application/x-npa-group";
function refresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    const app = people.current();
    if (!app?.rendered) return;
    // Don't redraw under someone who is typing: wait until they leave the field.
    const active = document.activeElement;
    // An empty note box (a note just sent) isn't typing: the redraw shows the note and focus comes back to the box.
    const idle = active?.matches?.("input[name=npaNote]") && !active.value;
    if (active && app.element.contains(active) && active.matches(TYPING) && !idle) {
      if (!app._deferred) {
        app._deferred = true;
        active.addEventListener("blur", () => {
          app._deferred = false;
          setTimeout(refresh, 50);
        }, { once: true });
      }
      return;
    }
    app.render();
  }, 250);
}

function loadChips() {
  const v = store.get("chips", {}, { from: OLD_CHIPS_KEY });
  const c = v && typeof v === "object" ? v : {};
  return { cast: !!c.cast, metOnly: c.metOnly !== false, sort: c.sort === "recent" ? "recent" : "name", view: typeof c.view === "string" ? c.view : "all" };
}

function saveChips(state) {
  store.set("chips", { cast: state.cast, metOnly: state.metOnly, sort: state.sort, view: state.view });
}

/** An attitude <select>'s options. */
const attitudeOptions = (sel, extra = []) => [...extra, ...ATTITUDES].map((a) => `<option value="${a.id}" ${a.id === sel ? "selected" : ""}>${esc(a.label)}</option>`).join("");

const Base = keyboardWindow(rememberWindow(foundry.applications.api.ApplicationV2, { module: MOD, name: "main", from: `${MOD}.size` }), { module: MOD, scope: ".npa-app", ownKeys: true });

class PeopleApp extends Base {
  static DEFAULT_OPTIONS = {
    id: "pf2e-npc-attitudes",
    classes: ["npa-app"],
    tag: "div",
    window: { title: "NPA.Title", icon: "fa-solid fa-address-book", resizable: true },
    position: { width: 940, height: 680 },
    actions: {
      npaFilter: PeopleApp.#onFilter,
      npaGoTo: PeopleApp.#onGoTo,
      npaSort: PeopleApp.#onSort,
      npaArchive: PeopleApp.#onArchive,
      npaNewGroup: PeopleApp.#onNewGroup,
      npaSortGroups: () => sortGroups(),
      npaShiftGroup: PeopleApp.#onShiftGroup,
      npaGroupAttitude: PeopleApp.#onGroupAttitude,
      npaRenameGroup: PeopleApp.#onRenameGroup,
      npaArchiveGroup: PeopleApp.#onArchiveGroup,
      npaRestoreGroup: PeopleApp.#onRestoreGroup,
      npaRemoveGroup: PeopleApp.#onRemoveGroup,
      npaChip: PeopleApp.#onChip,
      npaMarkSelected: PeopleApp.#onMarkSelected,
      npaMet: PeopleApp.#onMet,
      npaOpen: PeopleApp.#onOpen,
      npaPicture: PeopleApp.#onView,
      npaAnnounce: PeopleApp.#onAnnounce,
      npaImpress: PeopleApp.#onImpress,
      npaClearScene: PeopleApp.#onClearScene,
      npaReveal: PeopleApp.#onReveal,
      npaPickPortrait: PeopleApp.#onPickPortrait,
      npaAddNote: PeopleApp.#onAddNote,
      npaDeleteNote: PeopleApp.#onDeleteNote,
      npaExpand: PeopleApp.#onExpand,
      npaBulk: PeopleApp.#onBulk,
    },
  };

  state = { filter: "all", search: "", openPer: new Set(), openEdit: new Set(), openHist: new Set(), expanded: new Set(), selected: new Set(), selecting: false, include: null, scrollTo: null, ...loadChips() };

  get isGM() {
    return game.user.isGM;
  }

  /** What one draw reads more than once: worked out once per draw (cleared at the start of each). */
  _ctx = null;
  get ctx() {
    return (this._ctx ??= { party: partyMembers(), groups: groupNames(), scopes: castScopes(), impress: canImpress() });
  }

  /** Everyone this user may list before the sidebar, attitude and search narrow it: players see only who they've met. */
  base() {
    const scopes = this.ctx.scopes;
    const castOn = this.isGM && this.state.cast && scopes.length > 0;
    return game.actors.filter(isNPC).map((actor) => ({ actor, r: record(actor) }))
      .filter(({ actor, r }) => r.met || (this.isGM && (!this.state.metOnly || actor.id === this.state.include)))
      .filter(({ actor }) => !castOn || isCast(actor, scopes) || actor.id === this.state.include);
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

  people(all = this.base()) {
    const byName = (x, y) => knownName(x.actor, x.r).localeCompare(knownName(y.actor, y.r));
    const recent = (x, y) => (y.r.metAt ?? -Infinity) - (x.r.metAt ?? -Infinity) || (y.r.metOn ?? 0) - (x.r.metOn ?? 0) || byName(x, y);
    const q = this.state.search.trim().toLowerCase();
    return all
      .filter(({ r }) => this.inView(r))
      .filter(({ actor, r }) => {
        const a = this.isGM ? attitude(generalAttitude(r).id) ?? UNKNOWN : shownAttitude(r);
        if (this.state.filter !== "all" && a.id !== this.state.filter) return false;
        if (!q) return true;
        const hay = `${knownName(actor, r)} ${this.isGM ? actor.name : ""} ${r.blurb} ${r.group}`.toLowerCase();
        return hay.includes(q);
      })
      .sort((x, y) => Number(y.r.met) - Number(x.r.met) || (this.state.sort === "recent" && x.r.met ? recent(x, y) : byName(x, y)));
  }

  /** The sidebar: Everyone, each group, No group, Archived, with counts. Players see only groups with someone they've met. */
  sidebar(all = this.base()) {
    const counts = new Map();
    let active = 0, none = 0, archived = 0;
    for (const { r } of all) {
      if (r.archived) {
        archived++;
        continue;
      }
      active++;
      if (!r.group) none++;
      else counts.set(r.group, (counts.get(r.group) ?? 0) + 1);
    }
    const names = this.ctx.groups.filter((g) => this.isGM || counts.get(g));
    const row = (view, label, n, { icon = "", group = null, att = null } = {}) => {
      const current = this.state.view === view;
      const inner = `${icon ? `<i class="fa-solid ${icon}" aria-hidden="true"></i> ` : ""}<span>${esc(label)}</span>${att ? `<i class="fa-regular ${att.icon} npa-side-att" aria-hidden="true"${tipAttr(att.label)}></i>` : ""}<em>${n}</em>`;
      const drop = this.isGM ? ` data-drop-view="${esc(view)}"` : "";
      const common = `class="npa-side-row ${current ? "active" : ""}" data-action="npaGoTo" data-view="${esc(view)}"${drop}${current ? ` aria-current="true"` : ""}`;
      // A group the GM may drag into a new place stays a role=button element: Firefox drags real buttons badly.
      if (this.isGM && group !== null) return `<div role="button" tabindex="0" ${common} draggable="true" data-drag-group="${esc(group)}">${inner}</div>`;
      return `<button type="button" ${common}>${inner}</button>`;
    };
    const groupAtt = (g) => {
      const a = this.isGM ? groupAttitude(g) : null;
      return a ? attitude(a.id) : null;
    };
    return `<nav class="npa-side" data-focus-pane="side" tabindex="-1" aria-label="${esc(L("Side.Label"))}">
        ${row("all", L("Side.Everyone"), active)}
        ${names.map((g) => row(`group:${g}`, g, counts.get(g) ?? 0, { group: g, att: groupAtt(g) })).join("")}
        ${(none || this.isGM) && names.length ? row("none", L("Side.NoGroup"), none) : ""}
        ${archived || this.isGM ? `<hr>${row("archived", L("Side.Archived"), archived, { icon: "fa-box-archive" })}` : ""}
        ${this.isGM ? `<button type="button" class="npa-side-row npa-new" data-action="npaNewGroup"><i class="fa-solid fa-plus" aria-hidden="true"></i> <span>${esc(L("Side.NewGroup"))}</span></button>` : ""}
        ${this.isGM && names.length > 1 ? `<button type="button" class="npa-side-row npa-new" data-action="npaSortGroups"${tipAttr(L("Side.SortTip"))}><i class="fa-solid fa-arrow-down-a-z" aria-hidden="true"></i> <span>${esc(L("Side.Sort"))}</span></button>` : ""}
      </nav>`;
  }

  /** The GM's tools for the open group. */
  groupBar(listed = this.people()) {
    const v = this.state.view;
    if (!this.isGM || !v.startsWith("group:") || this.state.search.trim()) return "";
    const name = v.slice(6);
    const members = groupMembers(name);
    const archived = members.filter((a) => record(a).archived).length;
    const active = members.length - archived;
    // The bar's actions reach everyone in the group, also those the chips hide: say so.
    const shownHere = listed.filter(({ r }) => !r.archived).length;
    const hidden = active - shownHere;
    const list = this.ctx.groups;
    const at = list.indexOf(name);
    const b = (action, icon, label, tip, data = "") => `<button type="button" data-action="${action}"${data}${tip ? tipAttr(tip) : ""}><i class="fa-solid ${icon}" aria-hidden="true"></i> ${esc(label)}</button>`;
    const iconOnly = (action, icon, label, data) => `<button type="button" data-action="${action}"${data}${labelAttr(label)}><i class="fa-solid ${icon}" aria-hidden="true"></i></button>`;
    const ga = groupAttitude(name);
    const gaText = ga ? (ga.from === "tracker" ? L("Group.FromTracker", { attitude: attitudeLabel(ga.id), tracker: ga.tracker, tier: ga.tier }) : L("Group.Own", { attitude: attitudeLabel(ga.id) })) : L("Group.NoAttitude");
    return `<div class="npa-groupbar"><strong>${esc(name)}</strong>
        ${at > 0 ? iconOnly("npaShiftGroup", "fa-arrow-up", L("Group.MoveUp"), ` data-by="-1"`) : ""}
        ${at >= 0 && at < list.length - 1 ? iconOnly("npaShiftGroup", "fa-arrow-down", L("Group.MoveDown"), ` data-by="1"`) : ""}
        ${b("npaGroupAttitude", ga ? ICONS[ga.id] ?? "fa-face-meh" : "fa-face-meh", gaText, L("Group.AttitudeTip"))}
        ${b("npaRenameGroup", "fa-pen", L("Group.Rename"), L("Group.RenameTip"))}
        ${active ? b("npaArchiveGroup", "fa-box-archive", L("Group.ArchiveAll"), hidden > 0 ? L("Group.ArchiveTipHidden", { n: active, hidden }) : L("Group.ArchiveTip", { n: active })) : ""}
        ${archived ? b("npaRestoreGroup", "fa-box-open", L("Group.BringBack", { n: archived }), L("Group.BringBackTip")) : ""}
        ${b("npaRemoveGroup", "fa-trash", L("Group.Remove"), L("Group.RemoveTip"))}
      </div>`;
  }

  /** The GM's bar for ticked cards: put them in a group, mark them met, archive or bring back. */
  bulkBar(listed) {
    if (!this.isGM || !this.state.selecting) return "";
    // Ticks on people no longer here are dropped.
    for (const id of this.state.selected) if (!game.actors.get(id)) this.state.selected.delete(id);
    const n = this.state.selected.size;
    const b = (op, label, disabled = !n) => `<button type="button" data-action="npaBulk" data-op="${op}" ${disabled ? "disabled" : ""}>${esc(label)}</button>`;
    const groups = `<select name="npaBulkGroup" aria-label="${esc(L("Bulk.GroupLabel"))}"><option value="">${esc(L("Group.None"))}</option>${this.ctx.groups.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join("")}</select>`;
    return `<div class="npa-bulk" role="group" aria-label="${esc(L("Bulk.Label"))}"><strong>${esc(L("Bulk.Count", { n }))}</strong>
        ${b("all", L("Bulk.All", { n: this.drawn(listed).length }), !listed.length)}
        ${groups}${b("group", L("Bulk.PutInGroup"))}
        ${b("met", L("Bulk.Met"))}${b("archive", L("Bulk.Archive"))}${b("restore", L("Bulk.Restore"))}${b("clear", L("Bulk.Clear"))}
      </div>`;
  }

  async _renderHTML() {
    this._ctx = null;
    clearGroupCache();
    const v = this.state.view;
    const all = this.base();
    // A group view that's gone (renamed, emptied, or one a player no longer sees) falls back to Everyone.
    const g = v.startsWith("group:") ? v.slice(6) : null;
    if (g !== null && !(this.isGM ? this.ctx.groups.includes(g) : all.some(({ r }) => r.group === g && !r.archived))) this.state.view = "all";
    if (!this.isGM && v === "archived" && !all.some(({ r }) => r.archived)) this.state.view = "all";
    if (!this.isGM && v === "none" && !all.some(({ r }) => !r.archived && !r.group)) this.state.view = "all";
    const el = document.createElement("div");
    el.className = "npa";
    const listed = this.people(all);
    const met = listed.filter(({ r }) => r.met);
    const unmet = listed.filter(({ r }) => !r.met);
    const pressed = (on) => ` aria-pressed="${on ? "true" : "false"}"`;
    const filters = [{ id: "all", get label() { return L("Filter.All"); } }, ...ATTITUDES, UNKNOWN]
      .map((a) => `<button type="button" class="npa-pill" data-action="npaFilter" data-id="${a.id}"${pressed(this.state.filter === a.id)}>${a.icon ? `<i class="fa-regular ${a.icon}" aria-hidden="true"></i> ` : ""}${esc(a.label)}</button>`)
      .join("");
    const chip = (id, label, tip) => `<button type="button" class="npa-pill" data-action="npaChip" data-chip="${id}"${pressed(this.state[id])}${tipAttr(tip)}>${esc(label)}</button>`;
    const gm = this.isGM
      ? `<div class="npa-gm">
          <div class="npa-filters" role="group" aria-label="${esc(L("Chips.Label"))}">${chip("metOnly", L("Chips.MetOnly"), L("Chips.MetOnlyTip"))}${this.ctx.scopes.length ? chip("cast", L("Chips.Cast"), L("Chips.CastTip")) : ""}${chip("selecting", L("Chips.Select"), L("Chips.SelectTip"))}</div>
          <button type="button" data-action="npaMarkSelected"><i class="fa-solid fa-user-plus" aria-hidden="true"></i> ${esc(L("MarkSelected"))}</button>
        </div>`
      : "";
    const anyone = all.length > 0;
    const empty = !anyone ? (this.isGM && this.state.metOnly ? L("Empty.GMMetOnly") : L("Empty.Player")) : L("Empty.NoOne");
    const cards = met.length ? met.map((p) => this.#card(p)).join("") : !unmet.length ? `<p class="npa-empty">${esc(empty)}</p>` : "";
    const recent = this.state.sort === "recent";
    const sort = `<button type="button" class="npa-sort" data-action="npaSort"${tipAttr(L(recent ? "Sort.RecentTip" : "Sort.NameTip"))}><i class="fa-solid ${recent ? "fa-clock-rotate-left" : "fa-arrow-down-a-z"}" aria-hidden="true"></i> ${esc(L(recent ? "Sort.Recent" : "Sort.Name"))}</button>`;
    el.innerHTML = `<header class="npa-head">
        <input type="search" name="npaSearch" placeholder="${esc(L("Search"))}" aria-label="${esc(L("Search"))}" value="${esc(this.state.search)}">${sort}
        <div class="npa-filters" role="group" aria-label="${esc(L("Filter.Label"))}">${filters}</div>
        ${gm}
      </header>
      <div class="npa-main-row">${this.sidebar(all)}<section class="npa-body" data-focus-pane="cards" data-focus-start data-focus-home tabindex="-1" data-keep-scroll="body" aria-label="${esc(L("Title"))}">${this.groupBar(listed)}${this.bulkBar(listed)}<div class="npa-cards">${cards}</div>${this.#unmet(unmet)}</section></div>`;
    return el;
  }

  /** The unmet, as one line each with a Met box; a line opens into its full card. */
  #unmet(list) {
    if (!this.isGM || !list.length) return "";
    const shown = this.drawnUnmet(list);
    const rows = shown.map(({ actor, r }) => {
      if (this.state.expanded.has(actor.id) || actor.id === this.state.include) {
        return `<li class="npa-unmet-open"><button type="button" class="npa-plain" data-action="npaExpand" data-id="${actor.id}" aria-expanded="true">${esc(L("Unmet.Fold"))}</button>${this.#card({ actor, r })}</li>`;
      }
      const name = knownName(actor, r);
      const real = actor.name !== name ? ` <span class="npa-real">${esc(actor.name)}</span>` : "";
      return `<li class="npa-unmet-row">
          ${this.#selectBox(actor, name)}
          <label class="npa-met"><input type="checkbox" data-action="npaMet" data-id="${actor.id}" aria-label="${esc(L("Unmet.MetLabel", { name }))}"> ${esc(L("Card.Met"))}</label>
          <span class="npa-unmet-name">${esc(name)}${real}</span>
          ${r.group ? `<span class="npa-where"><i class="fa-solid fa-folder" aria-hidden="true"></i> ${esc(r.group)}</span>` : ""}
          <button type="button" class="npa-plain" data-action="npaExpand" data-id="${actor.id}" aria-expanded="false">${esc(L("Unmet.Open"))}</button>
        </li>`;
    }).join("");
    const more = list.length > shown.length ? `<p class="npa-empty">${esc(L("Unmet.More", { n: list.length - shown.length }))}</p>` : "";
    return `<section class="npa-unmet"><h4>${esc(L("Unmet.Heading", { n: list.length }))}</h4><ul class="npa-unmet-list">${rows}</ul>${more}</section>`;
  }

  /** The unmet lines drawn: the first ones, with the NPC the window was opened on first of all. */
  drawnUnmet(list) {
    const inc = this.state.include;
    const first = inc ? list.filter(({ actor }) => actor.id === inc) : [];
    return [...first, ...list.filter(({ actor }) => actor.id !== inc)].slice(0, UNMET_MAX);
  }

  /** What's drawn: every met card in the view, and the unmet lines drawn. */
  drawn(listed = this.people()) {
    return [...listed.filter(({ r }) => r.met), ...this.drawnUnmet(listed.filter(({ r }) => !r.met))];
  }

  /** A card's tick box in select mode. */
  #selectBox(actor, name) {
    if (!this.isGM || !this.state.selecting) return "";
    return `<input type="checkbox" class="npa-select" data-select="${actor.id}" ${this.state.selected.has(actor.id) ? "checked" : ""} aria-label="${esc(L("Bulk.SelectOne", { name }))}">`;
  }

  #card({ actor, r }) {
    const shown = shownAttitude(r);
    const nameText = knownName(actor, r);
    const name = esc(nameText);
    const img = esc(playerImg(actor, r));
    const notes = this.#notes(actor, r);
    // Where a card sits, when the view doesn't say it already: its group, and Archived.
    const v = this.state.view;
    const searching = !!this.state.search.trim();
    const where = [
      r.group && (v !== `group:${r.group}` || searching) ? `<span class="npa-where"><i class="fa-solid fa-folder" aria-hidden="true"></i> ${esc(r.group)}</span>` : "",
      r.archived && (v !== "archived" || searching) ? `<span class="npa-where"><i class="fa-solid fa-box-archive" aria-hidden="true"></i> ${esc(L("Side.Archived"))}</span>` : "",
    ].join("");
    const impress = r.met && !r.archived && this.ctx.impress ? `<button type="button" data-action="npaImpress" data-id="${actor.id}"${tipAttr(L("Impression.ButtonTip"))}><i class="fa-solid fa-handshake" aria-hidden="true"></i> ${esc(L("Impression.Button"))}</button>` : "";
    if (!this.isGM) {
      return `<article class="npa-card att-${shown.id} ${r.archived ? "npa-archived" : ""}" data-card="${actor.id}">
          <img src="${img}" alt="${name}" role="button" tabindex="0" data-action="npaPicture" data-id="${actor.id}"${labelAttr(L("Card.SeePicture"))}>
          <div class="npa-main">
            <h3>${name}</h3>${where ? `<div class="npa-wheres">${where}</div>` : ""}
            <div class="npa-att"><i class="fa-regular ${shown.icon}" aria-hidden="true"></i> ${esc(shown.label)}</div>
            ${this.#overrides(shownOverrides(r, this.ctx.party))}
            ${r.blurb ? `<p class="npa-blurb">${esc(r.blurb)}</p>` : ""}
            ${impress ? `<div class="npa-row">${impress}</div>` : ""}
            ${notes}
          </div>
        </article>`;
    }
    const general = generalAttitude(r);
    const truth = attitude(general.id) ?? UNKNOWN;
    const ga = r.group ? groupAttitude(r.group) : null;
    const notSet = ga ? L("Card.NotSetGroup", { attitude: attitudeLabel(ga.id) }) : L("Card.NotSet");
    const realName = actor.name !== nameText ? `<span class="npa-real"${tipAttr(L("Card.RealNameTip"))}>${esc(actor.name)}</span>` : "";
    const edit = this.state.openEdit.has(actor.id) ? "open" : "";
    const flash = actor.id === this.state.scrollTo ? " npa-flash" : "";
    return `<article class="npa-card att-${truth.id} ${r.met ? "" : "npa-unmet"} ${r.archived ? "npa-archived" : ""}${flash}" data-card="${actor.id}">
        ${this.#selectBox(actor, nameText)}
        <img src="${img}" alt="${name}" role="button" tabindex="0" data-action="npaOpen" data-id="${actor.id}" draggable="true" data-drag-npc="${actor.id}"${labelAttr(L("Card.PortraitTip"))}>
        <div class="npa-main">
          <h3>${name} ${realName}</h3>${where ? `<div class="npa-wheres">${where}</div>` : ""}
          <div class="npa-row">
            <label>${esc(L("Card.Attitude"))} <select data-field="attitude" data-id="${actor.id}">${attitudeOptions(r.attitude ?? "", [{ id: "", label: notSet }])}</select></label>
            <label${tipAttr(L("Card.PlayersSeeTip"))}>${esc(L("Card.PlayersSee"))} <select data-field="shown" data-id="${actor.id}">${attitudeOptions(r.shown, [{ id: "same", label: L("Card.Same") }, UNKNOWN])}</select></label>
            <label class="npa-met"><input type="checkbox" data-action="npaMet" data-id="${actor.id}" ${r.met ? "checked" : ""}> ${esc(L("Card.Met"))}</label>
            <button type="button" data-action="npaAnnounce" data-id="${actor.id}"${tipAttr(L("Card.AnnounceTip"))}><i class="fa-solid fa-bullhorn" aria-hidden="true"></i> ${esc(L("Card.Announce"))}</button>
            ${impress}
          </div>
          ${this.#sceneLine(actor, r)}
          ${r.shown !== "same" && r.met ? `<div class="npa-att npa-shown">${esc(L("Card.PlayersSeeLine", { attitude: shown.label }))}${Object.keys(r.pcs).length ? esc(L("Card.NoPerCharacter")) : ""}</div>` : ""}
          ${this.#perCharacter(actor, r)}
          ${this.#history(actor, r)}
          <input type="text" data-field="blurb" data-id="${actor.id}" value="${esc(r.blurb)}" placeholder="${esc(L("Card.BlurbPlaceholder"))}" aria-label="${esc(L("Card.BlurbLabel"))}">
          ${notes}
          <details class="npa-edit" data-fold="edit" data-id="${actor.id}" ${edit}><summary>${esc(L("Card.Edit"))}</summary>
            <div class="npa-row npa-ident">
              <label class="npa-group"${tipAttr(L("Card.GroupTip"))}>${esc(L("Card.Group"))} <select data-field="group" data-id="${actor.id}">${this.#groupOptions(r.group)}</select></label>
            </div>
            <div class="npa-row npa-ident">
              <label${tipAttr(L("Card.KnownAsTip"))}>${esc(L("Card.KnownAs"))} <input type="text" data-field="knownAs" data-id="${actor.id}" value="${esc(r.knownAs)}" placeholder="${esc(actor.prototypeToken?.name?.trim() || actor.name)}"></label>
              <button type="button" data-action="npaReveal" data-id="${actor.id}"${tipAttr(L("Card.RevealTip"))}><i class="fa-solid fa-id-card" aria-hidden="true"></i> ${esc(L("Card.Reveal"))}</button>
            </div>
            <div class="npa-row npa-ident">
              <label${tipAttr(L("Card.PortraitFieldTip"))}>${esc(L("Card.Portrait"))} <input type="text" data-field="portrait" data-id="${actor.id}" value="${esc(r.portrait)}" placeholder="${esc(playerImg(actor, { ...r, portrait: "" }))}"></label>
              <button type="button" data-action="npaPickPortrait" data-id="${actor.id}"${labelAttr(L("Card.PickImage"))}><i class="fa-solid fa-file-image" aria-hidden="true"></i></button>
            </div>
            <div class="npa-row">
              <button type="button" data-action="npaArchive" data-id="${actor.id}"${tipAttr(L(r.archived ? "Card.BringBackTip" : "Card.ArchiveTip"))}><i class="fa-solid ${r.archived ? "fa-box-open" : "fa-box-archive"}" aria-hidden="true"></i> ${esc(L(r.archived ? "Card.BringBack" : "Card.Archive"))}</button>
            </div>
          </details>
        </div>
      </article>`;
  }

  /** Attitudes held for this scene only, with a way to clear them. GM only. */
  #sceneLine(actor, r) {
    const parts = [];
    if (r.scene.attitude) parts.push(L("Scene.Party", { attitude: attitudeLabel(r.scene.attitude) }));
    for (const [pcId, id] of Object.entries(r.scene.pcs)) {
      const pc = game.actors.get(pcId);
      if (pc) parts.push(L("Scene.Toward", { attitude: attitudeLabel(id), pc: pcName(pc) }));
    }
    if (!parts.length) return "";
    return `<div class="npa-scene"><i class="fa-solid fa-hourglass-half" aria-hidden="true"></i> ${esc(L("Scene.Line", { list: parts.join(", ") }))}
        <button type="button" class="npa-plain" data-action="npaClearScene" data-id="${actor.id}"${tipAttr(L("Scene.ClearTip"))}>${esc(L("Scene.Clear"))}</button></div>`;
  }

  /** When they were met, and the attitude changes with their reasons; the latest reason can be written here. GM only. */
  #history(actor, r) {
    const met = r.met && r.metAt !== null ? gameDate(r.metAt) : "";
    if (!r.history.length && !met) return "";
    const whoFor = (e) => (e.pc ? pcName(game.actors.get(e.pc) ?? { name: "?" }) : L("History.Party"));
    const line = (e) => {
      const real = e.at ? new Date(e.at).toLocaleString() : "";
      const when = gameDate(e.wt) || real;
      const name = (id) => (id ? attitudeLabel(id) : L("Card.NotSet"));
      const text = L("History.Entry", { when, from: name(e.from), to: name(e.to), who: whoFor(e) });
      return `<span${real ? tipAttr(L("History.RealTime", { real })) : ""}>${esc(text)}</span>${e.why ? ` <em>${esc(e.why)}</em>` : ""}`;
    };
    const last = r.history.at(-1);
    const summary = last ? line(last) : esc(L("History.MetOn", { when: met }));
    const items = [...r.history].reverse().map((e) => `<li>${line(e)}${e.at ? ` <span class="npa-hist-real">(${esc(L("History.RealTime", { real: new Date(e.at).toLocaleString() }))})</span>` : ""}</li>`).join("");
    const open = this.state.openHist.has(actor.id) ? "open" : "";
    const why = last ? `<label class="npa-why">${esc(L("History.Why"))} <input type="text" data-field="why" data-id="${actor.id}" value="${esc(last.why)}" maxlength="${WHY_LEN}" placeholder="${esc(L("History.WhyPlaceholder"))}"></label>` : "";
    return `<details class="npa-hist" data-fold="hist" data-id="${actor.id}" ${open}><summary>${esc(L("History.Label"))}: <span>${summary}</span></summary>
        ${why}${items ? `<ol class="npa-hist-list">${items}</ol>` : ""}${met ? `<p class="npa-hist-met">${esc(L("History.MetOn", { when: met }))}</p>` : ""}
      </details>`;
  }

  #overrides(list) {
    if (!list.length) return "";
    return `<div class="npa-pcs">${list.map(({ pc, a }) => `<span class="npa-pc att-${a.id}"><i class="fa-regular ${a.icon}" aria-hidden="true"></i> ${esc(L("Card.Toward", { attitude: a.label, pc: pcName(pc) }))}</span>`).join("")}</div>`;
  }

  #perCharacter(actor, r) {
    const pcs = this.ctx.party;
    if (!pcs.length) return "";
    const set = pcs.filter((pc) => attitude(r.pcs[pc.id]));
    const summary = set.length ? set.map((pc) => `${pcName(pc)}: ${attitudeLabel(r.pcs[pc.id])}`).join(", ") : L("Card.SameToEveryone");
    const rows = pcs.map((pc) => `<label>${esc(pcName(pc))} <select data-field="pc" data-pc="${pc.id}" data-id="${actor.id}">${attitudeOptions(r.pcs[pc.id] ?? "", [{ id: "", label: L("Card.AsAbove") }])}</select></label>`).join("");
    const open = this.state.openPer.has(actor.id) ? "open" : "";
    return `<details class="npa-per" data-fold="per" data-id="${actor.id}" ${open}><summary>${esc(L("Card.TowardEach"))} <span>${esc(summary)}</span></summary><div class="npa-per-grid">${rows}</div></details>`;
  }

  /** Party notes: one line per entry, newest last, with who wrote it. */
  #notes(actor, r) {
    const items = r.notes.map((e) => {
      const who = e.by ? game.users.get(e.by)?.name ?? L("Notes.Someone") : L("Notes.Party");
      const when = e.at ? new Date(e.at).toLocaleDateString() : "";
      const mine = this.isGM || (e.by && e.by === game.user.id);
      const del = mine ? ` <button type="button" class="npa-plain npa-note-del" data-action="npaDeleteNote" data-id="${actor.id}" data-note="${esc(e.id ?? "")}" data-at="${esc(e.at ?? "")}" data-by="${esc(e.by ?? "")}"${labelAttr(L("Notes.Remove"))}><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>` : "";
      return `<li><strong${when ? tipAttr(when) : ""}>${esc(who)}</strong> ${esc(e.text)}${del}</li>`;
    }).join("");
    return `<div class="npa-notes"><span>${esc(L("Notes.Heading"))}</span>${items ? `<ul class="npa-note-list">${items}</ul>` : ""}
      <div class="npa-note-add"><input type="text" name="npaNote" data-id="${actor.id}" data-focus-key="note-${actor.id}" placeholder="${esc(L("Notes.Placeholder"))}" aria-label="${esc(L("Notes.AddLabel", { name: knownName(actor, r) }))}"><button type="button" data-action="npaAddNote" data-id="${actor.id}"${labelAttr(L("Notes.Add"))}><i class="fa-solid fa-plus" aria-hidden="true"></i></button></div></div>`;
  }

  _replaceHTML(result, content) {
    // Keep the scroll position across re-renders.
    const top = content.querySelector(".npa-body")?.scrollTop ?? 0;
    const sideTop = content.querySelector(".npa-side")?.scrollTop ?? 0;
    content.replaceChildren(result);
    const body = content.querySelector(".npa-body");
    if (body) body.scrollTop = top;
    const side = content.querySelector(".npa-side");
    if (side) side.scrollTop = sideTop;
  }

  _onFirstRender() {
    // The GM drags a card by its portrait onto a sidebar row: a group or No group (bringing back an archived NPC), Everyone (bring back) or Archived.
    this.element.addEventListener("dragstart", (ev) => {
      const row = ev.target.closest?.("[data-drag-group]");
      if (row && game.user.isGM) {
        ev.dataTransfer.setData(GROUP_DRAG, row.dataset.dragGroup);
        ev.dataTransfer.effectAllowed = "move";
        return;
      }
      const img = ev.target.closest?.("[data-drag-npc]");
      if (!img || !game.user.isGM) return;
      ev.dataTransfer.setData(NPC_DRAG, img.dataset.dragNpc);
      ev.dataTransfer.effectAllowed = "move";
    });
    const zoneOf = (ev) => (ev.dataTransfer?.types?.includes(NPC_DRAG) ? ev.target.closest?.("[data-drop-view]") : null);
    // A group row dragged over another goes before it, or after it when over its lower half.
    const slotOf = (ev) => {
      const row = ev.dataTransfer?.types?.includes(GROUP_DRAG) ? ev.target.closest?.("[data-drag-group]") : null;
      if (!row) return null;
      const box = row.getBoundingClientRect();
      return { row, after: ev.clientY > box.top + box.height / 2 };
    };
    const clearSlot = () => this.element.querySelectorAll(".npa-drop-before, .npa-drop-after").forEach((el) => el.classList.remove("npa-drop-before", "npa-drop-after"));
    this.element.addEventListener("dragover", (ev) => {
      const slot = slotOf(ev);
      if (slot) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "move";
        clearSlot();
        slot.row.classList.add(slot.after ? "npa-drop-after" : "npa-drop-before");
        return;
      }
      clearSlot();
      const zone = zoneOf(ev);
      if (!zone) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
      if (this._dropZone !== zone) {
        this._dropZone?.classList.remove("npa-drop-over");
        zone.classList.add("npa-drop-over");
        this._dropZone = zone;
      }
    });
    this.element.addEventListener("dragleave", (ev) => {
      if (!this.element.contains(ev.relatedTarget)) clearSlot();
      if (this._dropZone && !this._dropZone.contains(ev.relatedTarget)) {
        this._dropZone.classList.remove("npa-drop-over");
        this._dropZone = null;
      }
    });
    this.element.addEventListener("dragend", () => {
      clearSlot();
      this._dropZone?.classList.remove("npa-drop-over");
      this._dropZone = null;
    });
    this.element.addEventListener("drop", async (ev) => {
      this._dropZone?.classList.remove("npa-drop-over");
      this._dropZone = null;
      const slot = slotOf(ev);
      clearSlot();
      if (slot) {
        ev.preventDefault();
        return moveGroup(ev.dataTransfer.getData(GROUP_DRAG), slot.row.dataset.dragGroup, slot.after);
      }
      const zone = zoneOf(ev);
      if (!zone) return;
      ev.preventDefault();
      const actor = game.actors.get(ev.dataTransfer.getData(NPC_DRAG));
      if (!actor || !game.user.isGM) return;
      const view = zone.dataset.dropView;
      if (view === "archived" || view === "all") return record(actor).archived === (view === "archived") ? undefined : setArchived(actor, view === "archived");
      if (view !== "none" && !view.startsWith("group:")) return;
      const group = view === "none" ? "" : view.slice(6);
      if (!record(actor).archived) return setGroup(actor, group);
      return update(actor, { group: canonicalGroup(group), archived: false });
    });
    // Folds remember being open across redraws; tick boxes in select mode keep their own list.
    this.element.addEventListener("toggle", (ev) => {
      const d = ev.target;
      const set = { per: this.state.openPer, edit: this.state.openEdit, hist: this.state.openHist }[d?.dataset?.fold];
      if (set) d.open ? set.add(d.dataset.id) : set.delete(d.dataset.id);
    }, true);
    this.element.addEventListener("change", (ev) => {
      const box = ev.target.closest?.("input[data-select]");
      if (!box) return;
      box.checked ? this.state.selected.add(box.dataset.select) : this.state.selected.delete(box.dataset.select);
      const count = this.element.querySelector(".npa-bulk strong");
      if (count) count.textContent = L("Bulk.Count", { n: this.state.selected.size });
      this.element.querySelectorAll(".npa-bulk button[data-op]").forEach((b) => b.dataset.op !== "all" && (b.disabled = !this.state.selected.size));
    });
  }

  _onRender() {
    // The field a deferred refresh waited on is gone with this redraw.
    this._deferred = false;
    const search = this.element.querySelector("input[name=npaSearch]");
    search?.addEventListener("input", (e) => {
      this.state.search = e.target.value;
      this.state.include = null;
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => this.render(), 250);
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
    // Opened on a card (the Token HUD): bring it into view once. It stays listed until the view changes.
    if (this.state.scrollTo) {
      const card = this.element.querySelector(`[data-card="${this.state.scrollTo}"]`);
      card?.scrollIntoView({ block: "center" });
      card?.querySelector("select[data-field=attitude]")?.focus();
      this.state.scrollTo = null;
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
    if (field === "why") return setLatestWhy(actor, target.value);
    if (field === "group") {
      if (!target.selectedOptions[0]?.dataset.new) return setGroup(actor, target.value);
      const name = await PeopleApp.#askName(L("Side.NewGroup"), L("Group.Name"));
      const group = name === null ? "" : await addGroup(name);
      if (group) return setGroup(actor, group);
      target.value = record(actor).group;
    }
  }

  /** The Group menu: no group, every group in the GM's order, then a way to make a new one. */
  #groupOptions(current) {
    const names = [...this.ctx.groups];
    if (current && !names.includes(current)) names.push(current);
    const opt = (value, label) => `<option value="${esc(value)}" ${value === current ? "selected" : ""}>${esc(label)}</option>`;
    return `${opt("", L("Group.None"))}${names.map((g) => opt(g, g)).join("")}<option value="" data-new="1">${esc(L("Group.New"))}</option>`;
  }

  async #submitNote(input) {
    const actor = game.actors.get(input.dataset.id);
    const text = input.value.trim();
    if (!actor || !text) return;
    if (await addNote(actor, text)) input.value = "";
  }

  static #onFilter(event, target) {
    this.state.filter = target.dataset.id;
    this.state.include = null;
    this.render();
  }

  static #onGoTo(event, target) {
    this.state.view = target.dataset.view;
    this.state.include = null;
    if (this.state.search) this.state.search = "";
    saveChips(this.state);
    this.render();
  }

  static #onSort() {
    this.state.sort = this.state.sort === "recent" ? "name" : "recent";
    saveChips(this.state);
    this.render();
  }

  /** Ask for a group name; resolves to the text, or null when canceled. */
  static async #askName(title, label, value = "") {
    const out = await foundry.applications.api.DialogV2.prompt({
      window: { title },
      classes: ["npa-dialog"],
      content: `<label class="npa-ask">${esc(label)} <input type="text" name="name" value="${esc(value)}" maxlength="${GROUP_MAX}" autofocus></label>`,
      ok: { label: L("Save"), callback: (ev, button) => button.form.elements.name.value },
      rejectClose: false,
    });
    return typeof out === "string" ? out : null;
  }

  static async #onNewGroup() {
    const name = await PeopleApp.#askName(L("Side.NewGroup"), L("Group.Name"));
    if (name === null) return;
    const group = await addGroup(name);
    if (group) {
      this.state.view = `group:${group}`;
      saveChips(this.state);
      this.render();
    }
  }

  static async #onShiftGroup(event, target) {
    await shiftGroup(this.state.view.slice(6), Number(target.dataset.by) || 0);
  }

  /** The open group's attitude: its own, or the reputation it follows with an attitude for each tier. */
  static async #onGroupAttitude() {
    const name = this.state.view.slice(6);
    const info = groupInfo(name);
    const reps = reputations();
    const tierRows = (rep) => {
      if (!rep) return "";
      const guess = tierGuess(rep.tiers);
      const now = currentTier(rep);
      return [...rep.tiers].reverse().map((t) => `<label class="npa-ask"><span>${esc(t.label)}${t.id === now?.id ? ` <em>${esc(L("GroupDialog.Now"))}</em>` : ""}</span> <select name="tier:${esc(t.id)}">${attitudeOptions(info.tracker === rep.id ? info.tiers[t.id] ?? guess[t.id] : guess[t.id])}</select></label>`).join("");
    };
    const missing = info.tracker && !reps.some((t) => t.id === info.tracker) ? `<option value="${esc(info.tracker)}" selected>${esc(L("GroupDialog.Missing"))}</option>` : "";
    const repOptions = missing + reps.map((t) => `<option value="${esc(t.id)}" ${t.id === info.tracker ? "selected" : ""}>${esc(t.name)}</option>`).join("");
    const trackerPart = trackersApi()
      ? `<label class="npa-ask">${esc(L("GroupDialog.Follow"))} <select name="tracker"><option value="">${esc(L("GroupDialog.NoTracker"))}</option>${repOptions}</select></label>
         <p class="npa-hint">${esc(L("GroupDialog.TierHint"))}</p><div class="npa-tiers">${tierRows(reps.find((t) => t.id === info.tracker))}</div>`
      : `<p class="npa-hint">${esc(L("GroupDialog.NoTrackers"))}</p>`;
    const content = `<p class="npa-hint">${esc(L("GroupDialog.Hint"))}</p>
      <label class="npa-ask">${esc(L("GroupDialog.Own"))} <select name="attitude">${attitudeOptions(info.attitude ?? "", [{ id: "", label: L("Card.NotSet") }])}</select></label>
      ${trackerPart}`;
    const out = await foundry.applications.api.DialogV2.wait({
      window: { title: L("GroupDialog.Title", { name }) },
      position: { width: 460 },
      classes: ["npa-dialog"],
      content,
      render: (event, dialog) => {
        // Picking another reputation redraws its tiers, each with its first guess.
        const root = dialog.element ?? dialog;
        const pick = root.querySelector("select[name=tracker]");
        pick?.addEventListener("change", () => {
          root.querySelector(".npa-tiers").innerHTML = tierRows(reps.find((t) => t.id === pick.value));
        });
      },
      buttons: [
        { action: "save", label: L("Save"), default: true, callback: (ev, button) => {
          const f = button.form;
          const picked = f.elements.tracker ? f.elements.tracker.value : info.tracker;
          const boxes = [...f.querySelectorAll("select[name^='tier:']")];
          // No reputation to read (Trackers off, or the tracker gone): the link and its tiers are kept as they were.
          const tiers = boxes.length ? Object.fromEntries(boxes.map((s) => [s.name.slice(5), s.value])) : picked === info.tracker ? info.tiers : {};
          return { attitude: f.elements.attitude.value || null, tracker: picked, tiers };
        } },
        { action: "cancel", label: L("Cancel") },
      ],
      rejectClose: false,
    });
    if (!out || typeof out !== "object") return;
    await setGroupInfo(name, out.attitude || out.tracker ? out : null);
  }

  static async #onRenameGroup() {
    const from = this.state.view.slice(6);
    const name = await PeopleApp.#askName(L("Group.RenameTitle"), L("Group.Name"), from);
    if (name === null) return;
    const to = cleanGroup(name);
    if (!to || to === from) return;
    const into = groupNames().find((g) => g !== from && g.toLowerCase() === to.toLowerCase());
    if (into) {
      const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: L("Group.RenameTitle") }, content: `<p>${L("Group.MergeAsk", { to: `<strong>${esc(into)}</strong>`, from: `<strong>${esc(from)}</strong>` })}</p>` });
      if (!ok) return;
    }
    const done = await renameGroup(from, to);
    this.state.view = `group:${done || from}`;
    saveChips(this.state);
    this.render();
  }

  static async #onArchiveGroup() {
    const name = this.state.view.slice(6);
    const n = groupMembers(name).filter((a) => !record(a).archived).length;
    const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: L("Group.ArchiveTitle") }, content: `<p>${L("Group.ArchiveAsk", { n, name: `<strong>${esc(name)}</strong>` })}</p>` });
    if (ok) await archiveGroup(name, true);
  }

  static async #onRestoreGroup() {
    await archiveGroup(this.state.view.slice(6), false);
  }

  static async #onRemoveGroup() {
    const name = this.state.view.slice(6);
    const n = groupMembers(name).length;
    const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: L("Group.RemoveTitle") }, content: `<p>${L(n ? "Group.RemoveAskPeople" : "Group.RemoveAsk", { n, name: `<strong>${esc(name)}</strong>` })}</p>` });
    if (!ok) return;
    await removeGroup(name);
    this.state.view = "all";
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
    this.state.include = null;
    if (id === "selecting" && !this.state.selecting) this.state.selected.clear();
    saveChips(this.state);
    this.render();
  }

  static async #onMarkSelected() {
    if (!selectedNPCs().seen.size) return markSelected();
    // Offer the existing groups; leaving it as is keeps each one's group.
    const names = groupNames();
    let group;
    if (names.length) {
      const n = selectedNPCs().seen.size;
      const pick = await foundry.applications.api.DialogV2.wait({
        window: { title: L("MarkDialog.Title") },
        classes: ["npa-dialog"],
        content: `<label class="npa-ask">${esc(L(n === 1 ? "MarkDialog.PutOne" : "MarkDialog.PutMany", { n }))} <select name="group"><option value="k">${esc(L("MarkDialog.Keep"))}</option><option value="n">${esc(L("MarkDialog.None"))}</option>${names.map((g) => `<option value="g:${esc(g)}">${esc(g)}</option>`).join("")}</select></label>`,
        buttons: [
          { action: "ok", label: L("MarkDialog.Ok"), icon: "fa-solid fa-user-plus", default: true, callback: (ev, button) => ({ choice: button.form.elements.group.value }) },
          { action: "cancel", label: L("Cancel") },
        ],
        rejectClose: false,
      });
      if (!pick || typeof pick !== "object") return;
      if (pick.choice === "n") group = "";
      else if (pick.choice.startsWith("g:")) group = pick.choice.slice(2);
    }
    await markSelected({ group });
  }

  static async #onMet(event, target) {
    const actor = game.actors.get(target.dataset.id);
    if (actor) await markMet(actor, target.checked);
  }

  static #onOpen(event, target) {
    game.actors.get(target.dataset.id)?.sheet?.render({ force: true });
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

  static async #onImpress(event, target) {
    await makeImpression(game.actors.get(target.dataset.id));
  }

  static async #onClearScene(event, target) {
    const actor = game.actors.get(target.dataset.id);
    if (actor) await clearScene(actor);
  }

  static async #onReveal(event, target) {
    const actor = game.actors.get(target.dataset.id);
    if (actor) await reveal(actor);
  }

  static #onPickPortrait(event, target) {
    const actor = game.actors.get(target.dataset.id);
    if (!actor) return;
    new (FP())({
      type: "image",
      current: record(actor).portrait || playerImg(actor),
      callback: (path) => update(actor, { portrait: path }),
    }).render({ force: true });
  }

  static async #onAddNote(event, target) {
    const input = this.element.querySelector(`input[name=npaNote][data-id="${target.dataset.id}"]`);
    if (input) await this.#submitNote(input);
  }

  static async #onDeleteNote(event, target) {
    const actor = game.actors.get(target.dataset.id);
    if (actor) await deleteNote(actor, { id: target.dataset.note || null, at: target.dataset.at, by: target.dataset.by });
  }

  /** An unmet line opened into its card (or closed again). */
  static #onExpand(event, target) {
    const id = target.dataset.id;
    if (this.state.expanded.has(id) || this.state.include === id) {
      this.state.expanded.delete(id);
      if (this.state.include === id) this.state.include = null;
    } else this.state.expanded.add(id);
    this.render();
  }

  /** The bulk bar's buttons. */
  static async #onBulk(event, target) {
    const op = target.dataset.op;
    if (op === "all") {
      for (const { actor } of this.drawn()) this.state.selected.add(actor.id);
      return this.render();
    }
    if (op === "clear") {
      this.state.selected.clear();
      return this.render();
    }
    const actors = [...this.state.selected].map((id) => game.actors.get(id)).filter((a) => isNPC(a));
    if (!actors.length) return;
    if (op === "group") {
      const group = this.element.querySelector("select[name=npaBulkGroup]")?.value ?? "";
      await updateMany(actors, { group: group ? canonicalGroup(group) : "" });
    } else if (op === "met") await updateMany(actors.filter((a) => !record(a).met), (a) => metChanges(record(a), true));
    else if (op === "archive") await updateMany(actors, { archived: true });
    else if (op === "restore") await updateMany(actors, { archived: false });
    ui.notifications.info(L("Bulk.Done", { n: actors.length }));
  }

  /**
   * Open the window: { focus } puts focus in it (the hotkey); { on: actor } opens it on that NPC's card (the Token
   * HUD), shown whatever the view, chips and search say.
   */
  static async open({ focus = false, on = null } = {}) {
    const app = await people.open({ on });
    // Opened on a card, focus is already on its attitude (see _onRender).
    if ((focus || on) && !app.element?.contains(document.activeElement)) app.focusWindow?.();
    return app;
  }

  static openOn(actor) {
    return PeopleApp.open({ on: actor });
  }
}

/** Point the window at one NPC's card, when it is opened on one. */
function openOnCard(app, { on } = {}) {
  const actor = baseActor(on);
  if (!actor || !isNPC(actor)) return;
  const r = record(actor);
  Object.assign(app.state, { view: r.archived ? "archived" : "all", filter: "all", search: "", include: actor.id, scrollTo: actor.id });
  if (!r.met) app.state.expanded.add(actor.id);
}

/** The one People window. */
const people = singleWindow((opts) => {
  const app = new PeopleApp();
  openOnCard(app, opts);
  return app;
}, { reuse: openOnCard });

/* ------------------------------------------------------------------ */
/* Registration                                                       */
/* ------------------------------------------------------------------ */

Hooks.once("init", () => {
  game.settings.register(MOD, "announce", {
    name: "NPA.Settings.Announce.Name",
    hint: "NPA.Settings.Announce.Hint",
    scope: "world", config: true, type: String, default: "all",
    choices: { all: "NPA.Settings.Announce.All", gm: "NPA.Settings.Announce.GM", off: "NPA.Settings.Announce.Off" },
  });
  game.settings.register(MOD, "impressionPlayers", {
    name: "NPA.Settings.ImpressionPlayers.Name",
    hint: "NPA.Settings.ImpressionPlayers.Hint",
    scope: "world", config: true, type: Boolean, default: false, onChange: () => refresh(),
  });
  game.settings.register(MOD, "stockPortrait", {
    name: "NPA.Settings.StockPortrait.Name",
    hint: "NPA.Settings.StockPortrait.Hint",
    scope: "world", config: true, type: String, default: "token",
    choices: { token: "NPA.Settings.StockPortrait.Token", silhouette: "NPA.Settings.StockPortrait.Silhouette" },
    onChange: () => refresh(),
  });
  game.settings.register(MOD, "groups", {
    scope: "world", config: false, type: Array, default: [], onChange: () => refresh(),
  });
  game.settings.register(MOD, "groupInfo", {
    scope: "world", config: false, type: Object, default: {}, onChange: () => {
      clearGroupCache();
      refresh();
    },
  });
  game.settings.register(MOD, "castFlagScopes", {
    name: "NPA.Settings.CastScopes.Name",
    hint: "NPA.Settings.CastScopes.Hint",
    scope: "world", config: true, type: String, default: "", onChange: () => refresh(),
  });
  game.keybindings.register(MOD, "open", {
    name: "NPA.Keys.Open",
    editable: [{ key: "KeyP", modifiers: ["Alt"] }],
    onDown: () => {
      PeopleApp.open({ focus: true });
      return true;
    },
  });
});

Hooks.once("ready", () => {
  rules.load();
  game.socket.on(`module.${MOD}`, onSocketMessage);
  tabs.start();
  if (game.user.isGM) for (const a of game.actors) if (a.type === "npc") remember(a);
  clearGroupCache();
  publishGroupAttitudes().catch(console.error);
  game.modules.get(MOD).api = {
    open: () => PeopleApp.open(),
    openOn: (actor) => PeopleApp.openOn(actor),
    markMet, markSelected, setAttitude, setTowards, setSceneAttitude, clearScene, setKnownAs, reveal, revealSelected, announce, addNote, knownName,
    setGroup, setArchived, addGroup, renameGroup, removeGroup, archiveGroup, moveGroup, sortGroups,
    groupAttitude: (name) => groupAttitude(name),
    setGroupAttitude: (name, info) => setGroupInfo(name, info),
    makeImpression: (actor) => makeImpression(actor),
    history: (actor) => (game.user.isGM ? record(actor).history : []),
    groups: () => {
      if (game.user.isGM) return groupNames();
      const seen = new Set(game.actors.filter(isNPC).map((a) => record(a)).filter((r) => r.met && !r.archived && r.group).map((r) => r.group));
      return groupNames().filter((g) => seen.has(g));
    },
    record: (actor) => (game.user.isGM ? record(actor) : record(actor).met ? publicRecord(actor) : { met: false }),
  };
});

Hooks.on("updateActor", (actor, changes, options, userId) => {
  // An unlinked token's actor shares the world actor's id but holds its own copy: only world actors are guarded.
  if (actor.type === "npc" && !actor.isToken && changes?.flags !== undefined) guardRecord(actor, changes, userId).catch(console.error);
  if (changes.flags?.[MOD] || changes.prototypeToken !== undefined || changes.img !== undefined || changes.name !== undefined) refresh();
});
Hooks.on("createActor", (actor) => {
  if (actor.type !== "npc") return;
  if (game.user.isGM) remember(actor);
  refresh();
});
Hooks.on("deleteActor", (actor) => {
  if (actor.type !== "npc") return;
  knownRecords.delete(actor.id);
  refresh();
});
// A reputation moved, a tracker was added or removed, or Campaign Trackers finished loading: groups that follow one
// may have a new attitude, which the GM's lead tab publishes for players.
Hooks.on(`${TRACKERS}.ready`, () => (trackersReady = true));
for (const hook of [`${TRACKERS}.changed`, `${TRACKERS}.ready`]) {
  Hooks.on(hook, () => {
    clearGroupCache();
    publishGroupAttitudes().catch(console.error);
    refresh();
  });
}
Hooks.on("renderChatMessageHTML", onRenderMessage);

Hooks.on("getSceneControlButtons", (controls) => {
  const tools = controls.tokens?.tools;
  if (!tools) return;
  tools.npcAttitudes = {
    name: "npcAttitudes",
    title: "NPA.Title",
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
    label: "NPA.Context.Met",
    icon: '<i class="fa-solid fa-address-book"></i>',
    visible: (li) => game.user.isGM && isNPC(get(li)),
    onClick: (event, li) => {
      const a = get(li);
      if (a) markMet(a, !record(a).met);
    },
  });
});

/** The Token HUD: for the GM, a button that opens the People window on this NPC's card. */
Hooks.on("renderTokenHUD", (hud, html) => {
  if (!game.user.isGM) return;
  const actor = baseActor(hud.object?.actor ?? hud.document?.actor);
  if (!isNPC(actor)) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  const col = root?.querySelector(".col.left");
  if (!col || col.querySelector(".npa-hud")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "control-icon npa-hud";
  button.dataset.tooltipText = L("Hud.Open");
  button.setAttribute("aria-label", L("Hud.Open"));
  button.innerHTML = `<i class="fa-solid fa-address-book" aria-hidden="true"></i>`;
  button.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    PeopleApp.openOn(actor);
  });
  col.append(button);
});
