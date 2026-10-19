// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     ProfileField.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI
// =============================================

namespace UI.ManagementApi;

/// <summary>
///   The Profile Fields an Admin can change.
/// </summary>
[Flags]
public enum ProfileField
{
	/// <summary>
	///   No field.
	/// </summary>
	None = 0,

	/// <summary>
	///   The User's name.
	/// </summary>
	Name = 1,

	/// <summary>
	///   The User's given name.
	/// </summary>
	GivenName = 2,

	/// <summary>
	///   The User's family name.
	/// </summary>
	FamilyName = 4,

	/// <summary>
	///   The User's nickname.
	/// </summary>
	Nickname = 8,

	/// <summary>
	///   The URL of the User's picture.
	/// </summary>
	Picture = 16,

	/// <summary>
	///   The User's email address.
	/// </summary>
	Email = 32
}
