# Changelog

## 0.5.1

- Fix presented conversation cards recorded with a remote absolute path (or an anchor+remote hybrid): downloads, references and drag-to-chat now normalize the path on the host instead of failing with 「路径不在当前工作区内」.
- Reference a presented card by an absolute `@` path when the Session cwd cannot map it to a workspace-relative path, and expose 「加入对话」 in its right-click menu even when the relative mapping is unavailable.
- The whole preview tab title is now a drag source (not only the small grip), and right-clicking a file preview tab offers download / 加入对话 / copy path.
- Keep the small grip and the preview path label as drag sources; all source menus share the same absolute-path handling.

## 0.5.0

Fast remote references and file sources outside the tree.

- `@` in an SSH workspace now lists the live folder over the **existing helper connection** (`workspaceFiles`/`fs`) instead of spawning a new `ssh` process per keystroke. Directory listings are cached, so repeated typing in one folder is answered from memory; a fresh folder is one helper round-trip.
- A bounded recursive index builds in the background for bare names. It never delays the live folder, and the open `@` menu refreshes itself once the index settles — no more waiting for the whole remote workspace or closing/reopening `@` to make files appear.
- Presented files in the conversation (PDF, PNG, …) can be downloaded, referenced, or have their relative path copied from the right-click menu. Dragging a card into the composer inserts the same `@` reference as the file tree.
- Preview tabs for file resources get a drag handle next to the title; the preview path label is draggable too. Both can be dragged into the composer, and right-clicking them offers download/reference/copy.
- SSH downloads up to 32 MB now read through the host filesystem service, so conversation files and previews download without opening a second SSH connection. Larger files and folders still use the streaming SSH path.

## 0.4.1

- Fix: dropping files on the tree could leave the host's full-window "drop files here" overlay stuck. Drags that stay inside the tree no longer start it, and a drop always ends it.
- Faster transfers: SSH connections are reused (ControlMaster, 2 minutes), downloads check the target first and show real size and progress, and when no save dialog is available the browser's own download manager streams the file instead of buffering it in memory. Upload cards appear immediately while folders are being read.
- Fix: `@` in an SSH workspace sat on a loading skeleton until the whole remote workspace had been indexed (or forever when it was too large). It now lists the current folder at once and uses the index only when it is ready in time.

## 0.4.0

File tree tools for every workspace, local or SSH.

- Drag any file or folder row into the chat box to add an `@` path reference. It no longer depends on the SSH-only local patch, so it works in every workspace (the older patch keeps handling rows it already marked).
- Right-click a row: download (folders are packed as `.tar`), reference in chat, copy relative path, rename, delete, new folder, upload files or a folder. Right-click blank space for upload and new folder at the workspace root.
- Drag files or folders from Finder onto the tree to upload them into the folder under the pointer. Existing files are never overwritten without a confirmation.
- New host-side routes `/api/dsh-files/*`. Every request is bound to the session's workspace root; paths and symlinks that leave it are refused. Local workspaces use the filesystem; SSH workspaces use the system `ssh` client (key-based login, `BatchMode`).
- Requires a full restart of Harness after installing, because the host half is new.

## 0.3.0

First public release.

- Reuse the native Harness file panel on the left while keeping conversation and preview separate.
- Add an independent folder toggle immediately before the history toggle.
- Keep the folder control available when conversation history is collapsed.
- Preserve file tree state when hiding the file panel.
- Keep file and preview visibility independent; selecting a file opens the native right preview.
- Remove sidebar split, fullscreen, collapse, and add-tab controls from the file panel.
- Reserve a separate file column without covering the conversation.
- Restore native components and layout on unload.

Validated on DeepSeek Harness 0.2.1-rc.3, with 11 automated checks and real local/SSH PDF preview checks.
