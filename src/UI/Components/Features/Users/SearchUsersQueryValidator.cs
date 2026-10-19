// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     SearchUsersQueryValidator.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI
// =============================================

using FluentValidation;

namespace UI.Components.Features.Users;

/// <summary>
///   Accepts a <see cref="SearchUsersQuery" /> whose trimmed text is at most 100 characters and whose page is at least 1.
/// </summary>
public sealed class SearchUsersQueryValidator : AbstractValidator<SearchUsersQuery>
{
	/// <summary>
	///   Initializes a new instance of <see cref="SearchUsersQueryValidator" />.
	/// </summary>
	public SearchUsersQueryValidator()
	{
		throw new NotImplementedException();
	}
}
