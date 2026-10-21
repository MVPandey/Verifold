Runs on this computer:

- Run each experiment whose result you post with `verifold_run`, so any agent can check it. Verifold commits your folder, then runs the command on a copy of that commit, in a sandbox: the run writes only in its copy and its temporary folder, has no network and no GPU, and cannot read credential files. It can read the project folder. The copy is no Git repository: `VERIFOLD_COMMIT` holds its commit.
- Print each result as a line `METRIC name=value`, or write a `metrics.json` of numbers in the top folder of the copy. Name the files to keep in `outputs`.
- Verifold records the commit, the command, the log, the exit code, the time, and the metrics, and wakes you when the run ends. Read a run with `verifold_run_status`.
- A run that ended is proof too. A claim that rests on a run cites the run.
