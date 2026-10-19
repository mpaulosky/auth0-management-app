# One deep seam in front of the Management API

The Users and Roles slices reach the Management API through one interface of our own, `IManagementApi`, in `src/UI/ManagementApi/` (`UI.ManagementApi`). It has one method
per use case (search Users, get a User, update their Profile Fields, assign or remove a Role, list Roles, create a Role, list the Users who hold a Role, count them
uncached, and check uncached whether a User holds a Role). Each method returns a
`Result` or `Result<T>` and carries records of our own, never the `Auth0.ManagementApi` SDK's types. Expected failures (not found, a Role that already exists, a field Auth0 won't
change, and a 429 still refused after the SDK's retries, as `ManagementApi.RateLimited`) come back as a failed `Result` with a stable code in `Details`; failures that shouldn't
happen, such as a failed token exchange or a 5xx after the retries, throw.

Everything else sits behind that interface and is `internal`: the SDK's `ClientCredentialsTokenProvider` as a singleton, a typed `HttpClient`, a `ManagementClient` built for
each call, the adapter that translates SDK calls, paging and exceptions, and a `CachedManagementApi` decorator in front of it that clears what a write makes stale.
`AddManagementApi()` registers it all with `TryAdd*`, binds `ManagementApiOptions` from `Auth0:Management` with `ValidateOnStart`, and is called by each slice's
`Add<Feature>Feature()`. Rules of this app, such as refusing to remove `Admin` from the Tenant's last Admin, stay in the slices' handlers.

This departs from `mpaulosky/Articles`, the reference `CLAUDE.md` points to, whose seam is an `IManagementApiClientFactory` that hands each handler the SDK's own
`IManagementApiClient`. The decision was made in the map ticket
[What is the Management API seam the Users and Roles slices call?](https://github.com/mpaulosky/auth0-management-app/issues/14).

## Considered Options

- **A factory that hands out the SDK client (Articles' shape)**: a small interface but a shallow one. Every handler would page, map exceptions and pick fields out of SDK types
  itself, and every handler test would substitute the SDK. That is awkward: its `WithRawResponseTask<T>` is a struct, so an unconfigured NSubstitute call throws, and its
  `Pager<T>` needs a hand-written `IAsyncEnumerable` ([SDK findings](../research/auth0-management-sdk.md)).
  Deleting the factory would remove nothing: the complexity is already in the callers.
- **Two interfaces, one per slice (`IUserDirectory`, `IRoleDirectory`)**: each slice would depend on less, but one adapter would sit behind both, and the Role calls the Users
  slice also needs would sit awkwardly between them.
- **Throwing and letting each handler map the SDK's exceptions**: `CLAUDE.md` asks for a failed `Result` with a stable code, and mapping once, on the status code rather than
  the exception subclass (the SDK maps only the codes each endpoint's spec lists), keeps that rule in one tested place.
- **A folder named `src/UI/Auth0/`**: its namespace, `UI.Auth0`, would hide the SDK's root `Auth0` namespace from code inside `UI`, so any qualified `Auth0.…` name would need
  `global::`.

## Consequences

- Handler tests substitute `IManagementApi`, and only the adapter's tests touch the SDK, offline, through a stub `HttpMessageHandler` and a `DelegateTokenProvider`.
- Adding a use case adds a method and its records to `IManagementApi`, its adapter and the cache decorator.
- Which Users hold which Roles comes from listing each Role's members, not from fetching each User's Roles, so `UserSummary` carries no Roles. The adapter pages each Role's
  members with checkpoint paging (`from`/`take`), because offset paging stops at 1000 Users, so the cost is one request per page of members per Role. The listing stops
  at 1000 members and says so with `RoleMembers.Truncated`, so the `User` Role, which every User who signs up holds, costs at most 10 requests. Adapter tests
  cover a Role with more than one page of members, and a page that returns 429 partway through, which fails the whole listing with `ManagementApi.RateLimited` rather
  than returning part of the membership.
- Every HTTP request to the Management API, each page and the SDK's retry included, takes a token from a client-side token bucket (`TokenBucketRateLimiter`) in a
  `DelegatingHandler` on the Management API's `HttpClient`. The bucket matches Auth0's, sized from `ManagementApiOptions`, with defaults that match the Free tier: 2 a
  second, burst 2. It counts requests rather than `IManagementApi` calls, because one call can send several. Capping how many calls run at once isn't enough,
  because Auth0 refills its bucket by rate and answers a call over the limit with a 429 at once rather than queueing it
  ([rate limit findings](../research/auth0-user-search-and-rate-limits.md)). The limiter queues requests in order, and the handler answers one still waiting after
  `ManagementApiOptions.QueueTimeout` with a 429 of its own, so the call fails with `ManagementApi.RateLimited` through the same mapping as Auth0's 429.
  The same goes for a request refused because the queue is full. If the SDK's own 10 s timeout fires first, on a call that met a 429 from either source, the adapter
  maps it to `ManagementApi.RateLimited` too, so a rate limit never surfaces as an outage.
- The cache is in memory, in one process, with a short absolute expiry, and the app's own writes clear what they make stale. A change made elsewhere, such as in the Auth0
  Dashboard or by another instance of the app, shows only once the entry expires. So the last-Admin guard counts the `Admin` Role's members with
  `CountRoleMembersAsync(roleId, atMost)`, which the decorator never caches and which stops paging once it has seen `atMost` members, and never trusts a stale count. The guard is
  `CountRoleMembersAsync`'s only caller; a count that's only displayed uses the cached listing.
- The guard first checks, with `UserHoldsRoleAsync`, uncached, that the User holds `Admin` at all: removing it from someone who doesn't is a no-op that succeeds,
  never a refusal.
- The guard's read and the removal are two calls, and Auth0 has no conditional removal, so two Admins removing each other at once could both pass the guard. After removing
  `Admin`, the handler counts the `Admin` Role's members again, and if none remain it assigns the Role back and returns a failed `Result` with `User.LastAdmin`, the same
  code the guard refuses with before the removal. This
  works across instances, but the Tenant can have no Admin for a moment; if the restore itself fails, recovery is through the Auth0 Dashboard. The handler's tests cover
  the restore.
- `ValidateOnStart` means the app won't start without `Auth0:Management:*` settings once a slice calls `AddManagementApi()`. The integration tests' factory and the AppHost
  and E2E test setups supply placeholder values, and a developer without the Machine to Machine application sets them as user secrets, as the README describes.
- As [ADR 0007](0007-cross-cutting-code-outside-the-slices.md) requires of a cross-cutting folder, an architecture test checks that `UI.ManagementApi` depends on no slice.
- `CLAUDE.md`'s paragraph that names `IManagementApiClientFactory` as the pattern to follow changes to point here.
