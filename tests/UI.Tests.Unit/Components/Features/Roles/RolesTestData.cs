// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     RolesTestData.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI.Tests.Unit
// =============================================

using Domain.Abstractions;

using UI.ManagementApi;

namespace UI.Tests.Unit.Components.Features.Roles;

/// <summary>
///   The Tenant the Roles tests share: three Roles, three Users, and the failures the Management API returns.
/// </summary>
internal static class RolesTestData
{
	public const string RoleNotFoundMessage = "This Role no longer exists in the Tenant.";

	public const string RateLimitedMessage = "Auth0 is rate limiting the app. Try again in 7 seconds.";

	public static readonly RoleSummary AdminRole = new("rol_admin", "Admin", "Manages the Tenant");

	public static readonly RoleSummary EditorRole = new("rol_editor", "Editor", "Edits the content");

	public static readonly RoleSummary ViewerRole = new("rol_viewer", "Viewer", null);

	public static readonly UserSummary Jane = new("auth0|jane", "Jane Doe", "jane@example.com", null, "Username-Password-Authentication");

	public static readonly UserSummary Bob = new("auth0|bob", "Bob Roe", "bob@example.com", null, "Username-Password-Authentication");

	public static readonly UserSummary Cy = new("google-oauth2|cy", "Cy Poe", "cy@example.com", null, "google-oauth2");

	public static Result<T> RoleNotFound<T>() =>
		Result.Fail<T>(RoleNotFoundMessage, ResultErrorCode.NotFound, "Role.NotFound");

	public static Result<T> RateLimited<T>() =>
		Result.Fail<T>(RateLimitedMessage, ResultErrorCode.RateLimited, "ManagementApi.RateLimited");

	public static Result<IReadOnlyList<RoleSummary>> Roles(params RoleSummary[] roles) => Result.Ok<IReadOnlyList<RoleSummary>>(roles);

	public static Result<UserPage> Page(params UserSummary[] users) => Result.Ok(new UserPage(users, users.Length));

	public static Result<RoleMembers> Members(params UserSummary[] users) => Result.Ok(new RoleMembers(users, false));

	/// <summary>
	///   Members of a Role that more than 1000 Users hold, of whom only <paramref name="users" /> were fetched.
	/// </summary>
	public static Result<RoleMembers> TruncatedMembers(params UserSummary[] users) => Result.Ok(new RoleMembers(users, true));

	/// <summary>
	///   Fills a Role's members with <paramref name="count" /> Users, to show a count.
	/// </summary>
	public static Result<RoleMembers> MembersOfCount(int count) => Result.Ok(new RoleMembers(
		[.. Enumerable.Range(1, count).Select(n => new UserSummary($"auth0|member{n}", $"Member {n}", null, null, null))], false));

	/// <summary>
	///   Sets up the Tenant: Admin is held by Jane, Editor by Jane and Bob, and Viewer by nobody; Cy holds no Role.
	///   The first page of the search lists Jane, Bob and Cy.
	/// </summary>
	public static IManagementApi Tenant()
	{
		IManagementApi api = Substitute.For<IManagementApi>();
		api.ListRolesAsync(Arg.Any<CancellationToken>()).Returns(Roles(AdminRole, EditorRole, ViewerRole));
		api.ListRoleMembersAsync(AdminRole.Id, Arg.Any<CancellationToken>()).Returns(Members(Jane));
		api.ListRoleMembersAsync(EditorRole.Id, Arg.Any<CancellationToken>()).Returns(Members(Jane, Bob));
		api.ListRoleMembersAsync(ViewerRole.Id, Arg.Any<CancellationToken>()).Returns(Members());
		api.SearchUsersAsync(Arg.Any<UserSearch>(), Arg.Any<CancellationToken>()).Returns(Page(Jane, Bob, Cy));

		return api;
	}
}
