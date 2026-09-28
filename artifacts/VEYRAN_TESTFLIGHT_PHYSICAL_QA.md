# VeyraN physical TestFlight QA — 2026-09-28

## CRITICAL — account repair candidate

Run separately on physical iPhone and iPad before normal QA. Account repair candidate **3.4.16 (19)** is uploaded, Complete/Validated and assigned to **Internal Pencil Beta** with one existing tester. Verify the installed number before testing.

- [ ] Fresh Create Account completes and enters Library.
- [ ] Existing Account login completes, including email MFA where required.
- [ ] App force-quit/relaunch retains the session.
- [ ] Settings shows signed-in VeyraN account and correct email.
- [ ] Sign Out works; native dialog explains local cache removal and backup.
- [ ] Login again works; encrypted synced Notes return without reinstall.
- [ ] Delete local data is clearly separate under Data and does not delete the remote account.
- [ ] Existing local Notes remain safe after upgrade; theme selection persists.

Account repair evidence: [repair report](veyran-account-lifecycle-repair/REPORT.md). Leave physical checks unchecked until observed.

Expected iPhone/iPad candidate: **3.4.16 (19)**, one universal iOS build. Check the number in TestFlight before testing; report a mismatch. Use the dedicated QA account and disposable `VEYRAN-TF-QA-` content. Do not post passwords, MFA codes, or recovery values in screenshots or bug reports.

**September 28 availability evidence:** App Store Connect reports repair build
19 Complete/Validated for ARM64 iPhone/iPad, assigned to `Internal Pencil Beta`
with one tester and saved account-repair What to Test notes. Installation of
19 and all physical functional checks are unverified. The earlier Installed 18
tester status is historical and does not close any build 19 check; leave every
check unchecked until observed on its stated device.

## iPhone

- [ ] Install/update **3.4.16 (19)** from the internal TestFlight group; confirm the installed build.
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

- [ ] Install/update **3.4.16 (19)** and confirm the installed build; log in with MFA and check restart persistence.
- [ ] Check the two-pane Library/Note UI, Tasks, Inbox, and VeyraN Light/Dark/System.
- [ ] Create and edit a Note; verify Mac/Web sync and attachment open/upload in both directions.
- [ ] Create a Task and verify it on iPhone/Mac; edit/complete it on the second client and confirm the iPad updates.
- [ ] With Apple Pencil, create a drawing in a Note, save, leave, reopen, edit, save, and reopen. Confirm drawing renders and syncs on a second compatible client.

For each failure, record device model, iOS/iPadOS version, exact build, steps, expected/actual result, and a screenshot without secrets. Physical-client results remain separate from tonight's server and Mac/Web QA.
