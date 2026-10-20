// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     RolesOverview.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI
// =============================================

using UI.ManagementApi;

namespace UI.Components.Features.Roles;

/// <summary>
///   Whether a User holds a Role, as far as the Roles page can tell.
/// </summary>
public enum RoleHolding
{
	/// <summary>
	///   The User doesn't hold the Role.
	/// </summary>
	No,

	/// <summary>
	///   The User holds the Role.
	/// </summary>
	Yes,

	/// <summary>
	///   The Role is <c>Truncated</c> and the User is outside the members fetched, so the page can't say.
	/// </summary>
	Unknown,
}

/// <summary>
///   A Role tile: the Role and how many Users hold it.
/// </summary>
/// <param name="Role">The Role.</param>
/// <param name="Members">The number of members fetched, which is 1000 for a <paramref name="Truncated" /> Role.</param>
/// <param name="Truncated">Whether more Users hold the Role than the 1000 fetched.</param>
public sealed record RoleTile(RoleSummary Role, int Members, bool Truncated);

/// <summary>
///   A row of the User table.
/// </summary>
/// <param name="User">The User.</param>
/// <param name="Holdings">Whether the User holds each Role, in the order of <see cref="RolesOverview.Tiles" />.</param>
public sealed record RoleUserRow(UserSummary User, IReadOnlyList<RoleHolding> Holdings);

/// <summary>
///   The Roles page's content.
/// </summary>
/// <param name="Tiles">One tile for each Role in the Tenant, in the order <c>ListRolesAsync</c> returned them.</param>
/// <param name="SelectedRoleId">The Role the table is filtered to, or <see langword="null" /> when none is picked.</param>
/// <param name="Rows">The Users in the table.</param>
/// <param name="SelectedRoleTruncated">Whether the picked Role is <c>Truncated</c>, so the table shows the note.</param>
public sealed record RolesOverview(
	IReadOnlyList<RoleTile> Tiles,
	string? SelectedRoleId,
	IReadOnlyList<RoleUserRow> Rows,
	bool SelectedRoleTruncated);
