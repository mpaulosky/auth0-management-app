// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     ManagementApiRecords.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI
// =============================================

namespace UI.ManagementApi;

/// <summary>
///   A User search: a Lucene query, a 1-based page and a page size.
/// </summary>
/// <param name="Query">The Lucene query sent as <c>q</c>, or <see langword="null" /> to list every User.</param>
/// <param name="Page">The 1-based page number.</param>
/// <param name="PerPage">The page size.</param>
public sealed record UserSearch(string? Query, int Page, int PerPage);

/// <summary>
///   One page of a User search.
/// </summary>
/// <param name="Users">The Users on the page.</param>
/// <param name="Total">Auth0's real total, which can exceed 1000.</param>
public sealed record UserPage(IReadOnlyList<UserSummary> Users, int Total);

/// <summary>
///   A User as a list row shows them.
/// </summary>
/// <param name="Id">The User's Auth0 identifier.</param>
/// <param name="Name">The User's name.</param>
/// <param name="Email">The User's email address.</param>
/// <param name="Picture">The URL of the User's picture.</param>
/// <param name="Connection">The connection the User signs in through.</param>
public sealed record UserSummary(string Id, string? Name, string? Email, string? Picture, string? Connection);

/// <summary>
///   A User with their Profile Fields and Roles.
/// </summary>
/// <param name="Id">The User's Auth0 identifier.</param>
/// <param name="Name">The User's name.</param>
/// <param name="GivenName">The User's given name.</param>
/// <param name="FamilyName">The User's family name.</param>
/// <param name="Nickname">The User's nickname.</param>
/// <param name="Picture">The URL of the User's picture.</param>
/// <param name="Email">The User's email address.</param>
/// <param name="EmailVerified">Whether Auth0 has verified the email address.</param>
/// <param name="Connection">The connection the User signs in through.</param>
/// <param name="LastLogin">When the User last signed in.</param>
/// <param name="EditableFields">The Profile Fields Auth0 will accept a change to.</param>
/// <param name="Roles">The Roles the User holds.</param>
public sealed record UserDetails(
	string Id,
	string? Name,
	string? GivenName,
	string? FamilyName,
	string? Nickname,
	string? Picture,
	string? Email,
	bool EmailVerified,
	string? Connection,
	DateTimeOffset? LastLogin,
	ProfileField EditableFields,
	IReadOnlyList<RoleSummary> Roles);

/// <summary>
///   A change to a User's Profile Fields: <see langword="null" /> leaves a field alone, and an empty string clears it.
/// </summary>
/// <param name="Name">The new name.</param>
/// <param name="GivenName">The new given name.</param>
/// <param name="FamilyName">The new family name.</param>
/// <param name="Nickname">The new nickname.</param>
/// <param name="Picture">The new picture URL.</param>
/// <param name="Email">The new email address.</param>
public sealed record ProfileFieldsChange(
	string? Name = null,
	string? GivenName = null,
	string? FamilyName = null,
	string? Nickname = null,
	string? Picture = null,
	string? Email = null);

/// <summary>
///   A Role in the Tenant.
/// </summary>
/// <param name="Id">The Role's Auth0 identifier.</param>
/// <param name="Name">The Role's name.</param>
/// <param name="Description">The Role's description.</param>
public sealed record RoleSummary(string Id, string Name, string? Description);

/// <summary>
///   A Role to create.
/// </summary>
/// <param name="Name">The Role's name.</param>
/// <param name="Description">The Role's description.</param>
public sealed record NewRole(string Name, string? Description);

/// <summary>
///   The Users who hold a Role.
/// </summary>
/// <param name="Users">The members fetched.</param>
/// <param name="Truncated">Whether more Users hold the Role than the 1000 fetched.</param>
public sealed record RoleMembers(IReadOnlyList<UserSummary> Users, bool Truncated);
