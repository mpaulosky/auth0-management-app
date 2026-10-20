// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     SearchUsersQueryValidatorTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI.Tests.Unit
// =============================================

using FluentValidation.Results;

using UI.Components.Features.Users;

namespace UI.Tests.Unit.Components.Features.Users;

public class SearchUsersQueryValidatorTests
{
	private readonly SearchUsersQueryValidator _sut = new();

	[Theory]
	[InlineData(null, 1)]
	[InlineData("", 1)]
	[InlineData("jane", 1)]
	[InlineData("jane", 40)]
	[InlineData("jane", 500)]
	public void Validate_ShortQueryAndPositivePage_Succeeds(string? query, int page)
	{
		// Arrange
		SearchUsersQuery request = new(query, page);

		// Act
		ValidationResult result = _sut.Validate(request);

		// Assert
		result.IsValid.Should().BeTrue();
	}

	[Fact]
	public void Validate_QueryOfExactlyOneHundredCharacters_Succeeds()
	{
		// Arrange
		SearchUsersQuery request = new(new string('a', 100), 1);

		// Act
		ValidationResult result = _sut.Validate(request);

		// Assert
		result.IsValid.Should().BeTrue();
	}

	[Fact]
	public void Validate_QueryOfOneHundredCharactersPaddedWithWhitespace_SucceedsBecauseItIsTrimmed()
	{
		// Arrange
		SearchUsersQuery request = new("  " + new string('a', 100) + "  ", 1);

		// Act
		ValidationResult result = _sut.Validate(request);

		// Assert
		result.IsValid.Should().BeTrue();
	}

	[Theory]
	[InlineData(101)]
	[InlineData(500)]
	public void Validate_QueryOverOneHundredCharacters_FailsWithSearchInvalid(int length)
	{
		// Arrange
		SearchUsersQuery request = new(new string('a', length), 1);

		// Act
		ValidationResult result = _sut.Validate(request);

		// Assert
		result.IsValid.Should().BeFalse();
		result.Errors.Should().NotBeEmpty().And.OnlyContain(failure => failure.ErrorCode == "User.SearchInvalid");
	}

	[Theory]
	[InlineData(0)]
	[InlineData(-1)]
	[InlineData(int.MinValue)]
	public void Validate_PageBelowOne_FailsWithSearchInvalid(int page)
	{
		// Arrange
		SearchUsersQuery request = new("jane", page);

		// Act
		ValidationResult result = _sut.Validate(request);

		// Assert
		result.IsValid.Should().BeFalse();
		result.Errors.Should().NotBeEmpty().And.OnlyContain(failure => failure.ErrorCode == "User.SearchInvalid");
	}
}
