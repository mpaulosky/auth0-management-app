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
	///   The error code of every failure this validator reports.
	/// </summary>
	public const string SearchInvalid = "User.SearchInvalid";

	/// <summary>
	///   The longest search text, after trimming.
	/// </summary>
	public const int MaxQueryLength = 100;

	/// <summary>
	///   Initializes a new instance of <see cref="SearchUsersQueryValidator" />.
	/// </summary>
	public SearchUsersQueryValidator()
	{
		RuleFor(query => query.Query)
			.Must(text => text is null || text.Trim().Length <= MaxQueryLength)
			.WithErrorCode(SearchInvalid)
			.WithMessage($"Search for at most {MaxQueryLength} characters.");

		RuleFor(query => query.Page)
			.GreaterThanOrEqualTo(1)
			.WithErrorCode(SearchInvalid)
			.WithMessage("The page must be 1 or more.");
	}
}
