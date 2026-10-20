// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     UserSearchQueryBuilderTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI.Tests.Unit
// =============================================

using UI.Components.Features.Users;

namespace UI.Tests.Unit.Components.Features.Users;

public class UserSearchQueryBuilderTests
{
	[Theory]
	[InlineData("jane", @"email:jane* OR name:jane* OR given_name:jane* OR family_name:jane*")]
	[InlineData("jane@example.com", @"email:jane@example.com* OR name:jane@example.com* OR given_name:jane@example.com* OR family_name:jane@example.com*")]
	public void Build_PlainText_PrefixesEachSearchedField(string input, string expected)
	{
		// Arrange

		// Act
		string? query = UserSearchQueryBuilder.Build(input);

		// Assert
		query.Should().Be(expected);
	}

	[Theory]
	[InlineData("JANE")]
	[InlineData("  jane  ")]
	[InlineData("\t Jane\r\n")]
	public void Build_MixedCaseOrPaddedText_TrimsAndLowerCases(string input)
	{
		// Arrange

		// Act
		string? query = UserSearchQueryBuilder.Build(input);

		// Assert
		query.Should().Be("email:jane* OR name:jane* OR given_name:jane* OR family_name:jane*");
	}

	[Theory]
	[InlineData("Jane  Doe", @"jane\ doe")]
	[InlineData("Jane Doe", @"jane\ doe")]
	[InlineData("jane \t \n doe", @"jane\ doe")]
	[InlineData("a b c", @"a\ b\ c")]
	public void Build_WhitespaceInsideText_BecomesOneEscapedSpace(string input, string term)
	{
		// Arrange

		// Act
		string? query = UserSearchQueryBuilder.Build(input);

		// Assert
		query.Should().Be($"email:{term}* OR name:{term}* OR given_name:{term}* OR family_name:{term}*");
	}

	[Fact]
	public void Build_TwoWordName_KeepsOnePrefixTermPerField()
	{
		// Arrange

		// Act
		string? query = UserSearchQueryBuilder.Build("Jane  Doe");

		// Assert
		query.Should().Contain(@"name:jane\ doe*");
		query.Should().NotContain(" AND ");
	}

	[Theory]
	[InlineData("a+b", @"a\+b")]
	[InlineData("a-b", @"a\-b")]
	[InlineData("a&&b", @"a\&\&b")]
	[InlineData("a||b", @"a\|\|b")]
	[InlineData("a!b", @"a\!b")]
	[InlineData("(a)", @"\(a\)")]
	[InlineData("{a}", @"\{a\}")]
	[InlineData("[a]", @"\[a\]")]
	[InlineData("a^b", @"a\^b")]
	[InlineData("\"a\"", "\\\"a\\\"")]
	[InlineData("a~b", @"a\~b")]
	[InlineData("a*b", @"a\*b")]
	[InlineData("a?b", @"a\?b")]
	[InlineData("a:b", @"a\:b")]
	[InlineData(@"a\b", @"a\\b")]
	[InlineData("a/b", @"a\/b")]
	[InlineData("a=b", @"a\=b")]
	public void Build_LuceneSpecialCharacter_IsEscapedWithBackslash(string input, string term)
	{
		// Arrange

		// Act
		string? query = UserSearchQueryBuilder.Build(input);

		// Assert
		query.Should().Be($"email:{term}* OR name:{term}* OR given_name:{term}* OR family_name:{term}*");
	}

	[Theory]
	[InlineData(">a", "a")]
	[InlineData("<a", "a")]
	[InlineData("a>b", @"a\ b")]
	[InlineData("a < b", @"a\ b")]
	[InlineData("<>a<>", "a")]
	public void Build_AngleBracket_SeparatesWordsInsteadOfOpeningARange(string input, string term)
	{
		// Arrange

		// Act
		string? query = UserSearchQueryBuilder.Build(input);

		// Assert
		query.Should().Be($"email:{term}* OR name:{term}* OR given_name:{term}* OR family_name:{term}*");
	}

	[Theory]
	[InlineData("<")]
	[InlineData(" > < ")]
	public void Build_OnlyAngleBrackets_GivesNoQuery(string input)
	{
		// Arrange

		// Act
		string? query = UserSearchQueryBuilder.Build(input);

		// Assert
		query.Should().BeNull();
	}

	[Fact]
	public void Build_SpecialCharacterAndUpperCase_EscapesAndLowerCases()
	{
		// Arrange

		// Act
		string? query = UserSearchQueryBuilder.Build("Jane (Admin)");

		// Assert
		query.Should().Be(@"email:jane\ \(admin\)* OR name:jane\ \(admin\)* OR given_name:jane\ \(admin\)* OR family_name:jane\ \(admin\)*");
	}

	[Theory]
	[InlineData(null)]
	[InlineData("")]
	[InlineData("   ")]
	[InlineData("\t\r\n")]
	public void Build_EmptyBox_GivesNoQuery(string? input)
	{
		// Arrange

		// Act
		string? query = UserSearchQueryBuilder.Build(input);

		// Assert
		query.Should().BeNull();
	}
}
