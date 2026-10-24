# Changelog

## 0.2.5

- An NPC with a record here that the GM lends to a player (owner permission, say for a fight) stays in the People window with its attitude and notes. It used to drop out of the list until the permission was taken back. Player-owned NPCs with no record (summons, companions) still stay out.

## 0.2.4

- "Cast flag scopes" is empty by default, so the Cast chip does nothing until you name the module that marks your cast. A world that already had a value keeps it.

## 0.2.3

- The People window shows the actor's full portrait, cropped to a 96 x 120 tile (top-anchored, so faces stay in frame), and a click opens the whole picture. The token is used only when the portrait is a stand-in's shipped art (under systems/pf2e or a Paizo token pack), which would name the real creature. A Portrait set on the record still comes first.

## 0.2.2

- Players see the record's portrait, else the prototype token image, else the actor image; it used to be the actor image, which for a stand-in stat block is the bestiary art. The GM sets the portrait on the card. The image's alt text is the known name, not the file name.
- "Known as" on the GM card: the name players see, falling back to the prototype token name. Marking a token as met fills it from the token's name when that differs. `api.setKnownAs(actor, name)` and `api.reveal(actor)`.
- Chat lines are no longer posted when the GM marks someone met, changes an attitude or changes "Players see". The Announce button on the card posts what players see, to the audience in the "Announce to" setting.
- Party notes are entries with an author, newest last, instead of one text everyone overwrote. Players remove only their own; the GM any. Capped at 40 entries or 4000 characters. An older note becomes the first entry.
- "Met only" and "Cast" chips in the GM window, remembered per browser. The "Show NPCs not met yet" checkbox became the "Met only" chip. New setting "Cast flag scopes" says which module's `flags.<id>.cast` marks an actor as Cast (list your own module ids).
- Setting Hostile, Friendly or Helpful offers to set the disposition of the NPC's tokens on the current scene to match. Never done without asking.
- `api.record(actor)` for a non-GM returns only what players are shown. The README says what players can still read from the actor's flags.
- Sidebar context menu registered once (the Foundry 13+ hook only); it was also registered under the old hook name.
- A window re-render no longer closes a select the GM has open, and waits again if the GM has moved to another field in the meantime.
- Marking selected tokens skips an unlinked token whose actor is gone, and says so, instead of writing to the token.
- A failed chat post is logged instead of becoming an unhandled rejection.
