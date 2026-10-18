# Personal Vault Sync

Private derivative of [UltiSync 1.0.7](https://github.com/msachet5/obsidian-ultisync). Original copyright and MIT license are retained.

One Obsidian plugin with two independent jobs:
- **Personal context**: only `GPT/` is mapped to the root of a selected GitHub repository. Works on desktop and iOS through GitHub's REST API.
- **Vault backup**: desktop only, once per local calendar day while Obsidian is open, using the vault's existing native Git repository. Disabled by default.

## Install

Requires Obsidian 1.13.0 or newer. Build with Node.js 24 and `npm ci`, `npm run build`.
Install through BRAT: add `metrdev/obsidian-ultisync`, use a separate fine-grained token restricted to that code repository with Contents read-only, and select release `1.1.0` for acceptance. The notes-exchange token is separate and has Contents read/write only on `personal-notes`. See [INSTALL_RU.md](INSTALL_RU.md).

Manual development installation: copy `main.js`, `manifest.json` and `styles.css` into `<VAULT>/.obsidian/plugins/personal-vault-sync/`.

Start with a disposable vault and repository. Enable the plugin in Settings → Community plugins.
On iPhone, add the private repository through BRAT as well and confirm the selected release was downloaded. A copied folder is not proof that BRAT tracks the repository or can access updates.

## Personal context

1. Create a fine-grained GitHub token restricted to the personal-notes repository, with Contents read/write.
2. Enter it in the plugin on each device. Never put the token in Git, Markdown, chat messages or plugin data.json.
3. Check owner, repository and branch, then Save. On first use, review the comparison and select the intended starting point.
4. Confirm the app has downloaded the expected files before editing offline.

The engine sees a virtual vault rooted at GPT. Files outside it are not enumerated or forwarded to I/O methods. Hidden, absolute and traversal paths are rejected.
Desktop scans fail closed on symlinks/junctions. iOS uses Obsidian's indexed file API; real-device acceptance remains required.

Updates are checked at startup, on returning to the app, and every 30 seconds while visible. Local edits are sent after a five-second quiet period.
There is no continuous execution after iOS suspends Obsidian.
Conflicting versions are preserved. The conflict dialog offers explicit choices.

Each device stores tracking and settings in IndexedDB, keyed by vault and repository. This state never enters iCloud or the backup.
Tokens are namespaced in Obsidian SecretStorage. Missing IndexedDB or SecretStorage disables context synchronization instead of storing credentials in plaintext.
Keep the original files and remote history when resetting a device; re-link using the comparison dialog.

## Desktop backup

The daily switch is local to this computer and initially off. Mobile cannot run native backup even if a setting is copied to it.
The job uses the existing main/master branch and validates the configured backup repository.
It fetches history to detect divergence but never checks out, merges, resets or restores note contents.
No force push is used. A normal Git author identity in the backup commits uses the configured noreply address.

Existing staged work or an index lock prevents backup. A separate temporary index stages the snapshot, while an exclusive real-index lock prevents concurrent Git staging.
Successful snapshots update the local branch/index and push normally. A failed push leaves the local commit available for retry.
A snapshot with no changes creates no new commit.
Workspace files, trash, temporary files and credential stores are excluded; recognized GitHub tokens/private keys in newly scanned text block publication.
Large missing-file batches abort the snapshot.

Restore into a separate folder with ordinary Git, compare it with your vault, and only then copy approved files. There is no automatic restore command.

## Validation

```sh
npm ci
npm run build
npm run lint
npm test
```

Tests cover upstream conflict safety, GPT boundaries, device-local IndexedDB, native Git staging/lock/history safety, and loading the production bundle with Node APIs unavailable.
Node-module lint warnings concern the two modules loaded only through the desktop branch; the mobile bundle test checks that importing the plugin does not load them.

The tests do not establish real iPhone execution, visual settings behavior, or coexistence with iCloud/SyncGuard. Complete [ACCEPTANCE.md](ACCEPTANCE.md) before replacing the old backup plugin.

## Repository boundaries

Personal notes, credentials, vault backups and local migration artifacts are never committed to this code repository.
`upstream` is the original project; `origin` is the private derivative. Updating upstream is a reviewed code change, not an automatic runtime action.
