# Per-request attachment fetch budget

Callers may set `routerConfig.maxAttachmentBytes` to an integer from 1 to
31,457,280. This limits the aggregate decoded binary bytes of all inline and
downloaded attachments across all messages in that request. It does not limit
only images: text, JSON and PDF input also consume the budget before extraction.

The budget is shared while normalizing parts. Each download is limited to the
smaller of its MIME-specific limit and the remaining request budget. Actual
stream bytes are counted even if Content-Length is absent, incorrect, or the
remote object changed after an upstream metadata check. Partial run directories
are removed on rejection. Existing per-file MIME/magic/host checks remain active.

The field is optional to retain compatibility with other trusted clients such
as LIFE. Mirastral explicitly sends 30 MiB for chat, including any stored portrait
sent with the current attachments. Mirastral's Edge metadata preflight remains a
cheap early check; this fetch-time limit closes the cross-system size race.

This is not a complete runtime memory cap or an object-version integrity proof.
Image decoding, base64, PDF extraction, prompt text and process overhead need
separate resource limits. A same-size object replacement can still change the
content; requests that require immutable content need version-pinned storage.
