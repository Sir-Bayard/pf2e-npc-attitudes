PF2e NPC Attitudes 0.2.3
Foundry VTT 14, Pathfinder 2e system 8.0 or later.

WHAT IT DOES
Tracks how the people the party has met feel about them, using GM Core's
attitudes: Hostile, Unfriendly, Indifferent, Friendly and Helpful. The GM
sets each NPC's attitude and marks who the party has met. Players get a
read-only People window: portrait, the name they know the NPC by, the
attitude, a one-line description, and shared party notes they can add to.

INSTALL
Easiest: in Foundry, Install Module, then paste
  https://github.com/Sir-Bayard/pf2e-npc-attitudes/releases/latest/download/module.json
into Manifest URL. Or by hand:
1. Unzip module.zip (from the latest release) into a new folder Data/modules/pf2e-npc-attitudes, so you end up with
   Data/modules/pf2e-npc-attitudes/module.json.
2. Enable "PF2e NPC Attitudes" in Manage Modules and reload.

OPENING IT
Token controls on the left: the address-book icon at the bottom of the list.
Macro: game.modules.get("pf2e-npc-attitudes").api.open()

FOR THE GM
- Mark people as met: select their tokens and click "Mark selected tokens
  as met", or right-click an NPC in the Actors sidebar and choose
  "People: met / not met", or turn off the "Met only" chip in the window and
  tick Met on a card. Marking from a token whose name differs from the
  prototype token name fills in "Known as" with the token's name.
- Chips: "Met only" hides NPCs the party hasn't met; "Cast" shows only
  actors the campaign module marked as Cast (see the "Cast flag scopes"
  setting). Both are remembered in this browser.
- Attitude is the NPC's real attitude. "Players see" is what the party is
  shown: the same, a different attitude (someone hiding how they feel), or
  Unknown. The GM sees both.
- Setting Hostile when the NPC has tokens on the current scene that aren't
  Hostile asks whether to set those tokens' disposition to Hostile; Friendly
  or Helpful asks the same for Friendly. Nothing changes unless you say yes.
- "Toward each character" sets how the NPC feels about one character in
  particular, when it differs from their general attitude: Unfriendly to Valeros
  but Helpful to Kyra. Leave a character on "As above" to use the general
  attitude. Players see these as small tags under the attitude, but only
  while "Players see" is "The same"; an NPC hiding how they feel shows the
  players nothing about individual characters either.
- The one-line description is shown to players. Use it for who they are and
  where the party met them.
- Click a portrait to open the NPC's sheet.

NAMES AND PORTRAITS
Players see the "Known as" name; when it is empty, the actor's prototype
token name. The actor's own name is shown to the GM only, in small grey type
beside it. Players see the "Portrait" image; when it is empty, the prototype
token image, and failing that the actor image. Pick one with the image button
or type a path. The image's alt text is the known name, so a file named after
the real person doesn't show up as a tooltip.
Macros: api.setKnownAs(actor, "Brother Anselm") sets the name players see;
api.reveal(actor) sets it to the actor's real name.

ANNOUNCEMENTS
Nothing is posted to chat on its own. The Announce button on a GM card posts
what the players see of that NPC (name, attitude, per-character tags, the
one-line description). The "Announce to" setting says where it goes:
everyone, whispered to the GM, or nobody (the button then does nothing).

PARTY NOTES
Notes are a list of short entries, each with who wrote it, newest last. Any
player can add an entry and remove their own; the GM can remove any. A
player's entry is saved through the GM's client, so a GM has to be logged in.
At most 40 entries or 4000 characters per NPC; the oldest go first. A note
written with 0.2.1 or earlier appears as the first entry, with no author.

WHAT PLAYERS CAN READ
The real attitude and the "Players see" value live in the actor's flags,
which Foundry sends to every client. The window and the API only show
players the shown attitude, but a player who reads the actor in the console
can see the real one. Treat "Players see" as a courtesy, not a secret.

UPDATING
Replace the module folder in Data/modules with the new one and reload.
Attitudes and notes are kept.

WHERE THE DATA LIVES
On each NPC actor, in flags.pf2e-npc-attitudes.npc. Unlinked NPCs keep it
on the actor in the sidebar, not on individual tokens.

CHANGES
0.2.3
- The People window shows the actor's full portrait, cropped to a 96 x 120
  tile (top-anchored, so faces stay in frame), and a click opens the whole
  picture. The token is used only when the portrait is a stand-in's shipped
  art (under systems/pf2e or a Paizo token pack), which would name the real
  creature. A Portrait set on the record still comes first.
0.2.2 (from the 20 Oct review)
- Players see the record's portrait, else the prototype token image, else the
  actor image; it used to be the actor image, which for a stand-in stat block
  is the bestiary art. The GM sets the portrait on the card. The image's alt
  text is the known name, not the file name.
- "Known as" on the GM card: the name players see, falling back to the
  prototype token name. Marking a token as met fills it from the token's name
  when that differs. api.setKnownAs(actor, name) and api.reveal(actor).
- Chat lines are no longer posted when the GM marks someone met, changes an
  attitude or changes "Players see". The Announce button on the card posts
  what players see, to the audience in the "Announce to" setting.
- Party notes are entries with an author, newest last, instead of one text
  everyone overwrote. Players remove only their own; the GM any. Capped at 40
  entries or 4000 characters. An older note becomes the first entry.
- "Met only" and "Cast" chips in the GM window, remembered per browser. The
  "Show NPCs not met yet" checkbox became the "Met only" chip. New setting
  "Cast flag scopes" says which module's flags.<id>.cast marks an actor
  as Cast (the default, scarlet-dawn-gm, is the author's campaign module;
  list your own module ids, or leave it, it does nothing without that
  module).
- Setting Hostile, Friendly or Helpful offers to set the disposition of the
  NPC's tokens on the current scene to match. Never done without asking.
- api.record(actor) for a non-GM returns only what players are shown. The
  README says what players can still read from the actor's flags.
- Sidebar context menu registered once (the Foundry 13+ hook only); it was
  also registered under the old hook name.
- A window re-render no longer closes a select the GM has open, and waits
  again if the GM has moved to another field in the meantime.
- Marking selected tokens skips an unlinked token whose actor is gone, and
  says so, instead of writing to the token.
- A failed chat post is logged instead of becoming an unhandled rejection.
