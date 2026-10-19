// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     SearchUsersHandler.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI
// =============================================

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

		Result<IReadOnlySet<string>> adminIds = await FindAdminIdsAsync(cancellationToken).ConfigureAwait(false);
		if (adminIds.Failure)
		{
			return FailedWith<UserListPage>(adminIds);
		}

		UserPage users = search.Value;

		return Result.Ok(new UserListPage(users.Users, users.Total, page, pageCount, users.Total > UserPaging.SearchCap,
			adminIds.Value!));
	}

	private Task<Result<UserPage>> SearchAsync(string? luceneQuery, int page, CancellationToken cancellationToken) =>
		_managementApi.SearchUsersAsync(new UserSearch(luceneQuery, page, UserPaging.PageSize), cancellationToken);

	// One request for the Role list and one for Admin's members, never one per User.
	private async Task<Result<IReadOnlySet<string>>> FindAdminIdsAsync(CancellationToken cancellationToken)
	{
		Result<IReadOnlyList<RoleSummary>> roles = await _managementApi.ListRolesAsync(cancellationToken).ConfigureAwait(false);
		if (roles.Failure)
		{
			return FailedWith<IReadOnlySet<string>>(roles);
		}

		RoleSummary? admin = roles.Value!.FirstOrDefault(role =>
			string.Equals(role.Name, ApplicationConstants.AdminRole, StringComparison.Ordinal));
		if (admin is null)
		{
			return Result.Ok<IReadOnlySet<string>>(new HashSet<string>(StringComparer.Ordinal));
		}

		Result<RoleMembers> members = await _managementApi.ListRoleMembersAsync(admin.Id, cancellationToken)
			.ConfigureAwait(false);
		if (members.Failure)
		{
			return FailedWith<IReadOnlySet<string>>(members);
		}

		return Result.Ok<IReadOnlySet<string>>(members.Value!.Users.Select(user => user.Id)
			.ToHashSet(StringComparer.Ordinal));
	}

	private static Result<T> FailedWith<T>(Result failure) =>
		Result.Fail<T>(failure.Error ?? string.Empty, failure.ErrorCode, failure.Details);
}
