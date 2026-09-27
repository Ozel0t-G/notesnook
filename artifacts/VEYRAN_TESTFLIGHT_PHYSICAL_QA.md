# VeyraN physical TestFlight QA — 2026-09-28

Expected iPhone/iPad candidate: **3.4.16 (18)**, one universal iOS build. Check the number in TestFlight before testing; report a mismatch. Use the dedicated QA account and disposable `VEYRAN-TF-QA-` content. Do not post passwords, MFA codes, or recovery values in screenshots or bug reports.

## iPhone

- [ ] Install/update **3.4.16 (18)** from the internal TestFlight group; confirm the installed build.
- [ ] Log in with email MFA; force quit and relaunch; confirm the session and existing QA data remain.
- [ ] Check Library, All Notes, Inbox, Tasks, Search, New Note, and Settings → Tasks.
- [ ] Create a Note, type, save, go back, reopen, edit, save, and reopen again. Confirm Mac/Web sync in both directions.
- [ ] Create an unassigned Note; confirm Inbox and All Notes. Assign it to a Notebook; confirm it leaves Inbox and stays in All Notes.
- [ ] Switch System, VeyraN Light, and VeyraN Dark; confirm live appearance and no upstream theme cards.
- [ ] Create/edit/complete a Task and check its flag, priority, List, and reminder against the Mac Task UI. Confirm changes travel both ways.
- [ ] Add a small attachment; open it on Mac/Web. Open a Mac/Web attachment on iPhone.
- [ ] Complete a Task from the Home Screen Widget. Repeat after force quitting the app, and again after leaving it closed overnight (cold Widget cache fix).
- [ ] Check an Urgent reminder at due time and overdue: sound/haptics at audible volume, haptic behavior at zero volume, stop without auto-completion, continuing overdue time, and Lock Screen/Dynamic Island presentation where supported. Record each difference from Apple Reminders; do not assume all behavior is implemented.

## iPad

- [ ] Install/update **3.4.16 (18)** and confirm the installed build; log in with MFA and check restart persistence.
- [ ] Check the two-pane Library/Note UI, Tasks, Inbox, and VeyraN Light/Dark/System.
- [ ] Create and edit a Note; verify Mac/Web sync and attachment open/upload in both directions.
- [ ] Create a Task and verify it on iPhone/Mac; edit/complete it on the second client and confirm the iPad updates.
- [ ] With Apple Pencil, create a drawing in a Note, save, leave, reopen, edit, save, and reopen. Confirm drawing renders and syncs on a second compatible client.

For each failure, record device model, iOS/iPadOS version, exact build, steps, expected/actual result, and a screenshot without secrets. Physical-client results remain separate from tonight's server and Mac/Web QA.
