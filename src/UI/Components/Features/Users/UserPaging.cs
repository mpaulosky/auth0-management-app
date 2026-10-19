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
	///   Counts the pages the Admin can reach for a search that matched <paramref name="total" /> Users.
	/// </summary>
	/// <param name="total">Auth0's real total, which can exceed 1000.</param>
	/// <returns>At least 1 and at most 40.</returns>
	public static int ReachablePageCount(int total)
	{
		throw new NotImplementedException();
	}
}
