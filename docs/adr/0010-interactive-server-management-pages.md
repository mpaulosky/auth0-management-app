# Only the management pages render interactively

The Users page (`/admin/users`) and the Roles page (`/admin/roles`) are `@rendermode InteractiveServer`. Every other page stays static server-side rendering, the
`/admin` landing page included. Each page declares its render mode itself; the app doesn't set one globally on `Routes` or `App`.
`Program.cs` already registers `AddInteractiveServerComponents()` and `AddInteractiveServerRenderMode()`, so nothing changes at startup.

The decision was made while charting [Map: Manage Users and Roles](https://github.com/mpaulosky/auth0-management-app/issues/11), and the pages it applies to are in
[User and Role Management](../plans/user-role-management.md#pages-and-routes).

## Why

The management pages need behaviour a static page can only fake with full-page posts:

- search as the Admin types, with a debounce that cancels the search in flight
- a master-detail selection kept in the URL without a reload
- the Profile Fields form validating on submit and showing each error under its field
- Role chips that add and remove a Role in place
- the Create Role dialog

The rest of the app has no such need. The Theme and Palette controls, sign-in and the Profile page work as static pages with form posts, and
`App.razor` reads the Theme and Palette cookies from `HttpContext`, which only static rendering provides.

## Considered Options

- **Static SSR with enhanced forms for everything:** this keeps one render mode. But the debounced search, the in-place chips and the dialog would each be a full-page
  post-and-redirect, and the search would only run on submit.
- **InteractiveServer for the whole app (`<Routes @rendermode="InteractiveServer" />`):** this is the simplest to declare. But every page, Home included, would hold a circuit open,
  and `App.razor`'s `HttpContext` reads, and the existing static controls, would need reworking.
- **InteractiveWebAssembly or Auto:** these would move the handlers' callers into the browser, so the Management API calls would need an HTTP endpoint for each use case. That's
  a second surface to protect with the Admin policy, for no gain.

## Consequences

- An Admin on a management page holds a SignalR circuit, so the existing `ReconnectModal` shows if it drops.
- The management pages read the signed-in User through the cascading `Task<AuthenticationState>`, never `HttpContext`, as the coding standards require.
- `[Authorize]` with the Admin policy on the page is enforced on the HTTP request that prerenders it, so a non-Admin never opens a circuit on a management page.
- A Role change doesn't change an open circuit's claims. It takes effect at the User's next sign-in, as `CONTEXT.md` says.
- bUnit tests the interactive behaviour, because `WebApplicationFactory` tests only see the prerendered HTML.
