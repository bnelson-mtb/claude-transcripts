# transcripts

A Claude Code mod that adds `/transcripts`: browse and delete Claude Code and Cowork session transcripts on this machine, and set the auto-delete period.

Windows only: it scans and deletes with PowerShell scripts.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install transcripts --marketplace bnelson-mtb/claude-transcripts
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install transcripts --marketplace bnelson-mtb/claude-transcripts
```

## Updating

```
/plugin marketplace update claude-transcripts
```

Then update the mod from the `/plugin` menu, or turn on auto-update for this marketplace there.
