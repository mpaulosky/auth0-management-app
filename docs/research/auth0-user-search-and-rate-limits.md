# Auth0 User search, paging and rate limits

Research for issue #13 (map #11, Manage Users and Roles): what the Management API's User search, paging and rate limits mean for a
searchable, paged User list. Sources are Auth0's own docs and the Management API v2 reference, read on 2026-10-19.

## Answer in brief

- Search `GET /api/v2/users` with `q` (Lucene syntax) and `search_engine=v3`, the only engine left. Prefix search (`email:jo*`) works on any
  top-level field; the normalized fields (`email`, `name`, `given_name`, `family_name`, `nickname`) match case-insensitively.
- The endpoint references say `per_page` goes up to 100 on this endpoint (and on `GET /api/v2/roles/{id}/users`), but the API overview says 50
  on Public Cloud ([Paging and totals](#paging-and-totals)): use 50 or less. `include_totals=true` wraps the page in
  `{ start, limit, length, total, users }`.
- The Admin's search text can't go into `q` as typed: Lucene reserves characters such as `:`, `(` and `*`, a leading `-` excludes, and a
  space splits terms. Escape it and build the query from it ([Building `q` from the search box](#building-q-from-the-search-box)).
- Search can reach only the first 1000 matches. Past that, Auth0 says narrow the query, and use a bulk export job (not search) to
  enumerate Users. `GET /api/v2/roles/{id}/users` has checkpoint paging (`from`/`take`) to go past 1000.
- Search is eventually consistent: a just-updated User may show stale data in results. Lookups by ID or email are immediately consistent.
- Rate limits are per Tenant and tier. Free: 2 requests/second for the whole Management API, burst 2. Essentials/Professional: `Read Users`
  500/minute (burst 40), `Write Users` 200/minute (burst 20), everything else 150/minute combined (burst 10). Enterprise: 16/second
  (burst 50) in production, 2/second (burst 10) in non-production.
  A 429 carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (a UNIX time in seconds).

## Search query syntax

- `q` takes a Lucene query string; `search_engine` takes `v1`, `v2` or `v3`
  ([Get users reference](https://auth0.com/docs/api/management/v2/users/get-users)). Search v2 "has reached its end of life as of
  June 30, 2019", and only v3 is available ([Migrate from Search v2 to v3](https://auth0.com/docs/troubleshoot/product-lifecycle/past-migrations/migrate-v2-v3)).
  Pass `search_engine=v3` explicitly, as every Auth0 example does.
- Any attribute of the user profile is searchable, including `email`, `name`, `given_name`, `family_name`, `nickname`, `identities.connection`,
  `logins_count`, `last_login`, `email_verified`, and `app_metadata`/`user_metadata` values
  ([User search query syntax](https://auth0.com/docs/manage-users/user-search/user-search-query-syntax)).
- Field-qualified terms match exact values: `name:"jane"`. Fields are not tokenized as in v2, so `user_id:auth0` won't match `auth0|12345`;
  write `user_id:auth0*` ([Migrate v2 to v3](https://auth0.com/docs/troubleshoot/product-lifecycle/past-migrations/migrate-v2-v3)).
- Wildcards: `*` matches several characters (`email:test*`, `name:*example*`). Prefix matching (`name:j*`) has no minimum length; for
  suffix matching "literals must have 3 characters or more" ([query syntax](https://auth0.com/docs/manage-users/user-search/user-search-query-syntax)).
- Range and wildcard searches don't work on `app_metadata`/`user_metadata`
  ([Migrate v2 to v3](https://auth0.com/docs/troubleshoot/product-lifecycle/past-migrations/migrate-v2-v3)). Out of scope for the map anyway.
- Ranges use `[lower TO upper]` with `*` for an open bound (`logins_count:[* TO 10}`); `AND`, `OR`, `NOT` and `_exists_` combine terms
  ([query syntax](https://auth0.com/docs/manage-users/user-search/user-search-query-syntax)).
- "All search values are case sensitive except for search values for normalized user profile fields", so a search box over `email`, `name`,
  `given_name`, `family_name` and `nickname` is case-insensitive ([query syntax](https://auth0.com/docs/manage-users/user-search/user-search-query-syntax)).
- To filter by connection on v3, use `q=identities.connection:"name"`; the `connection` parameter only applies to v1
  ([Get users reference](https://auth0.com/docs/api/management/v2/users/get-users)).
- `sort=field:1` (ascending) or `field:-1` (descending), for example `created_at:1`
  ([Retrieve users with the Get Users endpoint](https://auth0.com/docs/manage-users/user-search/retrieve-users-with-get-users-endpoint)).
  Sorting by `app_metadata` or `user_metadata` isn't supported ([best practices](https://auth0.com/docs/manage-users/user-search/user-search-best-practices)).
- A query string that's too long returns `414 Request-URI Too Large`; a query that doesn't finish in about 2 seconds returns 503
  ([Retrieve users](https://auth0.com/docs/manage-users/user-search/retrieve-users-with-get-users-endpoint),
  [Get users reference](https://auth0.com/docs/api/management/v2/users/get-users)). The best-practices page says to minimize wildcards,
  "especially on large data sets", and to prefer indexed, top-level fields ([best practices](https://auth0.com/docs/manage-users/user-search/user-search-best-practices)).
- A query Auth0 can't parse returns 400, "Invalid request query string. The message will vary depending on the cause"
  ([Get users reference](https://auth0.com/docs/api/management/v2/users/get-users)).

## Building `q` from the search box

Auth0 calls the Lucene query syntax reference "the authoritative reference" ([query syntax](https://auth0.com/docs/manage-users/user-search/user-search-query-syntax)).
That reference lists the special characters `+ - && || ! ( ) { } [ ] ^ " ~ * ? : \` and says to escape each with a `\`
([Lucene query parser syntax](https://lucene.apache.org/core/2_9_4/queryparsersyntax.html)). Unescaped whitespace separates terms.

Pasting the Admin's text into a prefix term breaks on ordinary input:

- `-smith` becomes `name:-smith*`, and a leading `-` (or `+`) is read as an operator. Inside a word they are ordinary characters, so
  `jane.doe+test@` is safe.
- `a:b`, `(`, `"` or a trailing `\` breaks the parse, and Auth0 returns 400.
- `Jane Smith` becomes `name:Jane Smith*`: `name:Jane`, plus a bare `Smith*` on the default field.
- A quoted phrase doesn't help, because a phrase takes no wildcard.
- `x OR _exists_:email` changes what the query means.

The Admin can already read every User, so this is a correctness problem, not a privilege one.

Recommendation (ours, not Auth0's; not verified against a live Tenant):

- Escape every special character in the list above, and `/` too, which later Lucene versions treat as a regular expression delimiter.
- Keep the whole text as one prefix term per field, with its spaces escaped too: `Jane Smith` becomes
  `name:jane\ smith* OR email:jane\ smith*`. Splitting it into words joined with `AND` doesn't work, because v3 fields aren't tokenized
  ([Search query syntax](#search-query-syntax)): `name:smith*` doesn't match the value `jane smith`.
- To find a surname typed alone, also search `family_name:<text>*`. Leading-wildcard terms (`name:*smith*`) would find it too, but they need
  3 or more characters and are the costly kind the best-practices page warns about.
- Check both against a live Tenant before the spec relies on them.
- Map a 400 to a failed `Result`, so the page tells the Admin the search couldn't run instead of failing.

## Paging and totals

### `GET /api/v2/users`

Source: [Get users reference](https://auth0.com/docs/api/management/v2/users/get-users).

- `page`: zero-based page index. `per_page`: minimum 0, maximum 100.
- `include_totals=true` returns an object with `start`, `limit`, `length`, `total` and `users`; otherwise a plain array.
- `fields` plus `include_fields` trim the response to the columns the list shows.
- Paging past the cap returns 400 with "You can only page through the first 1000 records." The best-practices page: "Search returns a maximum
  of 1,000 users, even if more users match your query" ([best practices](https://auth0.com/docs/manage-users/user-search/user-search-best-practices)).
- Required scope: `read:users` (403 otherwise).
- The endpoint has no checkpoint paging (`from`/`take`) in its reference.

The Management API overview says that offset paging's `per_page` maximum is 50 on Public Cloud and 100 on Private Cloud
([Management API reference](https://auth0.com/docs/api/management/v2)). That rule comes from the 2021 migration to paginated queries, whose list of
affected endpoints (`clients`, `client_grants`, `grants`, `connections`, `device-credentials`, `resource-servers`, `rules`) doesn't include
`users` or `roles/{id}/users` ([Migrate to paginated queries](https://auth0.com/docs/troubleshoot/product-lifecycle/past-migrations/migrate-to-paginated-queries)).
The endpoint references both say 100. Not verified against a live Tenant: a page size of 50 or less is safe either way.

### `GET /api/v2/roles/{id}/users`

Source: [Get a role's users reference](https://auth0.com/docs/api/management/v2/roles/get-role-user).

- Offset paging: `page`, `per_page` (1 to 100, default 50), `include_totals` (response `{ start, limit, total, users }`).
- Checkpoint paging: `from` (omit on the first call) and `take` (1 to 100, default 50); the response is `{ next, users }`, and no `next` means
  no more pages. "Checkpoint pagination must be used if you need to retrieve more than 1000 organization members." The wording says
  "organization members", apparently copied from the Organizations endpoint; read it as the 1000 offset cap applying here too.
- Returns only Users with the Role assigned directly. Each User carries only `user_id`, `picture`, `name` and `email`.
- Required scopes: `read:users` and `read:roles`. 404 when the Role doesn't exist.
- The endpoint takes no `q`, so a Role's member list can't be searched server-side.

## Beyond 1000 Users

- Narrow the query: "Avoid search criteria that return data sets with more than 1,000 results"
  ([best practices](https://auth0.com/docs/manage-users/user-search/user-search-best-practices)); the v3 migration guide first suggests you
  "redefine your search query to obtain more granular results" ([Migrate v2 to v3](https://auth0.com/docs/troubleshoot/product-lifecycle/past-migrations/migrate-v2-v3)).
- "Do not use the List or Search Users endpoint to enumerate or export users"; use bulk user exports instead, or subscribe to Event Streams to
  keep an external system in sync ([best practices](https://auth0.com/docs/manage-users/user-search/user-search-best-practices)).
- Bulk export is `POST /api/v2/jobs/users-exports`: an asynchronous job producing NDJSON or CSV, whose download link is valid for 60 seconds and whose
  data is deleted after 24 hours. It is not available on the Free plan ([Bulk user exports](https://auth0.com/docs/manage-users/user-migration/bulk-user-exports)).

For an interactive User list, this means: show the first 1000 matches at most, say so when `total` reaches 1000, and ask the Admin to refine the search.
An export is a different feature and out of the map's scope.

## Freshness after an update

- Search "is eventually consistent, so search results may not reflect very recent writes"
  ([best practices](https://auth0.com/docs/manage-users/user-search/user-search-best-practices)). Auth0 states no delay.
- "The List or Search Users endpoint is not suitable for use in latency-sensitive or correctness-critical paths"
  ([Retrieve users](https://auth0.com/docs/manage-users/user-search/retrieve-users-with-get-users-endpoint)).
- `GET /api/v2/users/{id}` and `GET /api/v2/users-by-email` "are immediately consistent"
  ([Get users by ID or email](https://auth0.com/docs/manage-users/user-search/get-users-by-id-or-email)).

For the app: the User detail page reads by ID, so it shows a save at once. The list may show the old values for a short while after a save. The app's own
cache invalidation can't fix that, because a fresh search can still return stale data.

## Rate limits

How Auth0 limits: a token bucket per Tenant. The bucket size is the burst; the refill rate is the sustained limit. The global Management API limit is
checked before any endpoint limit ([Management API endpoint rate limits][mgmt-limits],
[Rate limit policy][rl-policy]).

Per tier, Management API, Public Cloud ([Rate limit configurations][rl-configs]):

| Tier | Limit | Burst | Sustained | Source |
| --- | --- | --- | --- | --- |
| Free | Management API, all requests | 2 | 2/second | [free-public][rl-free] |
| Essentials, Professional, B2B | Read Users (`GET`) | 40 | 500/minute | [essentials-professional-b2b][rl-ess] |
| Essentials, Professional, B2B | Write Users (`POST`, `PATCH`) | 20 | 200/minute | as above |
| Essentials, Professional, B2B | All other endpoints combined (Roles included) | 10 | 150/minute | as above |
| Enterprise | Management API, production | 50 | 16/second | [enterprise-public][rl-ent] |
| Enterprise | Management API, non-production | 10 | 2/second | as above |

Private Cloud tiers have their own pages, linked from the configurations page. None of the tier tables lists `/api/v2/roles`, `/api/v2/roles/{id}/users` or
`/api/v2/users/{id}/roles` separately; on Essentials and Professional they fall under "All other Endpoints Combined".

What a call that's over the limit gets ([Rate limit use cases][rl-use-cases]):

- HTTP 429 Too Many Requests. Both endpoint references say: "Too many requests. Check the X-RateLimit-Limit, X-RateLimit-Remaining and
  X-RateLimit-Reset headers."
- `x-ratelimit-limit`: the bucket size. `x-ratelimit-remaining`: requests left before the bucket refills. `x-ratelimit-reset`: "UNIX timestamp, in
  seconds, of the expected time when additional requests will be added to the bucket."
- The docs don't mention `Retry-After`; wait until `x-ratelimit-reset`.
- Tenant logs record `api_limit` and `api_limit_warning` events.

For the app, the limits bite on a page's first load, before any cache helps:

- **The User detail page exceeds the Free burst.** It loads the User, their Roles and the Tenant's Roles: three calls. With a burst of 2, firing
  all three at once gets the third a 429.
- **Who holds which Role costs a request per page of each Role's members.** The map ([#11](https://github.com/mpaulosky/auth0-management-app/issues/11))
  and ADR 0009 ([#22](https://github.com/mpaulosky/auth0-management-app/pull/22)) find the Users who hold each Role by calling
  `GET /api/v2/roles/{id}/users` with checkpoint paging (`take` up to 100), not by fetching each User's Roles. That costs one call to list the Roles,
  plus one for every page of up to 100 members of each Role. For a Tenant with 10 Roles of fewer than 100 members each:
  - On Free, 11 calls take about 5 seconds at 2 a second.
  - On Essentials and Professional, those calls all fall under "All other endpoints combined": a burst of 10, then 150 a minute (2.5 a second).
    Auth0 doesn't queue a call over the limit: the eleventh gets a 429 at once, and so does every call the Admin makes while the bucket is
    empty, unless the app throttles itself first.

Recommendation (ours, not Auth0's):

- Throttle on the client with a token bucket that matches Auth0's, such as .NET's `System.Threading.RateLimiting.TokenBucketRateLimiter`,
  sized from settings per tier (2 tokens refilled at 2 a second on Free). Capping how many calls run at once isn't enough: two quick calls
  free their slots long before the bucket refills, so the next two get a 429.
- Cache the Tenant's Roles and their members for a short, absolute time, and clear them on a Role change, so most loads skip the cost. A
  check that must be current, such as ADR 0009's last-Admin guard, reads uncached.
- On a 429, wait until `x-ratelimit-reset`, retry once, then return a failed `Result` the page can show, not an exception.
- Debounce the search input, so typing doesn't fire a search per keystroke.

## Not verified

- Whether Public Cloud really caps `per_page` at 50 for `GET /api/v2/users` (the overview) or at 100 (the endpoint reference). Use 50 or less.
- Whether 429 responses carry `Retry-After`. Auth0's docs name only the `x-ratelimit-*` headers.
- How long search lags behind a write. Auth0 gives no figure.
- Whether the `Auth0.ManagementApi` SDK retries 429s itself: its README shows a `MaxRetries` option in `ManagementClientOptions` but doesn't say which
  failures it retries ([auth0.net README](https://github.com/auth0/auth0.net/blob/master/README.md)). Check when the client is built.

[mgmt-limits]: https://auth0.com/docs/troubleshoot/customer-support/operational-policies/rate-limit-policy/management-api-endpoint-rate-limits
[rl-policy]: https://auth0.com/docs/troubleshoot/customer-support/operational-policies/rate-limit-policy
[rl-configs]: https://auth0.com/docs/troubleshoot/customer-support/operational-policies/rate-limit-policy/rate-limit-configurations
[rl-free]: https://auth0.com/docs/troubleshoot/customer-support/operational-policies/rate-limit-policy/rate-limit-configurations/free-public
[rl-ess]: https://auth0.com/docs/troubleshoot/customer-support/operational-policies/rate-limit-policy/rate-limit-configurations/essentials-professional-b2b
[rl-ent]: https://auth0.com/docs/troubleshoot/customer-support/operational-policies/rate-limit-policy/rate-limit-configurations/enterprise-public
[rl-use-cases]: https://auth0.com/docs/troubleshoot/customer-support/operational-policies/rate-limit-policy/rate-limit-use-cases
