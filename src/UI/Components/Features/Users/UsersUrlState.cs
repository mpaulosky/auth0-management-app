// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     UsersUrlState.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI
// =============================================

using System.Diagnostics.CodeAnalysis;
using System.Globalization;

using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Primitives;

namespace UI.Components.Features.Users;

/// <summary>
///   What the Users page keeps in its URL: the applied search text, the page and the picked User.
/// </summary>
/// <param name="Query">The search text, or <see langword="null" /> when the box is empty.</param>
/// <param name="Page">The 1-based page number.</param>
/// <param name="UserId">The picked User's id, or <see langword="null" /> when none is picked.</param>
public sealed record UsersUrlState(string? Query, int Page, string? UserId)
{
	private const string Path = "/admin/users";

	/// <summary>
	///   Reads <c>q</c>, <c>page</c> and <c>user</c> from <paramref name="uri" />. A <c>page</c> below 1 or not a number is page 1.
	/// </summary>
	/// <param name="uri">The page's absolute URI.</param>
	/// <returns>The state the URL holds.</returns>
	public static UsersUrlState FromUri(Uri uri)
	{
		ArgumentNullException.ThrowIfNull(uri);

		Dictionary<string, StringValues> query = QueryHelpers.ParseQuery(uri.Query);
		string? text = query.GetValueOrDefault("q").ToString();
		string? user = query.GetValueOrDefault("user").ToString();
		int page = int.TryParse(query.GetValueOrDefault("page").ToString(), NumberStyles.Integer, CultureInfo.InvariantCulture,
			out int parsed)
			? Math.Max(1, parsed)
			: 1;

		return new UsersUrlState(string.IsNullOrWhiteSpace(text) ? null : text.Trim(), page,
			string.IsNullOrEmpty(user) ? null : user);
	}

	/// <summary>
	///   Builds the relative URL that holds this state, leaving out what is at its default.
	/// </summary>
	/// <returns>The path and query string.</returns>
	[SuppressMessage("Design", "CA1055:URI-like return values should not be strings", Justification = "The value goes to history.replaceState as the string it is.")]
	public string ToUrl()
	{
		Dictionary<string, string?> query = [];
		if (!string.IsNullOrWhiteSpace(Query))
		{
			query["q"] = Query.Trim();
		}

		if (Page > 1)
		{
			query["page"] = Page.ToString(CultureInfo.InvariantCulture);
		}

		if (!string.IsNullOrEmpty(UserId))
		{
			query["user"] = UserId;
		}

		return QueryHelpers.AddQueryString(Path, query);
	}
}
