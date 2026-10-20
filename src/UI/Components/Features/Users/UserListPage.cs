// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     UserListPage.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI
// =============================================

using System.Collections.Immutable;

using UI.ManagementApi;

namespace UI.Components.Features.Users;

/// <summary>
///   One page of the User list, ready to show.
/// </summary>
/// <param name="Users">The Users on the page.</param>
/// <param name="Total">Auth0's real total, which can exceed 1000.</param>
/// <param name="Page">The page shown, after clamping to the reachable pages.</param>
/// <param name="PageCount">The reachable page count.</param>
/// <param name="ShowsCapNote">Whether the total is over the 1000 Users Auth0 will search.</param>
/// <param name="AdminIds">The ids of the Users who hold <c>Admin</c>. A concrete set, so the page survives the prerender's JSON round trip.</param>
/// <param name="AdminBadgesIncomplete">Whether <c>Admin</c> has more members than were fetched, so a User past them shows no badge.</param>
public sealed record UserListPage(
	IReadOnlyList<UserSummary> Users,
	int Total,
	int Page,
	int PageCount,
	bool ShowsCapNote,
	ImmutableHashSet<string> AdminIds,
	bool AdminBadgesIncomplete = false);
