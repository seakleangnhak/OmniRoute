# Hardcode API-Key Authentication Design

## Goal

Require a current, active OmniRoute API key for every client API request. The requirement must
remain enabled even when an environment variable or database feature-flag override contains
`REQUIRE_API_KEY=false`.

Dashboard sessions and the existing WebSocket descriptor handshake remain governed by their
explicit exceptions in `src/server/authz/policies/clientApi.ts`.

## Root Cause

`isRequireApiKeyEnabled()` currently resolves `REQUIRE_API_KEY` from a database override, then the
environment, then a default value. The project default and local `.env` value are both `false`.
Additionally, `clientApiPolicy` converts a supplied invalid key into anonymous traffic whenever the
resolved flag is false. This lets a deleted key or the old value of a regenerated key reach request
handlers without API-key attribution.

## Design

`REQUIRE_API_KEY` becomes an immutable enabled security flag:

- `resolveFeatureFlag("REQUIRE_API_KEY")` always returns `"true"` before consulting database or
  environment values.
- `resolveAllFeatureFlags()` reports the same effective value so the settings UI and API agree with
  enforcement.
- The feature-flag definition and example environment use `"true"` as their documented value.
- The local `.env` is also set to `true` for consistency, although enforcement does not depend on it.
- The two direct client-auth helpers that currently inspect `process.env.REQUIRE_API_KEY` use
  `isRequireApiKeyEnabled()` instead, ensuring they share the immutable rule.

The existing validation path remains unchanged: `validateApiKey()` accepts only existing, active,
non-banned, non-revoked, non-expired keys. Regeneration replaces the stored key and hash; deletion
removes the row. Therefore, old regenerated and deleted keys fail validation.

## Request Behavior

- No API key: reject with `401 Authentication required`, except for existing dashboard-session and
  WebSocket descriptor-handshake allowances.
- Unknown, deleted, or regenerated-old key: reject with `401 Invalid API key`.
- Disabled, banned, revoked, or expired key: reject through the existing lifecycle checks.
- Current active key: allow and retain its API-key identity in request logs.

Previously persisted dashboard rows with a blank API-key identity are not rewritten.

## Error Handling and Security

No raw API key or additional key fragment is logged. Authentication failures retain the existing
sanitized error responses and central authz correlation ID.

## Testing

Regression tests will first demonstrate that database and environment values of `false` can disable
the requirement. After implementation they must prove:

- `resolveFeatureFlag("REQUIRE_API_KEY")` is `"true"` despite false database/environment values.
- The client API policy rejects a missing key even when the environment says false.
- The client API policy rejects an invalid Bearer or `x-api-key` instead of degrading it to
  anonymous traffic.
- Existing current-key, revoked-key, regeneration, and deletion tests remain green.

Relevant focused suites will run before broader type and lint checks.
