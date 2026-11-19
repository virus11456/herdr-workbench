# Herdr Workbench

This is an independent custom workbench. Publish only to this repository's configured remote, never to the upstream Herdr repository.

- Keep program source separate from per-machine settings, credentials, conversations, runtime state, backups and acceptance artifacts.
- Preserve the user's existing files and settings. Preview installation changes and back up every overwritten target.
- Do not answer login, trust, permission or payment prompts. Do not disable agent sandboxes or invent terminal IDs.
- Runtime requests must originate from the real current coordinator; read the response for the same request ID. Queued is not success.
- Keep the private service bound to loopback, behind Tailscale Serve, with identity, Origin and CSRF validation. Do not enable Funnel.
- Store active control data outside cloud-synced project files. Never delete the only verified copy or propagate cleanup as a cloud deletion.
- Keep UI actions simple: project, agent, chat. Put advanced settings under project management.
- Run `npm test` for runtime or API changes. Tests use isolated fixtures and must not start real agents. Describe live verification separately.
- Report incomplete browser, phone, Drive login or fresh-machine validation accurately.
