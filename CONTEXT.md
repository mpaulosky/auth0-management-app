# Auth0 Management App

A server-rendered Blazor Web App that lets an Admin manage the Users and Roles of one Auth0 Tenant: edit a User's Profile Fields, add and remove their Roles, and create new Roles.

## Language

**Tenant**:
The one Auth0 tenant the app signs people in to and manages. Every User and Role the app shows lives in it.
_Avoid_: Directory, organization, account

**Management API**:
Auth0's Management API v2, which the app calls to read and change the Tenant's Users and Roles.
The app calls it from the server with its own Machine to Machine application and a client-credentials token, separate from the application that signs people in.
The token never reaches the browser.
_Avoid_: Auth0 API, admin API

**Visitor**:
An unauthenticated caller of the app. Can see public pages (e.g. Home) but not the Profile page or any Admin page.
_Avoid_: Guest, anonymous user

**User**:
A person in the Tenant's user store. A Visitor becomes a User by signing in through Auth0, and can then see the Profile page, showing their own claims.
An Admin manages the other Users of the Tenant, whether or not they ever sign in to this app.
_Avoid_: Account, member

**Admin**:
A User whose Auth0 claims include the `Admin` Role. The only audience for the pages that manage Users and Roles.
_Avoid_: Administrator, superuser

**Role**:
An Auth0 role in the Tenant, assigned to Users to grant them permissions. `Admin` is one of them.
An Admin can assign a Role to a User, remove it from them, and create a new Role. The app doesn't delete Roles.
A change to a signed-in User's Roles takes effect at their next sign-in, when Auth0 issues a new ID token.
_Avoid_: Group, permission (a Role grants permissions; it isn't one)

**Profile Fields**:
The parts of a User's Auth0 profile an Admin can change: name, given name, family name, nickname, picture URL and email.
The app never changes a User's password, username or identifier, and doesn't create or delete Users.
Auth0 keeps a change only where it owns the profile: a database-connection User, or a social or enterprise User whose profile isn't synced at each sign-in.
Distinct from the Profile page, which shows the signed-in User's own claims and changes nothing.
_Avoid_: Account details, user info

**Palette**:
The color scale that tints the app's UI: its accent (buttons, links, highlights) and its surfaces and borders, in both Themes. Text stays neutral.
Chosen by the visitor at runtime from a dropdown in the app's menu.
Offers a curated set of Tailwind CSS hue scales (e.g. Rose, Blue, Violet — the full set minus the gray-family scales, which are visually redundant for this purpose).
Persisted in a cookie, the same mechanism as Theme.
Defaults to a single fixed hue until the visitor picks one; there is no OS-level signal to default from.
Orthogonal to Theme — Palette decides the hue, while Theme decides light or dark.
_Avoid_: Theme, color scheme, skin

**Theme**:
The light/dark rendering mode: Light, Dark, or System (follow the OS `prefers-color-scheme`).
Chosen by the visitor at runtime from a control in the app, persisted in a cookie (read during server-side prerender to avoid a flash of the wrong theme on first paint), and System until the
visitor picks one. Choosing System again returns to following the OS.
_Avoid_: Palette, mode, color scheme

**Shared Kernel**:
The set of building blocks every feature needs no matter what it does or where it stores data: operation
outcomes (success or failure, with a failure category) and the names the app itself relies on (authorization
policy, role, cookie names). It carries no business concepts and assumes no persistence technology.
_Avoid_: Common, Core, Utilities

**Release**:
A published, versioned snapshot of the app (`vX.Y.Z`), cut each time a change merges to `main`.
The footer shows the Release the running build is, or the nearest Release before it.
_Avoid_: Version, build, deploy
