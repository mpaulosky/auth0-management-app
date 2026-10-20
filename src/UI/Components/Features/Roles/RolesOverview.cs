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
/// <param name="Members">The members fetched for each Role, in the order of <paramref name="Tiles" />.</param>
/// <param name="FirstPage">
///   The first page of Users from the search, or <see langword="null" /> when the load was for a picked Role and
///   didn't search.
/// </param>
public sealed record RolesOverview(
	IReadOnlyList<RoleTile> Tiles,
	string? SelectedRoleId,
	IReadOnlyList<RoleUserRow> Rows,
	bool SelectedRoleTruncated,
	IReadOnlyList<RoleMembers> Members,
	IReadOnlyList<UserSummary>? FirstPage)
{
	/// <summary>
	///   Builds the overview for <paramref name="selectedRoleId" /> from the Roles' members already fetched.
	/// </summary>
	/// <param name="tiles">The tiles, one for each Role.</param>
	/// <param name="members">The members of each Role, in the order of <paramref name="tiles" />.</param>
	/// <param name="firstPage">The first page of Users from the search, used when no Role is picked.</param>
	/// <param name="selectedRoleId">
	///   A Role in <paramref name="tiles" />, or <see langword="null" /> for <paramref name="firstPage" />.
	/// </param>
	/// <returns>The overview, or <see langword="null" /> when the data needed for the pick wasn't fetched.</returns>
	public static RolesOverview? Build(
		IReadOnlyList<RoleTile> tiles,
		IReadOnlyList<RoleMembers> members,
		IReadOnlyList<UserSummary>? firstPage,
		string? selectedRoleId)
	{
		ArgumentNullException.ThrowIfNull(tiles);
		ArgumentNullException.ThrowIfNull(members);

		IReadOnlyList<UserSummary> users;
		bool selectedRoleTruncated = false;
		if (selectedRoleId is null)
		{
			if (firstPage is null)
			{
				return null;
			}

			users = firstPage;
		}
		else
		{
			int selected = -1;
			for (int index = 0; index < tiles.Count; index++)
			{
				if (tiles[index].Role.Id == selectedRoleId)
				{
					selected = index;
					break;
				}
			}

			if (selected < 0)
			{
				return null;
			}

			users = members[selected].Users;
			selectedRoleTruncated = members[selected].Truncated;
		}

		List<HashSet<string>> memberIds = [.. members.Select(roleMembers =>
			roleMembers.Users.Select(user => user.Id).ToHashSet(StringComparer.Ordinal))];

		List<RoleUserRow> rows = [.. users.Select(user => new RoleUserRow(user,
			[.. members.Select((roleMembers, index) => Holding(user, memberIds[index], roleMembers.Truncated))]))];

		return new RolesOverview(tiles, selectedRoleId, rows, selectedRoleTruncated, members, firstPage);
	}

	/// <summary>
	///   Filters the table to <paramref name="roleId" /> from the members already held, without calling the Management API.
	/// </summary>
	/// <param name="roleId">The Role to pick, or <see langword="null" /> to clear the pick.</param>
	/// <returns>
	///   The overview for the pick, or <see langword="null" /> when it needs data this load didn't fetch: clearing a pick
	///   after a load for a Role, which didn't search.
	/// </returns>
	public RolesOverview? Select(string? roleId) => Build(Tiles, Members, FirstPage, roleId);

	// A User missing from a Truncated Role's members may still hold it, past the 1000 fetched.
	private static RoleHolding Holding(UserSummary user, HashSet<string> memberIds, bool truncated)
	{
		if (memberIds.Contains(user.Id))
		{
			return RoleHolding.Yes;
		}

		return truncated ? RoleHolding.Unknown : RoleHolding.No;
	}
}
