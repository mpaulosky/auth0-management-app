// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     IManagementApi.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI
// =============================================

using Domain.Abstractions;

namespace UI.ManagementApi;

/// <summary>
///   The one interface the Users and Roles slices call to reach Auth0's Management API. Expected failures come back
///   as a failed <see cref="Result" /> with a stable code in <see cref="Result.Details" />.
/// </summary>
public interface IManagementApi
{
	/// <summary>
	///   Searches the Tenant's Users, one page at a time.
	/// </summary>
	/// <param name="search">The query, 1-based page and page size.</param>
	/// <param name="cancellationToken">A token that cancels the call.</param>
	/// <returns>The page of Users and Auth0's real total.</returns>
	Task<Result<UserPage>> SearchUsersAsync(UserSearch search, CancellationToken cancellationToken);

	/// <summary>
	///   Gets one User with their Profile Fields and Roles.
	/// </summary>
	/// <param name="userId">The User's Auth0 identifier.</param>
	/// <param name="cancellationToken">A token that cancels the call.</param>
	/// <returns>The User's details.</returns>
	Task<Result<UserDetails>> GetUserAsync(string userId, CancellationToken cancellationToken);

	/// <summary>
	///   Changes the Profile Fields named by <paramref name="change" />.
	/// </summary>
	/// <param name="userId">The User's Auth0 identifier.</param>
	/// <param name="change">The fields to change: <see langword="null" /> leaves one alone, and an empty string clears it.</param>
	/// <param name="cancellationToken">A token that cancels the call.</param>
	/// <returns>Whether Auth0 accepted the change.</returns>
	Task<Result> UpdateProfileFieldsAsync(string userId, ProfileFieldsChange change, CancellationToken cancellationToken);

	/// <summary>
	///   Assigns a Role to a User.
	/// </summary>
	/// <param name="userId">The User's Auth0 identifier.</param>
	/// <param name="roleId">The Role's Auth0 identifier.</param>
	/// <param name="cancellationToken">A token that cancels the call.</param>
	/// <returns>Whether Auth0 accepted the assignment.</returns>
	Task<Result> AssignRoleAsync(string userId, string roleId, CancellationToken cancellationToken);

	/// <summary>
	///   Removes a Role from a User.
	/// </summary>
	/// <param name="userId">The User's Auth0 identifier.</param>
	/// <param name="roleId">The Role's Auth0 identifier.</param>
	/// <param name="cancellationToken">A token that cancels the call.</param>
	/// <returns>Whether Auth0 accepted the removal.</returns>
	Task<Result> RemoveRoleAsync(string userId, string roleId, CancellationToken cancellationToken);

	/// <summary>
	///   Lists every Role in the Tenant.
	/// </summary>
	/// <param name="cancellationToken">A token that cancels the call.</param>
	/// <returns>The Roles.</returns>
	Task<Result<IReadOnlyList<RoleSummary>>> ListRolesAsync(CancellationToken cancellationToken);

	/// <summary>
	///   Creates a Role.
	/// </summary>
	/// <param name="role">The new Role's name and description.</param>
	/// <param name="cancellationToken">A token that cancels the call.</param>
	/// <returns>The created Role.</returns>
	Task<Result<RoleSummary>> CreateRoleAsync(NewRole role, CancellationToken cancellationToken);

	/// <summary>
	///   Lists the Users who hold a Role, up to 1000 of them.
	/// </summary>
	/// <param name="roleId">The Role's Auth0 identifier.</param>
	/// <param name="cancellationToken">A token that cancels the call.</param>
	/// <returns>The members fetched, and whether there were more.</returns>
	Task<Result<RoleMembers>> ListRoleMembersAsync(string roleId, CancellationToken cancellationToken);

	/// <summary>
	///   Counts the Users who hold a Role, stopping once <paramref name="atMost" /> have been seen. Never cached.
	/// </summary>
	/// <param name="roleId">The Role's Auth0 identifier.</param>
	/// <param name="atMost">The count to stop at.</param>
	/// <param name="cancellationToken">A token that cancels the call.</param>
	/// <returns>The smaller of the member count and <paramref name="atMost" />.</returns>
	Task<Result<int>> CountRoleMembersAsync(string roleId, int atMost, CancellationToken cancellationToken);

	/// <summary>
	///   Checks whether a User holds a Role, paging through all of the User's Roles. Never cached.
	/// </summary>
	/// <param name="userId">The User's Auth0 identifier.</param>
	/// <param name="roleId">The Role's Auth0 identifier.</param>
	/// <param name="cancellationToken">A token that cancels the call.</param>
	/// <returns>Whether the User holds the Role.</returns>
	Task<Result<bool>> UserHoldsRoleAsync(string userId, string roleId, CancellationToken cancellationToken);
}
