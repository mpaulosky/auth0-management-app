// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     ApplicationConstants.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  Domain
// =============================================

namespace Domain.Constants;

/// <summary>
///   Names the app itself relies on, shared by every project in the solution.
/// </summary>
/// <remarks>
///   Keep this list to names more than one project needs. A feature's own names stay in its slice.
///   Split the class by concern if it grows past about a dozen members.
/// </remarks>
public static class ApplicationConstants
{
	/// <summary>
	///   The authorization policy that protects the Admin page.
	/// </summary>
	public const string AdminPolicy = "AdminOnly";

	/// <summary>
	///   The role that makes a User an Admin. Must match the Auth0 role claim.
	/// </summary>
	public const string AdminRole = "Admin";

	/// <summary>
	///   The cookie that holds the visitor's Theme, read during server-side prerender.
	/// </summary>
	public const string ThemeCookie = "theme";

	/// <summary>
	///   The cookie that holds the visitor's Palette.
	/// </summary>
	public const string PaletteCookie = "palette";

	/// <summary>
	///   The Aspire resource name of the UI project, used by the AppHost and the E2E tests.
	/// </summary>
	public const string Website = "WebApp";

	/// <summary>
	///   The app's brand name, shown in the nav, the footer and Home's heading.
	/// </summary>
	public const string AppName = "Auth0 Management App";
}
