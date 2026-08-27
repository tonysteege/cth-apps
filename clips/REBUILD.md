# CTH Clips rebuild - working checklist

Tony's spec, 2026-08-27. Desktop is the target; tablet and mobile follow
where a change would otherwise break them. This file is the source of
truth for what is done and what is not - update it in the same commit as
the work, and delete it when everything below is shipped.

Status key: `[ ]` not started, `[~]` in progress, `[x]` done and verified.

## Phase 1 - Clip Log

- [x] 1. Tag panel gets its own surface (light grey) so it reads apart
      from the Clip Log.
- [x] 2. A clip row's tags become ONE editable text field, not pills.
      Click into it to add or remove tags. Saves horizontal space.
- [x] 3. That tag text is a lighter grey and a slightly lighter weight
      than the clip name beside it.
- [x] 4. Rating dots: three light grey dots beside the clip name that
      light green / red / blue when good / bad / star is applied. No
      other colour appears there.
- [x] 5. Search field collapses to a search ICON.
- [x] 6. All Clips and All Tags become multi-select checkbox menus, each
      option carrying a count.
- [x] 7. Sort button is removed; the Time and Clip table headers sort,
      ascending and descending.
- [x] 8. "N of N Clips" moves to the right edge of the table header bar.
- [~] 9. Row checkboxes for multi-select, plus bulk actions (rename,
      export, delete, at least).
- [x] 10. Cmd+Z undoes the last tag or clip.
- [x] 11. Right-click menu on a clip row: delete, rename, edit timecodes
      (buffers and actual time), and the rest of the obvious suite.
- [x] 12. Playlist mode: a one-click toggle that plays every displayed
      clip back to back, with a persistent on-player indicator of which
      clip is running.

## Phase 2 - Tag panel

- [x] 13. Keyboard-shortcut tooltips get a larger, more visible font.
- [x] 14. The column can be dragged 30-40% narrower than its current
      minimum.
- [x] 15. Labels read "Clips" and "Tags" in black bold Title Case.
- [x] 16. The grey-brown tag buttons become steel grey.
- [x] 17. A PLAYERS button in orange, shortcut `p`: pauses the video and
      opens a dialogue listing players (number, first, last - editable in
      Settings), each with its own single-key shortcut shown as a
      tooltip. Clicking or typing appends that player's first name as a
      tag. Return / Escape / Done / clicking off saves and resumes play.

## Phase 3 - Annotation toolbar

- [x] 18. The selected tool STAYS selected until Escape or another tool.
- [x] 19. One-key shortcut per tool, customisable from a right-click menu
      on the tool itself.
- [x] 20. Resize handles on shapes; anchor points on lines and arrows to
      move and curve them, the way Diagrams does it.
- [x] 21. Rubber-band drag selects several placed objects.
- [x] 22. Selection chrome uses the Diagrams cyan.
- [x] 23. Remove the Diagram button.
- [x] 24. Text tool: no black border. A white pill with a shadow/lift
      tuned to sit on video.
- [x] 25. The text box looks IDENTICAL while typing and after committing -
      nothing should appear to happen but the loss of selection.
- [x] 26. Text boxes 25% smaller.
- [x] 27. Shortcuts: Clear `x`, Export `e`, Done `Enter`.
- [x] 28. Red stays the default; add yellow and blue, both tuned for
      telestration over ice and video.
- [x] 29. Remove the dot-in-circle tool. The circle tool always draws a
      true circle.
- [x] 30. The select tool (`v`) shows the ordinary arrow cursor.
- [ ] 31. SIDE-BY-SIDE: pull a second video from the library alongside the
      current one, each with its own scrub and timeline.
- [x] 32. JOINT ANGLE tool: endpoint handles, and an always-visible
      readout of the true angle.
- [x] 33. No tooltip on pressing Freeze, and none on Done.

## Phase 4 - Freeze, Pull, Record

- [~] 34. Record and Pull sit beside Freeze in the top bar.
- [ ] 35. FREEZE opens the annotation toolbar; Done (or Return) exports
      the clip with a 3-second freeze (or whatever the toolbar is set to)
      at the playhead, annotations baked in. It is NOT written to the Clip
      Log. It lands in the source video's own folder with `-freeze`
      appended to the file name.
- [ ] 36. Right-click Freeze sets a custom in/out buffer; default 5s
      before and 10s after.
- [ ] 37. PULL: same right-click buffer, same defaults; exports the
      surrounding chunk as a straight clip to the same folder, no
      appended text, no freeze.
- [ ] 38. Bulk Pull from several selected Clip Log rows, each exported as
      its own clip into the same folder.
- [ ] 39. RECORD: shows a bounding box for the capture area, draggable,
      with one-click presets, remembered across sessions. Return or a Go
      button starts a screen recording of the video player with the
      laptop microphone live and the cursor highlighted by a translucent
      red circle (customisable in Settings), and opens the annotation
      toolbar. Everything drawn is in the export; the toolbar never is.
      Enter or Escape ends it and saves to the source folder with
      `-analysis` appended.
      NOTE ON WHAT A BROWSER CAN DO: capturing THIS TAB (region capture of
      the player) is the only route where the cursor position is knowable
      and the drawings are already in the frame. A whole-screen grab can
      neither highlight the cursor nor be re-selected silently, since the
      browser demands a fresh surface pick every time. Build it as a tab
      capture.

## Phase 5 - Export, Settings, and the rest

- [ ] 40. Export file names follow
      `[clip name]-[tags in Clip Log order, joined by -]-[HHMMSS]`,
      itself editable in Settings.
- [ ] 41. Exports are SILENT: no progress dialogue, no indicator. The file
      simply appears. A failure, and only a failure, raises a notice.
- [x] 42. A Settings sheet covering as much as is reasonable: players,
      the cursor highlight, the naming pattern, buffers, shortcuts.
- [x] 43. Remove the Email function.
- [ ] 44. Timeline: freeze marks go. Every tag timecode gets a clickable
      marker that jumps there. The timeline zooms and scrolls from the
      trackpad.
- [ ] 45. Tablet and mobile keep up with all of the above.
