// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     SearchUsersHandler.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI
// =============================================

using Domain.Abstractions;

using FluentValidation;

using UI.ManagementApi;

namespace UI.Components.Features.Users;

/// <summary>
///   Validates a <see cref="SearchUsersQuery" />, searches the Tenant's Users and finds which of them hold <c>Admin</c>.
/// </summary>
public sealed class SearchUsersHandler
{
	/// <summary>
	///   Initializes a new instance of <see cref="SearchUsersHandler" />.
	/// </summary>
	/// <param name="managementApi">The Management API seam.</param>
	/// <param name="validator">The validator for <see cref="SearchUsersQuery" />.</param>
	public SearchUsersHandler(IManagementApi managementApi, IValidator<SearchUsersQuery> validator)
	{
		ArgumentNullException.ThrowIfNull(managementApi);
		ArgumentNullException.ThrowIfNull(validator);
	}

	/// <summary>
	///   Searches the Users for <paramref name="query" />.
	/// </summary>
	/// <param name="query">The search text and page.</param>
	/// <param name="cancellationToken">A token that cancels the search.</param>
	/// <returns>The page of Users, or a failed result carrying the error code in <see cref="Result.Details" />.</returns>
	public Task<Result<UserListPage>> HandleAsync(SearchUsersQuery query, CancellationToken cancellationToken)
	{
		throw new NotImplementedException();
	}
}
