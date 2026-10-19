// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     UserSearchQueryBuilder.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI
// =============================================

namespace UI.Components.Features.Users;

/// <summary>
///   Turns the search box's text into the Lucene query Auth0's User search takes.
/// </summary>
public static class UserSearchQueryBuilder
{
	/// <summary>
	///   Builds the query for the text in the search box.
	/// </summary>
	/// <param name="input">The raw search box text.</param>
	/// <returns>The Lucene query, or <see langword="null" /> when the box is empty and every User should list.</returns>
	public static string? Build(string? input)
	{
		throw new NotImplementedException();
	}
}
