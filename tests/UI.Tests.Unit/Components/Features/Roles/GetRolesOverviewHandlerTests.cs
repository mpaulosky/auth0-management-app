// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     GetRolesOverviewHandlerTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI.Tests.Unit
// =============================================

using Domain.Abstractions;

using UI.Components.Features.Roles;
using UI.ManagementApi;

using static UI.Tests.Unit.Components.Features.Roles.RolesTestData;

namespace UI.Tests.Unit.Components.Features.Roles;

public class GetRolesOverviewHandlerTests
{
	private readonly IManagementApi _api = Tenant();
	private readonly GetRolesOverviewHandler _sut;

	public GetRolesOverviewHandlerTests()
	{
		_sut = new GetRolesOverviewHandler(_api);
	}

	[Fact]
	public async Task HandleAsync_NoRolePicked_ReturnsATilePerRoleInTheOrderTheTenantListsThem()
	{
		// Arrange

		// Act
		Result<RolesOverview> result = await _sut.HandleAsync(new GetRolesOverviewQuery(null), Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Success.Should().BeTrue();
		result.Value!.Tiles.Select(tile => tile.Role).Should().Equal(AdminRole, EditorRole, ViewerRole);
		result.Value.SelectedRoleId.Should().BeNull();
	}

	[Fact]
	public async Task HandleAsync_NoRolePicked_TilesCountTheUsersWhoHoldEachRole()
	{
		// Arrange

		// Act
		Result<RolesOverview> result = await _sut.HandleAsync(new GetRolesOverviewQuery(null), Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Value!.Tiles.Select(tile => tile.Members).Should().Equal(1, 2, 0);
		result.Value.Tiles.Should().OnlyContain(tile => !tile.Truncated);
	}

	[Fact]
	public async Task HandleAsync_RoleWithMoreThanTheCapOfMembers_TileIsTruncated()
	{
		// Arrange
		_api.ListRoleMembersAsync(EditorRole.Id, Arg.Any<CancellationToken>()).Returns(TruncatedMembers(Jane, Bob));

		// Act
		Result<RolesOverview> result = await _sut.HandleAsync(new GetRolesOverviewQuery(null), Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Value!.Tiles.Select(tile => tile.Truncated).Should().Equal(false, true, false);
	}

	[Fact]
	public async Task HandleAsync_NoRolePicked_ListsTheFirstPageOfUsersFromTheSearch()
	{
		// Arrange

		// Act
		Result<RolesOverview> result = await _sut.HandleAsync(new GetRolesOverviewQuery(null), Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Value!.Rows.Select(row => row.User).Should().Equal(Jane, Bob, Cy);
		await _api.Received(1).SearchUsersAsync(Arg.Is<UserSearch>(search => search.Query == null && search.Page == 1),
			Arg.Any<CancellationToken>());
	}

	[Fact]
	public async Task HandleAsync_NoRolePicked_MarksEachRoleAUserHoldsInTileOrder()
	{
		// Arrange

		// Act
		Result<RolesOverview> result = await _sut.HandleAsync(new GetRolesOverviewQuery(null), Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Value!.Rows.Select(row => row.Holdings).Should().SatisfyRespectively(
			jane => jane.Should().Equal(RoleHolding.Yes, RoleHolding.Yes, RoleHolding.No),
			bob => bob.Should().Equal(RoleHolding.No, RoleHolding.Yes, RoleHolding.No),
			cy => cy.Should().Equal(RoleHolding.No, RoleHolding.No, RoleHolding.No));
	}

	[Fact]
	public async Task HandleAsync_TruncatedRole_UserOutsideTheFetchedMembersIsUnknownForThatRole()
	{
		// Arrange
		_api.ListRoleMembersAsync(EditorRole.Id, Arg.Any<CancellationToken>()).Returns(TruncatedMembers(Jane));

		// Act
		Result<RolesOverview> result = await _sut.HandleAsync(new GetRolesOverviewQuery(null), Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Value!.Rows.Select(row => row.Holdings).Should().SatisfyRespectively(
			jane => jane.Should().Equal(RoleHolding.Yes, RoleHolding.Yes, RoleHolding.No),
			bob => bob.Should().Equal(RoleHolding.No, RoleHolding.Unknown, RoleHolding.No),
			cy => cy.Should().Equal(RoleHolding.No, RoleHolding.Unknown, RoleHolding.No));
	}

	[Fact]
	public async Task HandleAsync_RolePicked_ListsOnlyThatRolesMembersWithoutSearching()
	{
		// Arrange

		// Act
		Result<RolesOverview> result = await _sut.HandleAsync(new GetRolesOverviewQuery(EditorRole.Id), Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Value!.SelectedRoleId.Should().Be(EditorRole.Id);
		result.Value.Rows.Select(row => row.User).Should().Equal(Jane, Bob);
		await _api.DidNotReceive().SearchUsersAsync(Arg.Any<UserSearch>(), Arg.Any<CancellationToken>());
	}

	[Fact]
	public async Task HandleAsync_RolePicked_RowsStillMarkEveryRoleTheUserHolds()
	{
		// Arrange

		// Act
		Result<RolesOverview> result = await _sut.HandleAsync(new GetRolesOverviewQuery(EditorRole.Id), Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Value!.Rows.Select(row => row.Holdings).Should().SatisfyRespectively(
			jane => jane.Should().Equal(RoleHolding.Yes, RoleHolding.Yes, RoleHolding.No),
			bob => bob.Should().Equal(RoleHolding.No, RoleHolding.Yes, RoleHolding.No));
	}

	[Theory]
	[InlineData(false)]
	[InlineData(true)]
	public async Task HandleAsync_RolePicked_SelectedRoleTruncatedFollowsThePickedRole(bool truncated)
	{
		// Arrange
		_api.ListRoleMembersAsync(EditorRole.Id, Arg.Any<CancellationToken>())
			.Returns(truncated ? TruncatedMembers(Jane, Bob) : Members(Jane, Bob));

		// Act
		Result<RolesOverview> result = await _sut.HandleAsync(new GetRolesOverviewQuery(EditorRole.Id), Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Value!.SelectedRoleTruncated.Should().Be(truncated);
	}

	[Fact]
	public async Task HandleAsync_NoRolePickedAndATruncatedRole_SelectedRoleTruncatedIsFalse()
	{
		// Arrange
		_api.ListRoleMembersAsync(EditorRole.Id, Arg.Any<CancellationToken>()).Returns(TruncatedMembers(Jane, Bob));

		// Act
		Result<RolesOverview> result = await _sut.HandleAsync(new GetRolesOverviewQuery(null), Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Value!.SelectedRoleTruncated.Should().BeFalse();
	}

	[Fact]
	public async Task HandleAsync_PickedRoleIsNotInTheTenant_FailsWithRoleNotFound()
	{
		// Arrange
		_api.ListRoleMembersAsync("rol_gone", Arg.Any<CancellationToken>()).Returns(RoleNotFound<RoleMembers>());

		// Act
		Result<RolesOverview> result = await _sut.HandleAsync(new GetRolesOverviewQuery("rol_gone"), Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Failure.Should().BeTrue();
		result.ErrorCode.Should().Be(ResultErrorCode.NotFound);
		result.Details.Should().Be("Role.NotFound");
	}

	[Theory]
	[InlineData("ListRoles", "ManagementApi.RateLimited")]
	[InlineData("ListRoleMembers", "ManagementApi.RateLimited")]
	[InlineData("ListRoleMembers", "Role.NotFound")]
	[InlineData("Search", "ManagementApi.RateLimited")]
	public async Task HandleAsync_ManagementApiFails_ReturnsThatFailureUnchanged(string failingCall, string code)
	{
		// Arrange
		ResultErrorCode category = code == "Role.NotFound" ? ResultErrorCode.NotFound : ResultErrorCode.RateLimited;
		switch (failingCall)
		{
			case "ListRoles":
				_api.ListRolesAsync(Arg.Any<CancellationToken>())
					.Returns(Result.Fail<IReadOnlyList<RoleSummary>>(RateLimitedMessage, category, code));

				break;
			case "ListRoleMembers":
				_api.ListRoleMembersAsync(EditorRole.Id, Arg.Any<CancellationToken>())
					.Returns(Result.Fail<RoleMembers>(RateLimitedMessage, category, code));

				break;
			default:
				_api.SearchUsersAsync(Arg.Any<UserSearch>(), Arg.Any<CancellationToken>())
					.Returns(Result.Fail<UserPage>(RateLimitedMessage, category, code));

				break;
		}

		// Act
		Result<RolesOverview> result = await _sut.HandleAsync(new GetRolesOverviewQuery(null), Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Failure.Should().BeTrue();
		result.ErrorCode.Should().Be(category);
		result.Details.Should().Be(code);
		result.Error.Should().Be(RateLimitedMessage);
	}
}
