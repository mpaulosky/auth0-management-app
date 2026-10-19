// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     UserPaging.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI
// =============================================

namespace UI.Components.Features.Users;

/// <summary>
///   The paging rules of the User list: 25 Users a page, and only the first 1000 Users reachable.
/// </summary>
public static class UserPaging
{
	/// <summary>
	///   The number of Users on a page.
	/// </summary>
	public const int PageSize = 25;

	/// <summary>
	///   The last page Auth0 will return: it searches only the first 1000 Users.
	/// </summary>
	public const int MaxPage = 1000 / PageSize;

	/// <summary>
	///   The most Users Auth0 will search, past which the list shows a note to narrow the search.
	/// </summary>
	public const int SearchCap = 1000;

	/// <summary>
	///   Counts the pages the Admin can reach for a search that matched <paramref name="total" /> Users.
	/// </summary>
	/// <param name="total">Auth0's real total, which can exceed 1000.</param>
	/// <returns>At least 1 and at most 40.</returns>
	public static int ReachablePageCount(int total)
	{
		// Divides before rounding up, so a total near int.MaxValue can't overflow.
		int pages = (total / PageSize) + (total % PageSize > 0 ? 1 : 0);

		return Math.Max(1, Math.Min(pages, MaxPage));
	}
}
