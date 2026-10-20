// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     SearchUsersHandler.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI
// =============================================

using System.Collections.Immutable;

using Domain.Abstractions;
using Domain.Constants;

using FluentValidation;
using FluentValidation.Results;

using UI.ManagementApi;

namespace UI.Components.Features.Users;

/// <summary>
///   Validates a <see cref="SearchUsersQuery" />, searches the Tenant's Users and finds which of them hold <c>Admin</c>.
/// </summary>
public sealed class SearchUsersHandler
{
	private readonly IManagementApi _managementApi;
	private readonly IValidator<SearchUsersQuery> _validator;

	/// <summary>
	///   Initializes a new instance of <see cref="SearchUsersHandler" />.
	/// </summary>
	/// <param name="managementApi">The Management API seam.</param>
	/// <param name="validator">The validator for <see cref="SearchUsersQuery" />.</param>
	public SearchUsersHandler(IManagementApi managementApi, IValidator<SearchUsersQuery> validator)
	{
		ArgumentNullException.ThrowIfNull(managementApi);
		ArgumentNullException.ThrowIfNull(validator);

		_managementApi = managementApi;
		_validator = validator;
	}

	/// <summary>
	///   Searches the Users for <paramref name="query" />.
	/// </summary>
	/// <param name="query">The search text and page.</param>
	/// <param name="cancellationToken">A token that cancels the search.</param>
	/// <returns>The page of Users, or a failed result carrying the error code in <see cref="Result.Details" />.</returns>
	public async Task<Result<UserListPage>> HandleAsync(SearchUsersQuery query, CancellationToken cancellationToken)
	{
		ArgumentNullException.ThrowIfNull(query);

		ValidationResult validation = await _validator.ValidateAsync(query, cancellationToken).ConfigureAwait(false);
		if (!validation.IsValid)
		{
			ValidationFailure error = validation.Errors[0];

			return Result.Fail<UserListPage>(error.ErrorMessage, ResultErrorCode.Validation, error.ErrorCode);
		}

		string? luceneQuery = UserSearchQueryBuilder.Build(query.Query);

		// The last page isn't known until Auth0 returns the total, so a page past the cap is clamped first and is never
		// sent, and a page past the total costs one more request for the last reachable page.
		int page = Math.Min(query.Page, UserPaging.MaxPage);
		Result<UserPage> search = await SearchAsync(luceneQuery, page, cancellationToken).ConfigureAwait(false);
		if (search.Failure)
		{
			return FailedWith<UserListPage>(search);
		}

		// A successful Result carries its value, so each Value! here and in FindAdminIdsAsync follows a Failure check.
		int pageCount = UserPaging.ReachablePageCount(search.Value!.Total);
		if (page > pageCount)
		{
			page = pageCount;
			search = await SearchAsync(luceneQuery, page, cancellationToken).ConfigureAwait(false);
			if (search.Failure)
			{
				return FailedWith<UserListPage>(search);
			}

			pageCount = UserPaging.ReachablePageCount(search.Value!.Total);
		}

		Result<AdminIds> adminIds = await FindAdminIdsAsync(cancellationToken).ConfigureAwait(false);
		if (adminIds.Failure)
		{
			return FailedWith<UserListPage>(adminIds);
		}

		UserPage users = search.Value!;

		// The list is persisted into the prerendered HTML and kept for the circuit, so it carries only the Admins on this
		// page, not the whole cached member set.
		ImmutableHashSet<string> pageAdminIds = users.Users
			.Select(user => user.Id)
			.Where(adminIds.Value!.Ids.Contains)
			.ToImmutableHashSet(StringComparer.Ordinal);

		return Result.Ok(new UserListPage(users.Users, users.Total, page, pageCount, users.Total > UserPaging.SearchCap,
			pageAdminIds, adminIds.Value!.Truncated));
	}

	private Task<Result<UserPage>> SearchAsync(string? luceneQuery, int page, CancellationToken cancellationToken) =>
		_managementApi.SearchUsersAsync(new UserSearch(luceneQuery, page, UserPaging.PageSize), cancellationToken);

	// One request for the Role list and one for Admin's members, never one per User. CachedManagementApi keeps both for a short
	// time and drops the members when a Role write makes them stale, so this doesn't cache them a second time.
	private async Task<Result<AdminIds>> FindAdminIdsAsync(CancellationToken cancellationToken)
	{
		Result<IReadOnlyList<RoleSummary>> roles = await _managementApi.ListRolesAsync(cancellationToken).ConfigureAwait(false);
		if (roles.Failure)
		{
			return FailedWith<AdminIds>(roles);
		}

		RoleSummary? admin = roles.Value!.FirstOrDefault(role =>
			string.Equals(role.Name, ApplicationConstants.AdminRole, StringComparison.Ordinal));
		if (admin is null)
		{
			return Result.Ok(new AdminIds(ImmutableHashSet<string>.Empty, false));
		}

		Result<RoleMembers> members = await _managementApi.ListRoleMembersAsync(admin.Id, cancellationToken)
			.ConfigureAwait(false);
		if (members.Failure)
		{
			return FailedWith<AdminIds>(members);
		}

		return Result.Ok(new AdminIds(members.Value!.Users.Select(user => user.Id).ToImmutableHashSet(StringComparer.Ordinal),
			members.Value.Truncated));
	}

	private static Result<T> FailedWith<T>(Result failure) =>
		Result.Fail<T>(failure.Error ?? string.Empty, failure.ErrorCode, failure.Details);

	private sealed record AdminIds(ImmutableHashSet<string> Ids, bool Truncated);
}
