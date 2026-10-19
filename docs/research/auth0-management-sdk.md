# Auth0 Management SDK: version and calls

Research for [#12](https://github.com/mpaulosky/auth0-management-app/issues/12), part of the map
[#11](https://github.com/mpaulosky/auth0-management-app/issues/11). Checked on 2026-10-19.

## Answer

- Pin `Auth0.ManagementApi` **10.5.0**, the current stable release (published 2026-10-15). It builds cleanly on .NET 10.
- Build one `ManagementClient` from a `ClientCredentialsTokenProvider`. The provider caches the token until 10 seconds before
  it expires, so keep it a singleton.
- The SDK ships `IManagementApiClient`, with an interface for every sub-client. It is awkward to substitute directly, so
  the map's decision to put our own interface in front of it stands.
- Every non-2xx response throws a `ManagementApiException`: a subclass when the endpoint's spec lists the code,
  otherwise the base type. Map on the call and its `StatusCode`, plus `ErrorCode` and `Description`, rather than on the
  subclass.
- `PATCH /users/{id}` refuses some Profile Fields by connection type:
  - `name`, `given_name`, `family_name`, `nickname` and `picture` change only for database and passwordless Users, or
    where the connection's "Sync user profile attributes at each login" is off.
  - `email` changes only for database Users.
  - `email_verified` can't be set for enterprise or passwordless SMS Users.
  - Each refusal is a 400 with a specific message.
- **The six permissions in `CLAUDE.md` are probably one short:** Auth0's reference lists `read:role_members` for listing a
  User's Roles and a Role's Users (see [Permissions](#permissions)).

## Version

| Fact | Value | Source |
| --- | --- | --- |
| Latest stable | 10.5.0, published 2026-10-15; no prerelease is newer | [NuGet versions][nuget-index], [release mgmt-10.5.0][rel-1050] |
| Target frameworks in the package | `netstandard2.0`, `net462` (a .NET 10 app takes `netstandard2.0`) | [nuspec][nuspec] |
| Dependencies | `Auth0.AuthenticationApi` 7.49.0, `System.Text.Json` 9.0.9, `Microsoft.Bcl.AsyncInterfaces`, `System.Net.Http` 4.3.4 | [nuspec][nuspec] |
| v9 status | Maintenance only since 10.0.0. v10 kept client setup, type names, `Pager<T>` and sub-clients from v9 | [release mgmt-10.0.0][rel-1000] |
| 10.4.0 to 10.5.0 | Breaking changes only in areas we don't use (Experiment Center, Organization search, connection display name, event streams) | [release mgmt-10.5.0][rel-1050], source diff |

I verified the build with a scratch `net10.0` project. It referenced 10.5.0 with `TreatWarningsAsErrors`, `Nullable`,
and `NuGetAuditMode=all` at `NuGetAuditLevel=low`, called every method listed below, and built with no warnings or
audit findings. It sits alongside the repo's `Auth0.AspNetCore.Authentication` 1.11.0 with no overlap: that package
depends on `Microsoft.AspNetCore.Authentication.OpenIdConnect`, not on `Auth0.AuthenticationApi`.

The Articles reference pins **10.4.0** (`mpaulosky/Articles`, `Directory.Packages.props`). Between 10.4.0 and 10.5.0
only doc comments and the Roles list's `owner_id` filter changed in the code we'd call.

```xml
<PackageVersion Include="Auth0.ManagementApi" Version="10.5.0" />
```

## Client and token

Source: `src/Auth0.ManagementApi/Wrapper/` at tag [`mgmt-10.5.0`][src].

- `ClientCredentialsTokenProvider(string domain, string clientId, string clientSecret, string? audience = null, HttpClient? httpClient = null)`
  implements `ITokenProvider` and `IDisposable`.
  - It caches the access token and expiry, and fetches a new one when fewer than 10 seconds are left.
  - Refreshes are thread-safe: a fast path, then a `SemaphoreSlim` double check.
  - The audience defaults to `https://{domain}/api/v2/`.
  - A failed token exchange throws from `Auth0.AuthenticationApi` (`Auth0.Core.Exceptions.ErrorApiException`, or
    `RateLimitApiException`), not a `ManagementApiException`.
- `ManagementClient(ManagementClientOptions)` is sealed. It derives from `ManagementApiClient : IManagementApiClient` and
  implements `IDisposable`.
  - The options are `Domain` (required, no scheme), `TokenProvider` (required), `HttpClient`, `Timeout` (default 30 s),
    `MaxRetries` (default 2) and `AdditionalHeaders`.
  - It asks the provider for a token on every request, so the client itself is cheap.
  - It disposes the `HttpClient` only if it created it, and never disposes the token provider.
  - It requests the token with `CancellationToken` `default`, so cancelling a call doesn't cancel a token fetch in progress.
- `DelegateTokenProvider` wraps any `Func<CancellationToken, Task<string>>` without caching. It's an alternative if we
  ever cache tokens ourselves.
- **Retries:** every request is retried up to `MaxRetries` times on 408, 429 and 5xx.
  - The wait comes from `Retry-After` (capped at 60 s) or from an exponential backoff starting at 1 s
    (`Core/RawClient.cs`).
  - So a 429 reaches our code only after the retries run out, and a call can take far longer than one request.
  - Set `MaxRetries` and `Timeout` on purpose for interactive pages.

Suggested wiring, at the seam the map puts in `src/UI/Auth0/`:

```csharp
// Singleton: owns the cached token. One instance for the app's lifetime.
services.AddSingleton<ITokenProvider>(sp =>
{
	Auth0ManagementOptions o = sp.GetRequiredService<IOptions<Auth0ManagementOptions>>().Value;
	return new ClientCredentialsTokenProvider(o.Domain, o.ClientId, o.ClientSecret);
});

// Cheap per use: build it with a factory-managed HttpClient so handler rotation still works.
IManagementApiClient client = new ManagementClient(new ManagementClientOptions
{
	Domain = o.Domain,
	TokenProvider = tokenProvider,
	HttpClient = httpClientFactory.CreateClient("Auth0Management"),
	MaxRetries = 1,
	Timeout = TimeSpan.FromSeconds(10),
});
```

The Articles reference does the same in `Auth0ManagementApiClientFactory`: a singleton factory, a lazily created and
cached `ClientCredentialsTokenProvider`, and a new `ManagementClient` for each `CreateAsync`.

## Calls per use case

Calls are on `IManagementApiClient`. All methods take `(…, RequestOptions? options = null, CancellationToken cancellationToken = default)`.
`WithRawResponseTask<T>` (`…<T>` in the table) is an awaitable struct that yields `T`. `.WithRawResponse()` gives the status code, headers and URL.
Requests live in `Auth0.ManagementApi`, unless the namespace is given.

| Use case | Call | Request | Response | Paging |
| --- | --- | --- | --- | --- |
| List or search Users | `Users.ListAsync(ListUsersRequestParameters)` | `Q`, `Page`, `PerPage`, `IncludeTotals`, `Sort`, `Fields`, `SearchEngine` | `Task<Pager<UserResponseSchema>>` | Offset |
| Get one User | `Users.GetAsync(string id, GetUserRequestParameters)` | `Fields`, `IncludeFields` | `WithRawResponseTask<GetUserResponseContent>` | none |
| Update Profile Fields | `Users.UpdateAsync(string id, UpdateUserRequestContent)` | Profile Fields, `EmailVerified`, `VerifyEmail` | `…<UpdateUserResponseContent>` | none |
| List Roles | `Roles.ListAsync(ListRolesRequestParameters)` | `Page`, `PerPage`, `IncludeTotals`, `NameFilter`, `Type`, `OwnerId` | `Task<Pager<Role>>` | Offset |
| Create a Role | `Roles.CreateAsync(CreateRoleRequestContent)` | `Name` (required), `Description` | `WithRawResponseTask<CreateRoleResponseContent>` | none |
| List a User's Roles | `Users.Roles.ListAsync(string id, Users.ListUserRolesRequestParameters)` | `Page`, `PerPage`, `IncludeTotals` | `Task<Pager<Role>>` | Offset |
| Assign Roles | `Users.Roles.AssignAsync(string id, Users.AssignUserRolesRequestContent)` | `Roles` (role IDs, at least one) | `WithRawResponseTask` (204) | none |
| Remove Roles | `Users.Roles.DeleteAsync(string id, Users.DeleteUserRolesRequestContent)` | `Roles` (role IDs) | `WithRawResponseTask` (204) | none |
| Users holding a Role | `Roles.Users.ListAsync(string id, Roles.ListRoleUsersRequestParameters)` | `From`, `Take`, `IncludeTotals` | `Task<Pager<RoleUser>>` | Checkpoint |

Sources: `IUsersClient.cs`, `Users/Roles/IRolesClient.cs`, `Roles/IRolesClient.cs`, `Roles/Users/IUsersClient.cs` and
`Types/` at [`mgmt-10.5.0`][src]. The scratch build compiled every one of these calls.

### Paging

- `Pager<T>` is an interface: `IAsyncEnumerable<T>`, `CurrentPage`, `HasNextPage`, `GetNextPageAsync()` and
  `AsPagesAsync()`. `Page<T>` has `Items` and `Response` (the raw response object).
- Awaiting `ListAsync` already sends the first request.
- **Offset pagers stop only at an empty page.** `HasNextPage` is `items.Count > 0`, so `await foreach` over all Users
  always makes one extra request, and runs into Auth0's 1,000-record cap.
  - Past that cap, `GET /users` returns 400 "You can only page through the first 1000 records".
  - For a paged table, call `ListAsync` once with `Page` and `PerPage` and read `CurrentPage.Items`. Don't enumerate.
- **The total:** the SDK sets `IncludeTotals = true` by default, but Auth0 defaults it to false. Read the total with
  `((ListUsersOffsetPaginatedResponseContent)pager.CurrentPage.Response).Total`, which is a `double?`.
  `ListRolesOffsetPaginatedResponseContent.Total` is a required `double`.
- **Limits on `GET /users`:**
  - `per_page` is at most 100 in the endpoint reference, or 50 on Public Cloud per the paging guide, so use 50 or fewer.
  - `page` is zero-based.
  - `q` takes Lucene syntax and needs `search_engine` v3. v1 can't take `q`, and v2 is refused in favour of v3.
  - Search is eventually consistent, runs under a query limit of about 2 s, and returns 503 when a query is too heavy.
  - Put a wildcard only at the end of a term.
  - A User that was just changed may not show in the list yet. After a write, read that User back with `GetAsync`.
- **Users holding a Role** uses checkpoint paging (`CursorPager`): `Take` is at most 100, and you pass the response's
  `Next` as `From`. Offset paging on this endpoint stops at 1,000, which is why the SDK uses checkpoint paging.
  `ListRoleUsersPaginatedResponseContent` has no total.

### Profile Fields types

- `UpdateUserRequestContent` uses `Optional<string?>` for `Name`, `GivenName`, `FamilyName`, `Nickname`, `Picture`
  and `Email`.
  - Leave a field unset and it is left out of the request.
  - Setting it to `null` clears the field, which Auth0 allows only for some connections.
  - `string` converts to it implicitly.
  - `EmailVerified` and `VerifyEmail` are `bool?`.
  - For the map's rule that an email change makes the address unverified without sending a verification email, send
    `Email`, `EmailVerified = false` and `VerifyEmail = false` together.
- `GetUserResponseContent` and `UserResponseSchema` carry `Identities` (`UserIdentitySchema`: `Connection`, `Provider`,
  `IsSocial`, `UserId`, `ProfileData`). We can read these to tell which Profile Fields a User's connection lets us
  change before trying.
- `UserIdentitySchema` also has `AccessToken`, `RefreshToken` and `AccessTokenSecret`. These are the IdP's tokens, and
  Auth0 returns them only with `read:user_idp_tokens`, which we don't grant. Never pass the SDK type to a component:
  copy the fields we need into our own record.
- Field lengths, from the [user profile structure][profile-structure]: `name`, `given_name` and `family_name` take 1 to 150
  characters, and `nickname` 1 to 350. `picture` is a URL. Auth0 lowercases email addresses on database connections.

## Errors

`ManagementApiException : ManagementException : Exception`, from `Core/Public/ManagementApiException.cs`, carries:

- `StatusCode` (`int`) and `Body`.
- `ApiError`: the parsed `error`, `errorCode` or `error_code`, and `message` or `error_description`.
- `ErrorCode` and `Description`, read from `ApiError`.
- `RateLimit`: the parsed `x-ratelimit-*` and `retry-after` headers.
- `RawResponse`.

`Message` returns the API's message when it has one. Each subclass is named after its status code, in namespace
`Auth0.ManagementApi`: `BadRequestError` (400), `UnauthorizedError` (401), `ForbiddenError` (403), `NotFoundError` (404),
`ConflictError` (409), `TooManyRequestsError` (429), `ServiceUnavailableError` (503) and others.

Each endpoint throws a subclass only for the codes its OpenAPI spec lists. Any other code, or an error body that isn't
JSON, throws a plain `ManagementApiException` with `StatusCode` set. Network failures surface as
`HttpRequestException`, and timeouts as `TaskCanceledException`.

| Call | Typed exceptions (besides 401 and 403) | Notes |
| --- | --- | --- |
| `Users.ListAsync` | 400, 429, 503 | 400 means a bad `q` or paging past 1,000; 503 means the search timed out |
| `Users.GetAsync` | 400, 404, 429 | |
| `Users.UpdateAsync` | 400, 404, 429 | No 409 is mapped. Refused Profile Fields come back as **400** (see below) |
| `Roles.ListAsync` | 400, 429 | |
| `Roles.CreateAsync` | 400, 409, 429 | 409 means the Role already exists |
| `Users.Roles.ListAsync` | 400, 404, 429 | 404 means the User wasn't found |
| `Users.Roles.AssignAsync` | 400, 404, 429 | 404 means the User wasn't found |
| `Users.Roles.DeleteAsync` | 404, 429 | No 400 is mapped, so a 400 arrives as a plain `ManagementApiException` |
| `Roles.Users.ListAsync` | 400, 404, 429 | 404 means the Role wasn't found |

Proposed mapping to `Result` error codes. A status code means different things on different calls (a 404 is a missing
User on one and a missing Role on another), so each call maps its own codes:

| Call | Status | Error code |
| --- | --- | --- |
| `Users.ListAsync` | 400 | `Validation`: a bad `q` or paging past 1,000 |
| `Users.ListAsync` | 503 | `User.SearchTooBroad`: the search timed out, so the Admin narrows it |
| `Users.GetAsync`, `Users.Roles.*` | 404 | `User.NotFound` |
| `Users.UpdateAsync` | 404 | `User.NotFound` |
| `Users.UpdateAsync` | 400 | `User.FieldNotEditable`, with `ex.Description` |
| `Users.UpdateAsync` | 409 | `User.EmailInUse`, if a duplicate email returns 409 (see [Not verified](#not-verified)) |
| `Roles.CreateAsync` | 409 | `Role.AlreadyExists` |
| `Roles.Users.ListAsync` | 404 | `Role.NotFound` |
| Any call | 429 | `Auth0.RateLimited`, with `ex.RateLimit` |

```csharp
// In the adapter's UpdateProfileFieldsAsync, for example:
catch (ManagementApiException ex) when (ex.StatusCode == 404) { return Result.Fail("User.NotFound", …); }
catch (ManagementApiException ex) when (ex.StatusCode == 400) { return Result.Fail("User.FieldNotEditable", ex.Description); }
catch (ManagementApiException ex) when (ex.StatusCode == 409) { return Result.Fail("User.EmailInUse", …); }
catch (ManagementApiException ex) when (ex.StatusCode == 429) { return Result.Fail("Auth0.RateLimited", …); } // ex.RateLimit
```

Use the `StatusCode` filter, not the subclass. It works the same for an endpoint whose spec leaves out a code, such as a
400 from `Users.Roles.DeleteAsync`. Other codes (401, 403, and 5xx except the search's 503) are configuration or outage
failures, so let them throw, as the coding standards say.

The search's 503 comes from the Admin's query, not from an outage. The SDK retries it like any 5xx before it throws, so
each retry re-runs a query that already timed out. Keep `MaxRetries` low for the list call, or the Admin waits through
every retry before seeing `User.SearchTooBroad`.

## Profile Fields refused by connection type

From the [PATCH /users/{id} reference][patch-user] and the [root attributes page][root-attrs]:

| Connection | name, given_name, family_name, nickname, picture | email | email_verified |
| --- | --- | --- | --- |
| Database (Auth0 is the IdP) | Editable | Editable | Editable |
| Passwordless email or SMS | Editable | 400 "Cannot update email for non-database user." | Not for SMS: "not supported for enterprise and passwordless sms connections" |
| Social | Editable only with sync off; otherwise 400 "The following user attributes cannot be updated: …" | 400 "Cannot update email for non-database user." | Editable |
| Enterprise | Same as social | 400 "Cannot update email for non-database user." | 400 "Email verification is not supported for enterprise users." |

- **The sync setting:** "Sync user profile attributes at each login" is the connection option `set_user_root_attributes`.
  It is `on_each_login` (the default) or `on_first_login` ([configure connection sync][sync]). While it is on, the IdP
  owns these fields and overwrites them at every login, so Auth0 refuses the change.
- **Other 400s worth mapping:**
  - "Cannot change email or password for users in a disabled connection."
  - "Cannot update username and email simultaneously." This doesn't apply to us, since username is out of scope.
  - Changing `email` or `email_verified` on a linked secondary identity needs `Connection` set.
- **Telling the 400s apart:** they differ only by message text. The SDK's `ErrorCode` is whatever Auth0 sends in
  `errorCode`, which these docs don't list. The safest plan is to work out which fields can be edited from `Identities`
  before showing the form, and to treat a 400 from the update as `User.FieldNotEditable` with `ex.Description`.

## Permissions

| Call | Scopes Auth0's reference lists |
| --- | --- |
| `GET /users`, `GET /users/{id}` | `read:users` |
| `PATCH /users/{id}` | any of `update:users`, `update:users_app_metadata`, `update:current_user_metadata` |
| `GET /roles` | `read:roles` |
| `POST /roles` | `create:roles` |
| `GET /users/{id}/roles` | `read:users`, `read:roles`, **`read:role_members`** (its 403 text says "expected all of") |
| `POST /users/{id}/roles` | `update:users`, `create:role_members` |
| `DELETE /users/{id}/roles` | `delete:role_members` (by the same pattern; not fetched) |
| `GET /roles/{id}/users` | `read:users`, `read:roles`, `read:role_members` (its 403 text names only the first two) |

`read:role_members` isn't one of the six in `CLAUDE.md`. Add it unless a live Tenant shows the two list calls work without it.

## Testing seam

- The SDK exposes `IManagementApiClient` and an interface per sub-client: `IUsersClient`, `Users.IRolesClient`,
  `IRolesClient` and `Roles.IUsersClient`. Its [README][readme] suggests mocking them.
- Substituting them directly is awkward, as a scratch NSubstitute 5.3 run showed:
  - Recursive substitutes work: `client.Users.Roles` is non-null without setup.
  - An unconfigured `GetAsync` **throws `NullReferenceException`**. `WithRawResponseTask<T>` is a struct, so the default
    value wraps a null task.
  - Every stub has to return `new WithRawResponseTask<T>(Task.FromResult(new WithRawResponse<T> { Data = …, RawResponse = … }))`.
    `RawResponse` needs a `ResponseHeaders`, which only `FromHttpResponseMessage` can build.
  - `Pager<T>` stubs need a hand-written `IAsyncEnumerable`.
- So: keep the map's decision. Put our own narrow interface in front of the SDK, with methods named after the use cases
  and returning our records or `Result`, and substitute that.
  - Unit-test the adapter itself against a stub `HttpMessageHandler` passed as `ManagementClientOptions.HttpClient`,
    with a `DelegateTokenProvider` returning a fixed token.
  - Then real SDK serialization and error mapping run offline. That suits the Sandcastle sandbox, which has no Auth0
    credentials.

## Compared with mpaulosky/Articles

`mpaulosky/Articles` (`src/Web/Components/Features/UserManagement/`):

| Aspect | Articles | This feature |
| --- | --- | --- |
| Version | 10.4.0 | 10.5.0 (no API change we use) |
| Client | A singleton factory builds a `ManagementClient` per call over one cached `ClientCredentialsTokenProvider` | Same shape; settings through `IOptions`, not `IConfiguration` |
| Calls | `Users.ListAsync`, `Users.Roles.ListAsync`, `Users.Roles.AssignAsync`, `.DeleteAsync`, `Roles.ListAsync` | Adds `Users.GetAsync`/`UpdateAsync`, `Roles.CreateAsync`, `Roles.Users.ListAsync` |
| Paging | `await foreach` over every User, then a Roles call per User | One page per request; Roles per User only on the detail page |
| Errors | Catches `HttpRequestException`, `InvalidOperationException`, `Exception`: 404, 409 and 429 become a generic message | Map `ManagementApiException.StatusCode` to stable codes |
| Seam | Handlers depend on the factory, which returns the SDK's `IManagementApiClient` | Our own use-case interface; the SDK stays behind it |
| Cache | Redis | In-memory, short-lived (map decision) |

## Not verified

- The Management API rate limits for each Tenant type: the [endpoint rate limits page][ratelimits] defers to another page.
  The SDK's retry and `RateLimit` parsing cover how we handle a 429 either way.
- The `errorCode` values Auth0 returns for each refused-field 400: the reference documents only message text.
- Whether `read:role_members` is needed in practice: the reference contradicts itself, so check it against a Tenant.
- The scope list for `DELETE /users/{id}/roles`: inferred from `POST`, not fetched.
- Whether a duplicate email on `PATCH` returns 400 or 409: not documented. If it's 409, the SDK throws a plain
  `ManagementApiException`, and `UpdateAsync`'s own 409 mapping turns it into `User.EmailInUse`.

[nuget-index]: https://api.nuget.org/v3-flatcontainer/auth0.managementapi/index.json
[nuspec]: https://api.nuget.org/v3-flatcontainer/auth0.managementapi/10.5.0/auth0.managementapi.nuspec
[rel-1050]: https://github.com/auth0/auth0.net/releases/tag/mgmt-10.5.0
[rel-1000]: https://github.com/auth0/auth0.net/releases/tag/mgmt-10.0.0
[src]: https://github.com/auth0/auth0.net/tree/mgmt-10.5.0/src/Auth0.ManagementApi
[readme]: https://github.com/auth0/auth0.net/blob/mgmt-10.5.0/README.md#interfaces
[patch-user]: https://auth0.com/docs/api/management/v2/users/patch-users-by-id
[root-attrs]: https://auth0.com/docs/manage-users/user-accounts/user-profiles/root-attributes
[sync]: https://auth0.com/docs/manage-users/user-accounts/user-profiles/configure-connection-sync-with-auth0
[profile-structure]: https://auth0.com/docs/manage-users/user-accounts/user-profiles/user-profile-structure
[ratelimits]: https://auth0.com/docs/troubleshoot/customer-support/operational-policies/rate-limit-policy/management-api-endpoint-rate-limits
