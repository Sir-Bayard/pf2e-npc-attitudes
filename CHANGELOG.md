# Changelog

## 2.0.0

New:
- **Make an Impression** from a card, rolled through the system's own action: up to five targets with one roll, each result against that NPC's Will DC, and an Apply panel on the chat card for the GM (two steps better on a critical success, one on a success, none on a failure, one worse on a critical failure), toward the character who rolled or the whole party, for this scene only or lasting. Players can roll it from their own cards when the GM allows it in the settings.
- **A group's own attitude**, taken by its members whose attitude is Not set. With PF2e Campaign Trackers on, a group can follow one of its reputations, each tier giving an attitude you choose (first guessed by its place).
- **Attitudes for this scene**, kept apart from the stored ones, shown on the card, with Clear (and a macro that clears them all).
- **History**: every change of attitude with its in-game date, toward whom and an optional reason; the date the party met them.
- **Unmet NPCs as one line each** with a Met box, opening into a full card, when Met only is off. The window draws many times faster with a large bestiary (about 530 ms to 30 ms with 150 NPCs in testing).
- **Keyboard**: every control works from the keyboard, focus stays put when the window redraws, and while focus is in the window its keys stay there (Space doesn't pause the game). Move up and Move down for a group, besides dragging. **Alt+P** opens the window.
- **Changing several at once**: the Select chip, then put the ticked cards in a group, mark them met, archive them or bring them back.
- **Token HUD** button (GM) that opens the window on that NPC's card.
- The card's Group, Known as, portrait and Archive fold under **Edit**; **Reveal name** there; a label on the sort button (A to Z or Recent).
- A setting to show a **silhouette** when an NPC's only art is art shipped with the system or a module.
- A **People: macros** compendium: open the window, mark the selected tokens as met, reveal their real names, clear every scene-only attitude.
- The attitude names come from the PF2e system, in its language; all the module's own text is in a language file.
- The Cast chip shows only when the Cast flag scopes setting names a module.

Fixes:
- Party notes are signed by whoever sends them. A player could add a note under someone else's name, or remove anyone's note, the GM's included, from the browser console.
- A long note no longer wipes the others. One note holds up to 500 characters; when an NPC's notes are full (40 notes or 4,000 characters), a new note is turned down with the reason instead of pushing the oldest out, and the text stays in the box; each player can add one note every two seconds.
- Notes are saved one at a time by a single client, so notes added at the same moment (the GM in a second tab, an assistant GM, a macro, a player) no longer overwrite each other, and the GM logged in in two tabs saves a player's note once.
- A player who owns an NPC can't keep a change made to its record from the console; the GM's client puts it back and says so.
- Opening the People window twice in quick succession no longer makes two windows.
- The window's size and place, and the chips, sort and view, are remembered per world and per user in each browser (carried over from before on first use).
- Mark selected tokens as met saves each NPC once.
- The Portrait field's hint says what players see when it is empty.
- No more deprecation warnings on Foundry 14 from the Actors sidebar's "People: met / not met" entry or from clearing a per-character attitude.

## 1.1.1

- A card's Group field is a menu: None, every group in your order, and New group... to name a new one. It was a text box whose suggestions showed only names matching what was already in it, so the other groups never appeared.
- Dragging an archived NPC onto a group (or No group) brings them back as well as moving them.

## 1.1.0

- Groups and an archive, for when the cast grows. The People window has a sidebar: Everyone, each of your groups with a count, No group, and Archived. Put an NPC in a group from the card's Group field or by dragging the portrait onto a group; archive someone who has left the story, with their attitude and notes kept, and bring them back any time.
- With a group open: Rename (everyone in it follows), Archive all, Bring back, Remove group. New group adds one; drag groups into any order, or sort them A to Z.
- Players see the same sidebar, built only from the NPCs they've met, so groups can be set up ahead of time.
- Search looks everywhere, the archive included.
- Sort by who was met most recently, beside A to Z.
- Mark selected tokens as met asks which group to put them in.

## 1.0.0

- The People window remembers its size and place, in each browser.
- Restoring a window from minimized brings it back at its full size; on Foundry 14.370 it came back as a thin strip.
- Verified on Foundry 14.370.

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
