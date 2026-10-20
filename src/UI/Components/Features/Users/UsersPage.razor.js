// Writes the Users page's q, page and user into the address bar without a navigation. The Router is static, so a
// NavigationManager.NavigateTo would be an enhanced navigation that renders the page again on the server, and a new
// history entry per keystroke would make Back step through each one. The current entry's state is kept, since Blazor
// stores its own in it.
export function replaceUrl(url) {
	history.replaceState(history.state, "", url);
}
