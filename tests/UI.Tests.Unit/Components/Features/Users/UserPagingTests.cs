// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     UserPagingTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI.Tests.Unit
// =============================================

using UI.Components.Features.Users;

namespace UI.Tests.Unit.Components.Features.Users;

public class UserPagingTests
{
	[Theory]
	[InlineData(0, 1)]
	[InlineData(1, 1)]
	[InlineData(24, 1)]
	[InlineData(25, 1)]
	[InlineData(26, 2)]
	[InlineData(50, 2)]
	[InlineData(51, 3)]
	[InlineData(975, 39)]
	[InlineData(976, 40)]
	[InlineData(1000, 40)]
	public void ReachablePageCount_TotalUpToTheCap_IsTheTotalOverTwentyFiveRoundedUp(int total, int expected)
	{
		// Arrange

		// Act
		int pages = UserPaging.ReachablePageCount(total);

		// Assert
		pages.Should().Be(expected);
	}

	[Theory]
	[InlineData(1001)]
	[InlineData(1500)]
	[InlineData(5000)]
	[InlineData(int.MaxValue)]
	public void ReachablePageCount_TotalOverOneThousand_IsFortyBecauseAuth0SearchesOnlyTheFirstThousand(int total)
	{
		// Arrange

		// Act
		int pages = UserPaging.ReachablePageCount(total);

		// Assert
		pages.Should().Be(40);
	}

	[Fact]
	public void ReachablePageCount_NoMatches_IsOnePageNotZero()
	{
		// Arrange

		// Act
		int pages = UserPaging.ReachablePageCount(0);

		// Assert
		pages.Should().Be(1);
	}
}
