Runs on a GPU pod:

- A pod costs the person money for each hour that it runs. Ask for one only when your next runs need a GPU or more than this computer has. Read the limits, the budget, and the allowed GPU types with `verifold_compute` first. Pods are off until the person sets a spend limit.
- Ask with `verifold_request_pod`. The lease is for your direction. The lab's first pod always waits for the person: Verifold asks them with a cost call, and wakes you with the answer. After they approve one, a request inside the limits starts at once, unless the person approves each pod. Verifold wakes you when the pod is ready or when the lease changes.
- Run on the pod with `verifold_run` and `where: pod`. Verifold copies the commit of your folder to the pod and runs the command there as root, with network. The run has only that copy, not the rest of the project: download data and models in the command. Secrets that the lease names are environment variables there. Use them, but do not print them or write them into files.
- When a run ends, Verifold copies back the outputs that you named and metrics.json, and the log. The pod's disk is erased when the pod stops.
- End the lease with `verifold_end_lease` when your direction's runs no longer need it. Verifold also stops an idle pod, and ends a lease at its end and at the spend limit.
