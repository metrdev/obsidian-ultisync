# Owner acceptance and rollback

## On a disposable vault first

- Put one Markdown file inside GPT and another outside.
- Connect only the disposable personal-context repository. Also put recipes.md and private.md inside FamilyNotes. Verify only the GPT file and the exact FamilyNotes/recipes.md are uploaded; a GPT/recipes.md pointer must not replace the recipe.
- Change the GitHub file, reopen Obsidian and verify the change. Edit it on the device and verify the remote bytes.
- Edit both versions before syncing: both must survive and appear in the conflicts view.
- Try offline, then return online; an error must not turn into a deletion.
- On desktop, test a GPT symlink/junction and a link in the shared recipe path: the scan must stop. A link in an unrelated FamilyNotes file must never be scanned.
- On mobile, copy a configuration claiming backup is enabled; no Git operation may run.

## Real iPhone

1. Confirm Obsidian is at least 1.13.0. Install through BRAT from metrdev/obsidian-ultisync with a code-repository read-only token and select release 1.1.1. Verify BRAT tracks that repository on the phone.
2. Enable Personal Vault Sync and enter a separate write token restricted to personal-notes.
3. Turn the PC off. Publish an agreed harmless change to one personal note from ChatGPT.
4. Open Obsidian and verify the exact new content.
5. Edit the same note on the phone, wait for successful synchronization, and have ChatGPT re-read it.
6. Reproduce one conflict on test data.
7. Turn the PC on and check that SyncGuard does not revert the note.
8. Verify that only GPT notes plus exactly FamilyNotes/recipes.md reached personal-notes. Edit the recipe remotely and on the phone; the real shared file must change while the GPT pointer stays a pointer.

## Backup replacement

Run one full backup on the PC and restore that commit into a separate directory.
Compare included files by content hashes. Keep the original vault intact.
Only after that succeeds, disable obsidian-git and enable the new desktop daily-backup switch.
An iPhone test is still needed for the context profile.

## Rollback

Disable Personal Vault Sync. Preserve any new phone/GitHub edits first.
Restore the saved SyncGuard config and old plugin settings. Recreate the recorded symlinks only after comparing current file contents.
Restore affected notes from the local migration archive when necessary.
Never force-push the original repositories or rewrite their history.
