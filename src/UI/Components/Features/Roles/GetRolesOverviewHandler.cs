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
	public Task<Result<RolesOverview>> HandleAsync(GetRolesOverviewQuery query, CancellationToken cancellationToken)
	{
		_ = _managementApi;

		throw new NotImplementedException();
	}
}
