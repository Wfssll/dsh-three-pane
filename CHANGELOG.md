# Changelog

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
