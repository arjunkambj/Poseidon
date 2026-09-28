# Claude Code's session transcripts

Not a recording, and not written by the CLI: a hand-built config directory
whose `projects/` holds three session transcripts in the record shapes Claude
Code **2.1.280** writes, for the connector's `sessions` extension
(`packages/connector-claude/src/sessionFiles.test.ts`). The shapes were taken
from real transcripts; no content was. Every prompt and reply here was made up,
and paths are spelled `<HOME>/code/…` as the scrubber would spell them.

| File                                          | What it holds                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projects/-HOME-code-alpha/…6e01.jsonl`       | A titled session: two `custom-title` records (the last wins) and an `ai-title`, a reply written as thinking, text and tool-use records sharing one message id, a tool result, a compaction (its `compact_boundary` and `isCompactSummary` summary), and attachment, queue, agent-name, last-prompt and file-history records. |
| `projects/-HOME-code-alpha/…6e02.jsonl`       | An untitled session full of noise: an `isMeta` caveat, a `/model` command's echo and output, a torn line, a prompt with an image block, a Task delegation whose `isSidechain` records sit in the file, a task notification, a `<synthetic>` reply and a system record.                                                       |
| `projects/-HOME-code-alpha/…6e01/subagents/…` | A subagent's transcript in the directory beside its session, as the CLI keeps them: not a session.                                                                                                                                                                                                                           |
| `projects/-HOME-code-beta/…6e03.jsonl`        | A session in a second directory, titled only by the CLI's `ai-title`.                                                                                                                                                                                                                                                        |

The tests set each file's last write themselves, so the order does not depend
on the checkout. Edit these by hand when the CLI's record shapes change.
