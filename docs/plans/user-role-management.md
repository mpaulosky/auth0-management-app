# User and Role Management

This is the spec for the pages an Admin uses to manage the Tenant's Users and Roles:

- list and search Users
- edit a User's Profile Fields
- assign and remove a User's Roles
- list the Roles and the Users who hold them
- create a Role

It was charted on the map [Map: Manage Users and Roles](https://github.com/mpaulosky/auth0-management-app/issues/11).
Each section links the ticket that holds the reasoning. This document says *what* to build, and the tickets say *why*.
[ADR 0009](../adr/0009-one-deep-management-api-seam.md) records the Management API seam, and [ADR 0010](../adr/0010-interactive-server-management-pages.md) records why the
management pages render interactively.
The work is split into the issues in [Implementation issues](#implementation-issues).

## Principles

- **The domain terms** are those in [CONTEXT.md](../../CONTEXT.md): Tenant, Management API, Visitor, User, Admin, Role, Profile Fields.
  `User` is both a domain term (a person in the Tenant) and the name of a Role. Where this spec means the Role, it writes the `User` Role.
- **`CLAUDE.md`'s Management API rules hold throughout:**
  - A Machine to Machine application of its own, with only the permissions in the README's table.
  - The token never reaches the browser or the logs.
  - Every page that reads or changes Users or Roles carries `[Authorize]` with the Admin policy.
  - Failures come back as a failed `Result` with a stable code.
- **Every acceptance criterion is testable offline.** The Sandcastle sandbox has no Auth0 credentials, so tests run against fakes. Tests against the testing Tenant skip
  when its settings are absent ([Testing](#testing)).
- **The last save wins.** There's no conflict detection.
- **A Role change takes effect at the User's next sign-in**, when Auth0 issues a new ID token.

## Pages and routes

Decided in [What do the Users, User detail and Roles pages look like?](https://github.com/mpaulosky/auth0-management-app/issues/17). The throwaway prototype is on the branch
[`prototype/management-pages`](https://github.com/mpaulosky/auth0-management-app/tree/prototype/management-pages): run `pnpm prototype` there, then open
`http://localhost:5112/admin/prototype?variant=A|B|C`.

Every page below uses the existing `Card`, `Badge`, `Button` and `PageHeader` components and follows the Theme and Palette rules in
[CODING_STANDARDS.md](../CODING_STANDARDS.md#blazor). Only `/admin/users` and `/admin/roles` are `@rendermode InteractiveServer` ([ADR 0010](../adr/0010-interactive-server-management-pages.md)).

### The landing page, `/admin`

This is variant A's landing page. It is **open to everyone** and stays statically rendered.

- It explains what the management pages do and shows **Manage Users** (to `/admin/users`) and **Manage Roles** (to `/admin/roles`) buttons.
- The buttons are disabled unless the signed-in User holds `Admin`.
- **Only an Admin sees Tenant data on it:** `StatTile`s with the counts of Users, Admins and Roles. A Visitor or non-Admin User sees the explanation and the disabled buttons,
  with no counts.
- The counts come from:
  - Users: the search total with an empty query.
  - Admins: `CountRoleMembersAsync(Admin, atMost: 1000)`, shown as "1,000+" at the cap.
  - Roles: the `ListRolesAsync` count.

  They sit inside the [Management API error boundary](#where-each-failure-shows).

### The Users page, `/admin/users?q=&page=&user={id}`

This is variant B's master-detail page, behind the Admin policy.

- **On the left:** the search box and the paged User list ([Search and paging](#search-and-paging)).
- **On the right:** the selected User, or a prompt to pick one.
- **The selected User is in the URL** (`user={id}`), so the selection survives a reload and can be bookmarked.
- **The detail pane** shows:
  - The User's picture, name and email, with `email_verified` as a read-only **Verified** or **Unverified** badge.
  - The connection and the last sign-in.
  - Their Profile Fields, read-only, with an **Edit Profile Fields** button that opens the form ([Profile Fields](#profile-fields)).
  - Their Roles as chips, with a × to remove each one, and a **+ Add a Role** dropdown listing the Roles they don't hold ([Roles on a User](#roles-on-a-user)).

### The Roles page, `/admin/roles?role={id}`

This is variant C's console without its User drawer, behind the Admin policy.

- **A strip of Role tiles**, each with its name, its description and the count of Users who hold it. At the [member cap](#the-member-cap) the count shows as "1,000+".
- **A Create Role button** that opens the dialog in [Creating a Role](#creating-a-role).
- **The User table.**
  - Picking a tile filters it to the Users who hold that Role, and sets `role={id}` in the URL. With no Role picked, it lists the first page of Users from the search.
  - It has a column per Role, with a check where the User holds that Role.
  - Each row links to that User on the Users page (`/admin/users?user={id}`).

### Moving between pages

- The Users and Roles pages share a **Users | Roles** tab switch at the top. Each page renders it itself, because the two slices don't share components.
- The **Admin** nav link shows for everyone, not only Admins, and goes to `/admin`.
- **An old link to `/admin/users` or `/admin/roles`:**
  - A Visitor is sent to sign in, which is the existing challenge.
  - A signed-in User without `Admin` gets the existing Access denied page, `/authentication/access-denied`, which returns 403.
- **`CONTEXT.md` changes to match:** the `/admin` landing page is public, and every page that reads or changes Users or Roles is Admin-only.

## The Management API seam

Decided in:

- [Which Auth0.ManagementApi SDK version and calls does the feature use?](https://github.com/mpaulosky/auth0-management-app/issues/12)
- [What is the Management API seam the Users and Roles slices call?](https://github.com/mpaulosky/auth0-management-app/issues/14)
- [What limits do Auth0's User search, paging and rate limits put on the User list?](https://github.com/mpaulosky/auth0-management-app/issues/13)

These are recorded in [ADR 0009](../adr/0009-one-deep-management-api-seam.md). The facts behind them are in the
[SDK findings](../research/auth0-management-sdk.md) and the [rate limit findings](../research/auth0-user-search-and-rate-limits.md).

### Where it lives

All of it is in `src/UI/ManagementApi/`, in the namespace `UI.ManagementApi`. Only `IManagementApi`, its records and `AddManagementApi()` are public. Everything else is
`internal`.

- **The package:** `Auth0.ManagementApi` **10.5.0** goes in `Directory.Packages.props`, with a version-less reference in `src/UI/UI.csproj`.
- **The token:** a singleton `ClientCredentialsTokenProvider(domain, clientId, clientSecret, httpClient: …)`, given a client from the named `HttpClient` `"Auth0Management"`.
- **The client:** a `ManagementClient` built for each call, with `Domain`, that `TokenProvider`, a client from the `"Auth0Management"` `HttpClient`, `MaxRetries = 1` and
  `Timeout = 10 s`. All are fixed in code.
- **The adapter:** it translates our calls into the SDK's, pages, maps exceptions and builds our records.
- **The client-side rate limiter:** a singleton `TokenBucketRateLimiter` that every call acquires a token from before it reaches Auth0 ([The rate limiter](#the-rate-limiter)).
- **`CachedManagementApi`:** the decorator in front of the adapter ([The cache](#the-cache)).
- **What tests use:** `IManagementApi` is the only seam. There's no factory interface.

### The interface

```csharp
public interface IManagementApi
{
	Task<Result<UserPage>> SearchUsersAsync(UserSearch search, CancellationToken cancellationToken);
	Task<Result<UserDetails>> GetUserAsync(string userId, CancellationToken cancellationToken);
	Task<Result> UpdateProfileFieldsAsync(string userId, ProfileFieldsChange change, CancellationToken cancellationToken);
	Task<Result> AssignRoleAsync(string userId, string roleId, CancellationToken cancellationToken);
	Task<Result> RemoveRoleAsync(string userId, string roleId, CancellationToken cancellationToken);
	Task<Result<IReadOnlyList<RoleSummary>>> ListRolesAsync(CancellationToken cancellationToken);
	Task<Result<RoleSummary>> CreateRoleAsync(NewRole role, CancellationToken cancellationToken);
	Task<Result<RoleMembers>> ListRoleMembersAsync(string roleId, CancellationToken cancellationToken);
	Task<Result<int>> CountRoleMembersAsync(string roleId, int atMost, CancellationToken cancellationToken);
}
```

### The records

All of these are our own types, never the SDK's. The SDK's `UserIdentitySchema` carries identity-provider tokens, so it never reaches a component.

| Record | Members |
| --- | --- |
| `UserSearch` | `string? Query`, `int Page` (1-based), `int PerPage` |
| `UserPage` | `IReadOnlyList<UserSummary> Users`, `int Total` (Auth0's real total, which can exceed 1000) |
| `UserSummary` | `Id`, `Name`, `Email`, `Picture`, `Connection` |
| `UserDetails` | `Id`, the six Profile Fields (`Name`, `GivenName`, `FamilyName`, `Nickname`, `Picture`, `Email`), `EmailVerified`, `Connection`, `LastLogin`, `EditableFields`, `Roles` (`IReadOnlyList<RoleSummary>`) |
| `ProfileFieldsChange` | six `string?` properties, one per Profile Field (see [The command](#the-command)) |
| `RoleSummary` | `Id`, `Name`, `Description` |
| `NewRole` | `Name`, `Description` |
| `RoleMembers` | `IReadOnlyList<UserSummary> Users`, `bool Truncated` |

`EditableFields` is a `[Flags]` enum, `ProfileField`, computed by the adapter from the User's identities ([Locked fields](#locked-fields)). `UserDetails.Roles` comes from
`Users.Roles.ListAsync`.

### The SDK calls

| Method | Call |
| --- | --- |
| `SearchUsersAsync` | `Users.ListAsync(ListUsersRequestParameters { Q, Page = page - 1, PerPage, IncludeTotals = true, SearchEngine = V3, Sort = "name:1" })`, one call per page. The total comes from `(ListUsersOffsetPaginatedResponseContent)pager.CurrentPage.Response`. |
| `GetUserAsync` | `Users.GetAsync(id, …)` and `Users.Roles.ListAsync(id, …)` |
| `UpdateProfileFieldsAsync` | `Users.UpdateAsync(id, UpdateUserRequestContent { … })` with only the changed fields set |
| `AssignRoleAsync` | `Users.Roles.AssignAsync(id, AssignUserRolesRequestContent { Roles = [roleId] })` |
| `RemoveRoleAsync` | `Users.Roles.DeleteAsync(id, DeleteUserRolesRequestContent { Roles = [roleId] })` |
| `ListRolesAsync` | `Roles.ListAsync(…)`, every page |
| `CreateRoleAsync` | `Roles.CreateAsync(CreateRoleRequestContent { Name, Description })` |
| `ListRoleMembersAsync` | `Roles.Users.ListAsync(id, ListRoleUsersRequestParameters { From, Take = 100 })`, checkpoint paging, up to the [member cap](#the-member-cap) |
| `CountRoleMembersAsync` | the same call, stopping as soon as `atMost` members have been seen, never cached |

### The member cap

- `ListRoleMembersAsync` stops after **1000 members**, which is 10 checkpoint pages. It returns the members it fetched, with `Truncated = true` when there were more.
- `CountRoleMembersAsync(roleId, atMost)` returns `min(members, atMost)`, and stops paging once it reaches `atMost`.
- A 429 on any page fails the whole call with `ManagementApi.RateLimited`. A partial membership is never returned.

### The rate limiter

Every call acquires a token from a `TokenBucketRateLimiter` before it reaches Auth0. The bucket matches Auth0's own. The limiter queues calls in order, and a call still
waiting after `QueueTimeout` fails with `ManagementApi.RateLimited`.

### Options

`ManagementApiOptions` is bound from `Auth0:Management` with `AddOptions<ManagementApiOptions>().BindConfiguration("Auth0:Management").ValidateDataAnnotations().ValidateOnStart()`.

| Setting | Rule | Default |
| --- | --- | --- |
| `Domain` | `[Required]`, no scheme | none |
| `ClientId` | `[Required]` | none |
| `ClientSecret` | `[Required]` | none |
| `PermitsPerSecond` | `[Range(1, 100)]` | 2 (the Free tier) |
| `Burst` | `[Range(1, 100)]` | 2 |
| `QueueTimeout` | `[Range]` from 1 to 30 s | 5 s |

These are never the sign-in application's `Auth0:*` credentials.

### Registration

`AddManagementApi()` registers all of it with `TryAdd*`, so `AddUsersFeature()` and `AddRolesFeature()` can both call it. `IManagementApi` resolves to `CachedManagementApi`
wrapping the adapter.

## Search and paging

Decided in [How do the User list's search, paging and cache work?](https://github.com/mpaulosky/auth0-management-app/issues/16).

### The query

- **What it matches:** a prefix of the email, name, given name or family name:
  `q=email:<t>* OR name:<t>* OR given_name:<t>* OR family_name:<t>*` with `search_engine=v3`. These are normalized fields, so case doesn't matter.
- **The input:**
  - It's trimmed.
  - Lucene's special characters are escaped with `\`: `+ - && || ! ( ) { } [ ] ^ " ~ * ? : \ /`.
  - An empty box sends no `q` and lists every User.
- **The sort order** is `name:1`.
- **The placeholder** reads "Search name or email".
- **Building `q`** is a pure function in the Users slice, with its own unit tests.

### When it searches

- **As the Admin types,** with a **400 ms** debounce that waits on the injected `TimeProvider`. **Enter** searches at once.
- **A newer search** cancels the one in flight through its `CancellationToken`.
- **A new search** goes back to page 1.
- **The URL:** `q`, `page` and `user` are written with `NavigationManager.NavigateTo(…, replace: true)`, so Back doesn't step through each keystroke.

### Paging

- **25 per page,** fixed in code.
- **The controls** are the prototype's: "‹ Prev", "Page x of y · N Users" and "Next ›".
- **`page` in the URL** is 1-based. A value below 1 or not a number is treated as 1, and one past the last reachable page shows the last reachable page.
- **The 1000 cap:**
  - The reachable page count is `min(ceil(total / 25), 40)`, a pure rule in the handler.
  - Next is disabled on the last reachable page.
  - When `total > 1000`, a note reads "Auth0 shows only the first 1,000 of N matches. Narrow the search."
  - A page past the cap is clamped, and is never sent to Auth0.

### Rows

- Each row shows the User's picture or initials, their name and their email.
- Users who hold `Admin` get an **Admin** badge. The badge comes from one cached `ListRoleMembersAsync(Admin)`, with the `Admin` id looked up through `ListRolesAsync`, never
  from one request per User.
- A User's full set of Roles shows only in the detail pane.

### The request

| Request | Rules | Code |
| --- | --- | --- |
| `SearchUsersQuery(string? Query, int Page)` | `Query` at most 100 characters after trimming, `Page` at least 1 | `User.SearchInvalid` |

`SearchUsersHandler` returns `Result<UserListPage>`. It holds the Users, the total, the reachable page count, whether the cap note shows, and the ids of the Users who hold
`Admin`.

## The cache

Decided in [How do the User list's search, paging and cache work?](https://github.com/mpaulosky/auth0-management-app/issues/16).

`CachedManagementApi` holds Tenant data, which is the same for every Admin. That makes it safe as a singleton.

- **What it caches:** only successful `Result`s. Failures, 429s included, are never cached.
- **Size:** the cache has its own `MemoryCache` with `SizeLimit = 1000`, and each entry has size 1.
- **Expiry:** each entry stores the time it expires, computed from the injected `TimeProvider`, and the decorator treats an entry as missing once
  `TimeProvider.GetUtcNow()` passes it. The same lifetime also goes on the `MemoryCache` entry as `AbsoluteExpirationRelativeToNow`, so memory is freed. A
  `FakeTimeProvider` can therefore drive expiry in tests: `MemoryCacheOptions.Clock` is an `ISystemClock`, not a `TimeProvider`.

| Entry | Key | Lifetime |
| --- | --- | --- |
| A search page | the normalized query (trimmed, lower-case), the page and the page size | 30 s |
| One User | user id | 60 s |
| The Role list | one key | 5 min |
| A Role's members | role id | 60 s |

`CountRoleMembersAsync` and every write go straight to the adapter.

**What each write makes stale:**

- `UpdateProfileFieldsAsync(user)`: evict that User and every search page. The search pages share a `CancellationChangeToken`, so they can be dropped together.
  Auth0's search lags behind a save, so the Users page also patches the saved User's row in the page it has loaded.
- `AssignRoleAsync` or `RemoveRoleAsync(user, role)`: evict that User and that Role's members.
- `CreateRoleAsync`: evict the Role list.

**There's no Refresh button.** A change made in the Auth0 Dashboard shows up when the entry expires.

## Profile Fields

Decided in [Which Profile Fields does the editor show, and how are they validated?](https://github.com/mpaulosky/auth0-management-app/issues/15).

### Locked fields

The adapter computes `EditableFields` from the User's identities, assuming Auth0's default sync setting:

| Connection | Editable |
| --- | --- |
| Database | all six |
| Passwordless | name, given name, family name, nickname, picture (not email) |
| Social or enterprise | none, because "Sync user profile attributes at each login" is on by default |

- **On the form:** a locked field is shown disabled, with a "Synced by Auth0" badge and the reason.
- **No `read:connections` permission:** the app never reads a connection's sync setting. The known cost is that a social or enterprise User whose connection has sync turned
  off shows as locked even though Auth0 would accept the change.

### Validation

`UpdateProfileFieldsCommandValidator` trims every value first. A blank optional field means "clear it".

| Field | Rule | Code |
| --- | --- | --- |
| Name | Required, 1 to 150 characters | `User.NameRequired`, `User.NameTooLong` |
| Given name | Optional, up to 150 characters | `User.GivenNameTooLong` |
| Family name | Optional, up to 150 characters | `User.FamilyNameTooLong` |
| Nickname | Optional, up to 350 characters | `User.NicknameTooLong` |
| Picture URL | Optional, an absolute `https://` URL, up to 2,048 characters | `User.PictureInvalid` |
| Email | Required, a valid address, up to 254 characters | `User.EmailInvalid` |
| The change as a whole | At least one field changed | `User.NoChanges` |

The 150 and 350 limits are Auth0's. The 2,048 and 254 caps are ours.

### The command

`UpdateProfileFieldsCommand(string AdminId, string UserId, ProfileFieldsChange Change)` sends only the fields that changed.

- **Filling it in:** the form compares against the `UserDetails` it loaded and fills in only what the Admin edited. This diff is a pure function with its own unit tests.
- **Each property of `ProfileFieldsChange`:** each of the six is a `string?`. `null` leaves the field alone, and `""` clears it. Clearing is allowed only for the optional
  fields.
- **The adapter:** it leaves a `null` property out of the request, and turns `""` into the SDK's `null`.
- **Email:**
  - It counts as changed only when it differs ignoring case.
  - A real change sends `Email` with `EmailVerified = false` and `VerifyEmail = false`. No verification email is sent.
  - Admins can't set `email_verified`.

### Where validation runs

- **In the form:** the `InteractiveServer` form runs the validator itself on submit, and shows each failure under its field, matched by `PropertyName`. No
  FluentValidation-to-`EditForm` package is added.
- **In the handler:** it validates again, and returns a failure as a `Result` with the code in `Details`.
- **Other failures:** handler and Auth0 failures, such as `User.FieldNotEditable`, show in one `Alert` above Save.
- **After a successful save:** the pane shows the new values, and the Users page patches that User's row in its loaded page.

## Roles on a User

Decided in [What is the Management API seam the Users and Roles slices call?](https://github.com/mpaulosky/auth0-management-app/issues/14), with the guard amended in
[ADR 0009](../adr/0009-one-deep-management-api-seam.md).

- **The commands:** `AssignRoleCommand(string AdminId, string UserId, string RoleId)` and `RemoveRoleCommand(string AdminId, string UserId, string RoleId)`.
- **No-ops:** assigning a Role the User already holds, or removing one they don't hold, succeeds. Auth0 treats both as no-ops.
- **The UI:** it offers only the Roles that make sense: the dropdown lists the Roles the User doesn't hold, and each chip's × removes a Role they do hold.
- **The next-sign-in note:** every Role change shows "Takes effect at their next sign-in" under the chips.

### The last-Admin guard

It lives in `RemoveRoleHandler`, and applies only when the Role being removed is `Admin`. The handler finds the `Admin` id through `ListRolesAsync`.

1. **Before removing,** it calls `CountRoleMembersAsync(Admin, atMost: 2)`, which is uncached. If the count is below 2, it refuses with `User.LastAdmin` and never calls
   `RemoveRoleAsync`.
2. **It removes the Role.**
3. **After removing,** it calls `CountRoleMembersAsync(Admin, atMost: 1)` again. If it's 0, because another Admin removed theirs at the same moment, it calls
   `AssignRoleAsync` to put the Role back and returns `User.LastAdmin`.

Removing your own `Admin` is allowed while another Admin exists. If the restore itself fails, the Tenant has no Admin until someone fixes it in the Auth0 Dashboard. The
handler logs that at Critical.

## Creating a Role

Decided in [Which failures can each use case return, and what does the Admin see?](https://github.com/mpaulosky/auth0-management-app/issues/18).

The Create Role dialog has Name and Description fields. `CreateRoleCommand(string AdminId, string Name, string? Description)` is checked by `CreateRoleCommandValidator`,
which trims first:

| Field | Rule | Code |
| --- | --- | --- |
| Name | Required, 1 to 100 characters | `Role.NameRequired`, `Role.NameTooLong` |
| Description | Optional, up to 500 characters | `Role.DescriptionTooLong` |

- **The limits are ours.** Auth0's reference states no limit for either field.
- **Duplicates:** `Role.AlreadyExists` comes from Auth0's 409. The app doesn't compare names itself, because Auth0 doesn't document whether its comparison ignores case.
  It shows under the Name field.
- **On success:** the dialog closes, and the new Role's tile appears, with 0 members.

## Failures

Decided in [Which failures can each use case return, and what does the Admin see?](https://github.com/mpaulosky/auth0-management-app/issues/18).

### The Shared Kernel

`ResultErrorCode` gains `RateLimited = 6`. The stable code goes in `Result.Details` and the message in `Result.Error`, as the Palette and Theme handlers already do it.

### The catalogue

Every use case can also return `ManagementApi.RateLimited` (`RateLimited`). The adapter maps on `StatusCode`, never on the SDK's exception subclass. Anything not listed
throws.

| Use case | Code | Category | Cause |
| --- | --- | --- | --- |
| Search Users | `User.SearchInvalid` | Validation | the validator |
| | `User.SearchTooBroad` | Validation | Auth0's 503 for a query that runs over about 2 s, mapped on the search call only |
| Get a User | `User.NotFound` | NotFound | 404 |
| Update Profile Fields | the field codes and `User.NoChanges` | Validation | the validator |
| | `User.NotFound` | NotFound | 404 |
| | `User.EmailInUse` | Conflict | 409 |
| | `User.FieldNotEditable` | Validation | any other 400, carrying Auth0's message |
| Assign a Role | `User.NotFound`, `Role.NotFound` | NotFound | 404. The adapter reads Auth0's message to tell which one is missing. |
| Remove a Role | `User.NotFound`, `Role.NotFound` | NotFound | 404 |
| | `User.LastAdmin` | Conflict | the handler's guard |
| List Roles | none of its own | | |
| Create a Role | `Role.NameRequired`, `Role.NameTooLong`, `Role.DescriptionTooLong` | Validation | the validator |
| | `Role.AlreadyExists` | Conflict | 409 |
| List or count a Role's members | `Role.NotFound` | NotFound | 404 |

### Rate limits

- **429:** a 429 that's still refused after the SDK's one retry, and a call that waits longer than `QueueTimeout` for the client-side limiter, both return
  `ManagementApi.RateLimited`.
- **The message:** the Admin sees an inline `Alert`, "Auth0 is rate limiting the app. Try again in N seconds."
  - N is worked out from `X-RateLimit-Reset`, a UNIX time in seconds, against the injected `TimeProvider`, and is at least 1.
  - Without that header, or for a limiter timeout, the message says "in a few seconds".
  - This calculation is a pure function with its own unit tests.
- **Nothing retries automatically,** and the Admin's input stays in place.

### Unreachable or misconfigured

- **Missing settings:** the app won't start, because of `ValidateOnStart`.
- **What throws:**
  - a failed token exchange (`Auth0.Core.Exceptions.ErrorApiException`, a wrong secret)
  - a 403 (a missing permission)
  - a 5xx or a timeout after the retry
- **Logging:** each is logged at Error. The token exchange and 403 logs carry a hint naming the `Auth0:Management:*` settings and the README's permission table.

### Where each failure shows

- **The error boundary:** the management content of `/admin/users`, `/admin/roles` and the counts on `/admin` sits in a shared `ManagementApiErrorBoundary`
  (`Components/Shared/`), an `<ErrorBoundary>`.
  - It shows "The app couldn't reach Auth0's Management API. Try again, or ask whoever runs the app to check its Auth0 Management settings."
  - Its **Try again** button calls `Recover()`.
- **A validation code** shows under its field.
- **`User.NotFound`** for the selected User replaces the detail pane with "This User no longer exists in the Tenant." The list stays, and a stale `?user=` shows the same
  message.
- **`Role.NotFound`** on the Roles page shows "This Role no longer exists in the Tenant." in place of the User table.
- **`User.LastAdmin`** shows inline under the Role chips: "{Name} is the Tenant's last Admin. Make another User an Admin first."
- **`Role.AlreadyExists`** shows under the dialog's Name field.
- **Everything else** shows in one `Alert` beside the action that failed: above Save, under the chips, or at the top of the dialog.

### `Alert`

`Components/Shared/Alert.razor` takes a `Tone` parameter, `AlertTone.Error` or `AlertTone.Warning`, and `ChildContent`.

- Its colours are the fixed red (Error) and amber (Warning) hues, in both Themes, as the coding standards allow for colours with a fixed meaning.
- It renders with `role="alert"`.
- RateLimited uses Warning, and the other failures use Error.

## Logging and the audit trail

Decided in [Which failures can each use case return, and what does the Admin see?](https://github.com/mpaulosky/auth0-management-app/issues/18).

- **`AdminId`:** each change command carries one. The component fills it from the `sub` claim (`ClaimTypes.NameIdentifier`) in the cascading `Task<AuthenticationState>`.
  Handlers don't depend on `AuthenticationStateProvider`.
- **After each successful change,** the handler logs one structured line at Information through `ILogger<T>`:
  - `"Admin {AdminId} changed {Fields} for User {UserId}"`, with field names only, never values
  - `"Admin {AdminId} assigned Role {RoleName} for User {UserId}"`
  - `"Admin {AdminId} removed Role {RoleName} for User {UserId}"`
  - `"Admin {AdminId} created Role {RoleName}"`
- **Other levels:** RateLimited logs at Warning. Expected refusals, such as `User.LastAdmin`, log at Information. A failed last-Admin restore logs at Critical.
- **Never logged:** tokens, secrets and field values.
- **The audit trail:** these logs, exported through OpenTelemetry by ServiceDefaults, are the audit trail. There's no audit page in the app.

## Testing

Decided in [How is User and Role management tested without a live Tenant?](https://github.com/mpaulosky/auth0-management-app/issues/19).

### Offline

These tests run everywhere, the Sandcastle sandbox included.

- **Test double:** NSubstitute for `IManagementApi` in every handler, bUnit and integration test. There's no hand-written in-memory fake.
- **The adapter, the rate limiter and the cache, in `UI.Tests.Unit/ManagementApi/`:**
  - Each test builds a `ServiceCollection`, calls `AddManagementApi()` with placeholder options, replaces the `"Auth0Management"` client's primary handler with a stub
    `HttpMessageHandler`, resolves `IManagementApi` and asserts on the `Result`s.
  - The stub answers `/oauth/token` and `/api/v2/*`, and counts requests.
  - A `FakeTimeProvider` drives cache expiry and `X-RateLimit-Reset`.
  - `src/UI` gets no `InternalsVisibleTo`.
  - What they cover:
    - every status-code mapping in [the catalogue](#the-catalogue)
    - the Lucene query and its escaping, as sent
    - checkpoint paging, the member cap with `Truncated`, and a 429 partway through
    - `CountRoleMembersAsync` stopping at `atMost`
    - each cache lifetime and invalidation rule, a cache hit showing as no second request
    - the limiter timing out a queued call
- **Handlers and validators, in `UI.Tests.Unit/Components/Features/<Slice>/`:**
  - Each handler's success path, and every code it can return.
  - A `[Theory]` for each validator rule.
  - The pure rules: the reachable page count, the changed-fields diff, `EditableFields` for each connection type, and the retry seconds.
  - The last-Admin guard's refusal (with `Received(0)` on `RemoveRoleAsync`) and its restore.
  - The change logs, checked with `FakeLogger` from `Microsoft.Extensions.Diagnostics.Testing`, a new test-only package: the log carries the `AdminId` and the field names, never
    a value.
- **bUnit:**
  - The real handlers and validators run, with a substituted `IManagementApi`, a `FakeNavigationManager` and a `FakeTimeProvider`.
  - It covers every behaviour in [Pages and routes](#pages-and-routes), [Search and paging](#search-and-paging), [Profile Fields](#profile-fields),
    [Roles on a User](#roles-on-a-user), [Creating a Role](#creating-a-role) and [Where each failure shows](#where-each-failure-shows).
  - It also covers `Alert`, and `ManagementApiErrorBoundary`'s Try again.
- **`WebApplicationFactory` integration tests:**
  - `UiWebApplicationFactory` gains placeholder `Auth0:Management:*` settings, and the tests substitute `IManagementApi`.
  - On `/admin/users` and `/admin/roles`, a Visitor is redirected to sign in, a User without `Admin` gets 403, and an Admin gets 200.
  - `/admin` returns 200 for everyone, with counts only for an Admin.
  - With any one `Auth0:Management:*` setting missing, the host fails to start.
  - `IManagementApi` resolves to `CachedManagementApi`, registered once when both slice registrations run.
- **Architecture tests:**
  - `UI.ManagementApi` depends on no slice.
  - Only `UI.ManagementApi` references the `Auth0.ManagementApi` namespace.
  - No public type in `UI.ManagementApi` exposes an SDK type.
- **E2E without Auth0, through the AppHost:**
  - A Visitor sees `/admin` with disabled Manage buttons, and the Admin nav link.
  - A Visitor opening `/admin/users` is sent toward sign-in.
  - The AppHost and E2E setups supply placeholder `Auth0:Management:*` values, as they do for `Auth0:*`.

### Against the testing Tenant

The Tenant in the UI's user secrets is a private testing Tenant on the Free tier.

- **When they skip:** every test here is skipped while the `Auth0:Management:*` or `Auth0:Testing:*` settings are absent or are the placeholders, so Sandcastle, Dependabot and
  a fresh clone skip them.
- **Where the settings come from:** locally the UI's user secrets, and in CI the `TEST_ENV` secret.
- **The contract tests,** in `UI.Tests.Integration/ManagementApi/`:
  - They run the real `IManagementApi` from `AddManagementApi()`, one at a time in a single collection.
  - Each one puts back what it changed.
  - A `ManagementApi.RateLimited` result skips the test instead of failing it.
  - What they cover:
    - search and paging return our records
    - `GetUserAsync` on the target User
    - a nickname change, reverted in the cleanup
    - assigning and removing the test Role on the target User
    - `ListRoleMembersAsync` and `CountRoleMembersAsync`
    - a 404 for an unknown User id, mapped to `User.NotFound`
    - `CreateRoleAsync` with a fixed name: the first run creates it, and every later run proves `Role.AlreadyExists` against Auth0's real 409
  - Together they also prove the permissions in the README's table.
- **The signed-in E2E tests,** only two, because driving the hosted login page is brittle:
  - An Admin test User signs in through Auth0's hosted login, opens `/admin/users`, searches for the target User, and assigns and removes the test Role.
  - A non-Admin test User gets Access denied on `/admin/users`.

| Setting | What it is |
| --- | --- |
| `Auth0:Testing:AdminEmail`, `Auth0:Testing:AdminPassword` | The Admin test User |
| `Auth0:Testing:UserEmail`, `Auth0:Testing:UserPassword` | The non-Admin test User |
| `Auth0:Testing:TargetUserId` | The User the contract tests edit |
| `Auth0:Testing:TestRoleId` | The Role the tests assign and remove |
| `Auth0:Testing:CreatedRoleName` | The fixed name `CreateRoleAsync` uses |

### Testing Tenant setup

This is a one-time checklist for the owner, outside Sandcastle:

1. Create a database-connection User to act as the Admin test User, give them a password, and assign them `Admin`.
2. Create a database-connection User to act as the non-Admin test User, with a password and no `Admin`.
3. Create a database-connection target User for the contract tests to edit, and note their user id.
4. Create a Role named `TestRole`, and note its id.
5. Put the `Auth0:Testing:*` values in the UI's user secrets, and as `Auth0__Testing__*` lines in the `TEST_ENV` repository secret, with the `Auth0__Management__*` values.

## Implementation issues

Decided in [How is the feature split into Sandcastle issues, and in what order?](https://github.com/mpaulosky/auth0-management-app/issues/20).

- **Format:** each issue uses the [Sandcastle task template](../../.github/ISSUE_TEMPLATE/sandcastle_task.md).
- **What each holds:** a link to its section here and a `## Scope` section. Its acceptance criteria are that section's behaviours, each ending in "(tested)", plus
  "`scripts/gate.sh` passes".
- **Blocking:** native "blocked by" links follow this table.
- **Labels:** the owner adds `Sandcastle`.

| # | Title | Blocked by | Sections |
| --- | --- | --- | --- |
| 1 | `feat(ManagementApi): Add the Management API seam` | none | [The Management API seam](#the-management-api-seam) (all but the cache), [The catalogue](#the-catalogue)'s mapping, [Rate limits](#rate-limits), [Unreachable or misconfigured](#unreachable-or-misconfigured), `ResultErrorCode.RateLimited`, the architecture tests |
| 2 | `feat(UI): Add the Alert and the Management API error boundary` | none | [`Alert`](#alert), [Where each failure shows](#where-each-failure-shows)' error boundary |
| 3 | `feat(ManagementApi): Cache Management API reads` | 1 | [The cache](#the-cache) |
| 4 | `feat(Users): List and search the Tenant's Users` | 1, 2 | [The Users page](#the-users-page-adminusersqpageuserid)'s list, [Search and paging](#search-and-paging), the Admin policy, the Visitor-redirect E2E test |
| 5 | `feat(Users): Show a User's details` | 4 | [The Users page](#the-users-page-adminusersqpageuserid)'s detail pane, read-only, and `User.NotFound` |
| 6 | `feat(Users): Edit a User's Profile Fields` | 5 | [Profile Fields](#profile-fields), its log line |
| 7 | `feat(Users): Assign and remove a User's Roles` | 5 | [Roles on a User](#roles-on-a-user), its log lines |
| 8 | `feat(Roles): List the Roles and the Users who hold them` | 1, 2 | [The Roles page](#the-roles-page-adminrolesroleid), [Moving between pages](#moving-between-pages)' tabs |
| 9 | `feat(Roles): Create a Role` | 8 | [Creating a Role](#creating-a-role), its log line |
| 10 | `feat(Admin): Turn /admin into the management landing page` | 4, 8 | [The landing page](#the-landing-page-admin), the Admin nav link, the `CONTEXT.md` change, the Visitor landing E2E test |
| 11 | `test(ManagementApi): Test against the testing Tenant` | 6, 7, 9 | [Against the testing Tenant](#against-the-testing-tenant), and the `Auth0:Testing:*` settings in the README |
| 12 | `chore: Set up the testing Tenant's fixtures and TEST_ENV` (manual, never labelled `Sandcastle`) | none | [Testing Tenant setup](#testing-tenant-setup) |

Issues 6 and 7 both edit the detail pane. Sandcastle's file check runs them one after the other. Issue 11's criteria can be checked offline: the tests compile, and skip
under placeholder settings and on RateLimited. Seeing them pass against the Tenant is the owner's check once issue 12 is done.

## Out of scope

- Deleting or editing Roles, blocking or unblocking Users, and editing `user_metadata` or `app_metadata`.
- Creating or deleting Users, and changing a User's password, username or identifier.
- A Redis or distributed cache, and detecting concurrent edits.
- Reading each connection's sync setting (`read:connections`) to unlock a social or enterprise User's Profile Fields.
- An audit trail Admins can see in the app: it would need storage the app doesn't have.
- Creating the Machine to Machine application in the Tenant, which the README's Auth0 setup covers.
