// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     GetRolesOverviewHandler.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI
// =============================================

using Domain.Abstractions;

using UI.ManagementApi;

namespace UI.Components.Features.Roles;

/// <summary>
///   Reads the Roles, their members and the Users the Roles page shows.
/// </summary>
public sealed class GetRolesOverviewHandler
{
	// The Users page's page size, so the unfiltered table shows the same first page as the Users list.
	private const int PageSize = 25;

	private readonly IManagementApi _managementApi;

	/// <summary>
	///   Initializes a new instance of <see cref="GetRolesOverviewHandler" />.
	/// </summary>
	/// <param name="managementApi">The Management API seam.</param>
	public GetRolesOverviewHandler(IManagementApi managementApi)
	{
		ArgumentNullException.ThrowIfNull(managementApi);

		_managementApi = managementApi;
	}

	/// <summary>
	///   Lists the Roles with the Users who hold each, and the table of Users for <paramref name="query" />.
	/// </summary>
	/// <param name="query">The picked Role, if any.</param>
	/// <param name="cancellationToken">A token that cancels the calls.</param>
	/// <returns>
	///   The page's content, or the Management API's failure unchanged, such as <c>Role.NotFound</c> or
	///   <c>ManagementApi.RateLimited</c>.
	/// </returns>
	public async Task<Result<RolesOverview>> HandleAsync(GetRolesOverviewQuery query, CancellationToken cancellationToken)
	{
		ArgumentNullException.ThrowIfNull(query);

		// The seam's successful Results always carry a value, so each Value! below follows a Failure check.
		Result<IReadOnlyList<RoleSummary>> roles =
			await _managementApi.ListRolesAsync(cancellationToken).ConfigureAwait(false);
		if (roles.Failure)
		{
			return FailedAs(roles);
		}

		// Every Role's members, because each tile counts them and each row marks every Role. A load costs one call per
		// page of each Role's members (up to 10 for a Truncated Role), so the page loads once and filters locally. The
		// calls run one at a time: the token bucket would queue them anyway, and the cache answers them on a later load.
		List<RoleTile> tiles = [];
		List<RoleMembers> members = [];
		foreach (RoleSummary role in roles.Value!)
		{
			Result<RoleMembers> roleMembers =
				await _managementApi.ListRoleMembersAsync(role.Id, cancellationToken).ConfigureAwait(false);
			if (roleMembers.Failure)
			{
				return FailedAs(roleMembers);
			}

			RoleMembers fetched = roleMembers.Value!;
			members.Add(fetched);
			tiles.Add(new RoleTile(role, fetched.Users.Count, fetched.Truncated));
		}

		IReadOnlyList<UserSummary>? firstPage = null;
		if (query.RoleId is null)
		{
			Result<UserPage> page = await _managementApi.SearchUsersAsync(new UserSearch(null, 1, PageSize),
				cancellationToken).ConfigureAwait(false);
			if (page.Failure)
			{
				return FailedAs(page);
			}

			firstPage = page.Value!.Users;
		}
		else if (!tiles.Exists(tile => tile.Role.Id == query.RoleId))
		{
			return ManagementApiError.RoleNotFound.ToResult<RolesOverview>();
		}

		// The overview keeps the members, so the page filters to a picked Role without another load.
		return Result.Ok(RolesOverview.Build(tiles, members, firstPage, query.RoleId)!);
	}

	private static Result<RolesOverview> FailedAs(Result failed)
	{
		return Result.Fail<RolesOverview>(failed.Error ?? string.Empty, failed.ErrorCode, failed.Details);
	}
}
