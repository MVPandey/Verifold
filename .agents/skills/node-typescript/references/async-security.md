# Async execution and production security

## Async and lifecycle

- Prefer promise-based I/O. Do not call synchronous filesystem, child-process, crypto, or compression APIs on a request path. async does not move CPU work off the event loop; use worker threads, processes, or a job service for heavy computation.
- Use Promise.all for a bounded set of independent operations. It does not cancel siblings on rejection. When fail-fast cancellation matters, share an AbortController, propagate its signal, abort on failure, and settle owned tasks before cleanup. Use allSettled only when every outcome needs handling.
- Do not map an unbounded input into Promise.all. Use a bounded worker pool, page inputs, and apply queue limits/backpressure. Use stream.pipeline from node:stream/promises for error propagation and cleanup.
- Give outbound calls a deadline and propagate caller cancellation. AbortSignal.timeout and AbortSignal.any can combine time limits and caller signals when the target runtime supports them. Promise.race alone does not stop underlying I/O.
- Check response.ok for fetch: HTTP errors do not reject the promise. Consume or cancel response bodies. Limit downloaded/decompressed sizes and validate parsed data. Reuse clients/pools according to their lifecycle API.
- Retry only classified transient failures and operations safe to repeat. Use capped exponential backoff with jitter, a total time budget, cancellation, and Retry-After where applicable. Do not retry writes blindly.
- Await/return promises. Avoid async forEach callbacks and async Promise executors. A void expression does not handle a rejection. Detached work needs explicit error handling and an application-owned task registry or durable queue.
- On SIGTERM/SIGINT, stop accepting work, mark readiness false, drain in-flight work within a deadline, cancel remaining work, and close pools/listeners. Set exitCode for normal CLI failures. Do not keep serving after an uncaught exception that may have corrupted state; let supervision restart the process.

## Security at real boundaries

- Validate request shape, body/file size, pagination, nesting, and expensive operations before expensive work. Use parameterized database queries. Allowlist selectable columns/order fields; placeholders cannot safely parameterize identifiers.
- Authenticate identity and authorize every resource/action, including tenant ownership. CORS is a browser policy, not authorization. Public unauthenticated resources may legitimately allow wildcard origins; credentialed browser APIs need an explicit origin policy. Use CSRF protection for cookie-authenticated state changes where relevant.
- Use maintained auth/password/session implementations; do not invent cryptography. Use node:crypto for secure random values and appropriate primitives. Verify token signature, algorithm policy, issuer, audience, and expiry. Apply secure cookie attributes and TLS according to deployment topology.
- Treat outbound user-controlled URLs as SSRF boundaries: allowlist destinations/protocols where possible, validate resolved addresses and redirects, and enforce network egress policy. A hostname string check alone does not handle DNS rebinding.
- Constrain file access to an intended root, account for symlinks and traversal, and avoid check-then-open races. Use spawn/execFile with shell disabled and validated argument arrays rather than interpolated shell commands. Avoid eval/new Function on untrusted input.
- Avoid arbitrary object merges from input; use explicit property allowlists and Map or null-prototype objects for untrusted keys. Limit regex complexity, JSON size, and decompression ratios to protect the event loop and memory.
- Keep credentials, tokens, raw request bodies, and personal data out of logs and public error payloads. Services configure structured fields with clear human-readable messages; bound attacker-controlled values and use request/trace IDs without treating them as trusted identity.
- Commit lockfiles, install reproducibly in CI, review new packages and install scripts, and keep runtime/dependencies supported. Run vulnerability analysis as a separate, explicit network-dependent CI job when desired; do not auto-run audit fix --force or treat an empty advisory report as proof of security.
- Use least-privilege database/service identities and CI permissions. Keep readiness distinct from liveness; redact internal details from health endpoints. Configure server/proxy body and header timeouts, rate limits, and graceful shutdown to match actual traffic.
