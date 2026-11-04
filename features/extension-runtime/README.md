# Extension Runtime

Compose the scanner, registry, observer, session, flow, guide, and voice services inside the injected Shadow DOM host. The content bridge delegates backend access and speech to the worker. Teardown cancels work, stops capture, removes listeners, and destroys the UI.

Keep the per-tab storage queue free while awaiting content-script injection. Chrome can wait for the injected script to finish its asynchronous bootstrap, which requests context from that worker. Holding the queue across injection causes a deadlock. The bootstrap regression test models this callback.

Keep the active main-document binding through same-document loading events.
Verify Chrome's document ID before recovery or a new context claim. Remove an
old document's UI once on STALE_DOCUMENT. Preserve origin, activation, document,
and main-frame checks on browser messages.
