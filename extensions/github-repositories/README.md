# GitHub repository artifacts

This package owns the shared GitHub host, token-environment, and managed-account
formatting, OAuth device/refresh protocol, and bounded credential verification
used by the native GitHub integration. Core callers import its shallow public
artifacts without loading a plugin runtime. The host still reads its runtime
configuration snapshot.

The current configuration remains `gateway.github`. This package does not yet
register a plugin or change activation, credential selection, or API validation.

`oauth-api.ts` owns the remote GitHub protocol and verification cache.
Native CLI credential selection and its cache remain host-owned; lifecycle callers
explicitly invalidate both owners when an identity changes. OAuth record persistence
and scheduling remain unchanged.
