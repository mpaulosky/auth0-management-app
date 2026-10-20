// Writes the Roles page's role into the address bar without a navigation. The Router is static, so a
// NavigationManager.NavigateTo would be an enhanced navigation that renders the page again on the server. The current
// entry's state is kept, since Blazor stores its own in it (the history index).
export function replaceUrl(url) {
	history.replaceState(history.state, "", url);
}
