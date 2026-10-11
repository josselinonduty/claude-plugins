# claude-plugins

Claude Code plugins by [@josselinonduty](https://github.com/josselinonduty).

| Plugin | Description |
|---|---|
| `commit-changes` | Band above the prompt that splits uncommitted changes into logical sections and commits them one by one or automatically, with clean canonical messages. |
| `secret-guard` | Detects secrets in prompts and conversation rows, moves them to the project's `.env` file and redacts them from the history. |
| `prompt-library` | Save past prompts to a searchable library; fuzzy search, then Copy or Apply to the prompt field. |
| `system-instruction` | Panel (`/instructions`) to edit a persistent custom system instruction, given to the model at every session start, `/clear` included. |

## Install

```
/plugin marketplace add josselinonduty/claude-plugins
/plugin install commit-changes@josselinonduty-plugins
/plugin install secret-guard@josselinonduty-plugins
/plugin install prompt-library@josselinonduty-plugins
/plugin install system-instruction@josselinonduty-plugins
```
