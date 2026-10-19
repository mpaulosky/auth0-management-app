// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     SearchUsersHandlerTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI.Tests.Unit
// =============================================

using Domain.Abstractions;

using UI.Components.Features.Users;
using UI.ManagementApi;

namespace UI.Tests.Unit.Components.Features.Users;

public class SearchUsersHandlerTests
{
	private readonly IManagementApi _api = Substitute.For<IManagementApi>();
	private readonly SearchUsersHandler _sut;

	public SearchUsersHandlerTests()
	{
		_sut = new SearchUsersHandler(_api, new SearchUsersQueryValidator());
		_api.SearchUsersAsync(Arg.Any<UserSearch>(), Arg.Any<CancellationToken>())
			.Returns(Task.FromResult(Result.Ok(new UserPage(UsersOf(1), 1))));
		_api.ListRolesAsync(Arg.Any<CancellationToken>())
			.Returns(Task.FromResult(Result.Ok<IReadOnlyList<RoleSummary>>([new RoleSummary("role-admin", "Admin", null)])));
		_api.ListRoleMembersAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
			.Returns(Task.FromResult(Result.Ok(new RoleMembers([], false))));
	}

	[Fact]
	public async Task HandleAsync_ValidQuery_ReturnsTheUsersTheTotalAndThePage()
	{
		// Arrange
		UserSummary[] users = UsersOf(3);
		_api.SearchUsersAsync(Arg.Any<UserSearch>(), Arg.Any<CancellationToken>())
			.Returns(Task.FromResult(Result.Ok(new UserPage(users, 60))));

		// Act
		Result<UserListPage> result = await _sut.HandleAsync(new SearchUsersQuery("jane", 2), Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Success.Should().BeTrue();
		result.Value!.Users.Should().Equal(users);
		result.Value.Total.Should().Be(60);
		result.Value.Page.Should().Be(2);
		result.Value.PageCount.Should().Be(3);
		result.Value.ShowsCapNote.Should().BeFalse();
	}

	[Fact]
	public async Task HandleAsync_TextQuery_SendsTheBuiltQueryTwentyFiveToAPage()
	{
		// Arrange

		// Act
		await _sut.HandleAsync(new SearchUsersQuery("Jane  Doe", 1), Xunit.TestContext.Current.CancellationToken);

		// Assert
		await _api.Received(1).SearchUsersAsync(
			Arg.Is<UserSearch>(search => search.Query == UserSearchQueryBuilder.Build("Jane  Doe") && search.Page == 1 &&
			                             search.PerPage == 25),
			Arg.Any<CancellationToken>());
	}

	[Theory]
	[InlineData(null)]
	[InlineData("")]
	[InlineData("   ")]
	public async Task HandleAsync_EmptyBox_SendsNoQuery(string? text)
	{
		// Arrange

		// Act
		await _sut.HandleAsync(new SearchUsersQuery(text, 1), Xunit.TestContext.Current.CancellationToken);

		// Assert
		await _api.Received(1).SearchUsersAsync(Arg.Is<UserSearch>(search => search.Query == null), Arg.Any<CancellationToken>());
	}

	[Fact]
	public async Task HandleAsync_AnyQuery_PassesTheCancellationTokenToTheManagementApi()
	{
		// Arrange
		using CancellationTokenSource source = CancellationTokenSource.CreateLinkedTokenSource(Xunit.TestContext.Current.CancellationToken);

		// Act
		await _sut.HandleAsync(new SearchUsersQuery("jane", 1), source.Token);

		// Assert
		await _api.Received().SearchUsersAsync(Arg.Any<UserSearch>(), source.Token);
		await _api.Received().ListRolesAsync(source.Token);
	}

	[Theory]
	[InlineData(0)]
	[InlineData(-5)]
	public async Task HandleAsync_PageBelowOne_FailsWithSearchInvalidBeforeAnyRequest(int page)
	{
		// Arrange

		// Act
		Result<UserListPage> result = await _sut.HandleAsync(new SearchUsersQuery("jane", page), Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Failure.Should().BeTrue();
		result.ErrorCode.Should().Be(ResultErrorCode.Validation);
		result.Details.Should().Be("User.SearchInvalid");
		_api.ReceivedCalls().Should().BeEmpty();
	}

	[Fact]
	public async Task HandleAsync_QueryOverOneHundredCharacters_FailsWithSearchInvalidBeforeAnyRequest()
	{
		// Arrange
		SearchUsersQuery query = new(new string('a', 101), 1);

		// Act
		Result<UserListPage> result = await _sut.HandleAsync(query, Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Failure.Should().BeTrue();
		result.ErrorCode.Should().Be(ResultErrorCode.Validation);
		result.Details.Should().Be("User.SearchInvalid");
		result.Error.Should().NotBeNullOrWhiteSpace();
		_api.ReceivedCalls().Should().BeEmpty();
	}

	[Theory]
	[InlineData(41)]
	[InlineData(1000)]
	[InlineData(int.MaxValue)]
	public async Task HandleAsync_PagePastTheCap_RequestsPageFortyAndNeverThePageAsked(int page)
	{
		// Arrange
		_api.SearchUsersAsync(Arg.Any<UserSearch>(), Arg.Any<CancellationToken>())
			.Returns(Task.FromResult(Result.Ok(new UserPage(UsersOf(25), 5000))));

		// Act
		Result<UserListPage> result = await _sut.HandleAsync(new SearchUsersQuery(null, page), Xunit.TestContext.Current.CancellationToken);

		// Assert
		await _api.Received(1).SearchUsersAsync(Arg.Any<UserSearch>(), Arg.Any<CancellationToken>());
		await _api.Received(1).SearchUsersAsync(Arg.Is<UserSearch>(search => search.Page == 40), Arg.Any<CancellationToken>());
		result.Success.Should().BeTrue();
		result.Value!.Page.Should().Be(40);
		result.Value.PageCount.Should().Be(40);
	}

	[Fact]
	public async Task HandleAsync_PageWithinTheResults_MakesOneSearchRequest()
	{
		// Arrange
		_api.SearchUsersAsync(Arg.Any<UserSearch>(), Arg.Any<CancellationToken>())
			.Returns(Task.FromResult(Result.Ok(new UserPage(UsersOf(25), 60))));

		// Act
		await _sut.HandleAsync(new SearchUsersQuery("jane", 3), Xunit.TestContext.Current.CancellationToken);

		// Assert
		await _api.Received(1).SearchUsersAsync(Arg.Any<UserSearch>(), Arg.Any<CancellationToken>());
	}

	[Fact]
	public async Task HandleAsync_PageOvershootsTheTotal_RequestsTheLastReachablePageInstead()
	{
		// Arrange
		UserSummary[] lastPageUsers = UsersOf(10);
		_api.SearchUsersAsync(Arg.Is<UserSearch>(search => search.Page == 7), Arg.Any<CancellationToken>())
			.Returns(Task.FromResult(Result.Ok(new UserPage([], 60))));
		_api.SearchUsersAsync(Arg.Is<UserSearch>(search => search.Page == 3), Arg.Any<CancellationToken>())
			.Returns(Task.FromResult(Result.Ok(new UserPage(lastPageUsers, 60))));

		// Act
		Result<UserListPage> result = await _sut.HandleAsync(new SearchUsersQuery("jane", 7), Xunit.TestContext.Current.CancellationToken);

		// Assert
		await _api.Received(2).SearchUsersAsync(Arg.Any<UserSearch>(), Arg.Any<CancellationToken>());
		await _api.Received(1).SearchUsersAsync(Arg.Is<UserSearch>(search => search.Page == 3), Arg.Any<CancellationToken>());
		result.Success.Should().BeTrue();
		result.Value!.Page.Should().Be(3);
		result.Value.PageCount.Should().Be(3);
		result.Value.Users.Should().Equal(lastPageUsers);
	}

	[Fact]
	public async Task HandleAsync_PageOvershootsAnEmptySearch_RequestsPageOneInstead()
	{
		// Arrange
		_api.SearchUsersAsync(Arg.Is<UserSearch>(search => search.Page == 5), Arg.Any<CancellationToken>())
			.Returns(Task.FromResult(Result.Ok(new UserPage([], 0))));
		_api.SearchUsersAsync(Arg.Is<UserSearch>(search => search.Page == 1), Arg.Any<CancellationToken>())
			.Returns(Task.FromResult(Result.Ok(new UserPage([], 0))));

		// Act
		Result<UserListPage> result = await _sut.HandleAsync(new SearchUsersQuery("nobody", 5), Xunit.TestContext.Current.CancellationToken);

		// Assert
		await _api.Received(1).SearchUsersAsync(Arg.Is<UserSearch>(search => search.Page == 1), Arg.Any<CancellationToken>());
		result.Success.Should().BeTrue();
		result.Value!.Page.Should().Be(1);
		result.Value.PageCount.Should().Be(1);
		result.Value.Total.Should().Be(0);
		result.Value.Users.Should().BeEmpty();
	}

	[Theory]
	[InlineData(1000, false)]
	[InlineData(1001, true)]
	[InlineData(5000, true)]
	public async Task HandleAsync_Total_ShowsTheCapNoteOnlyOverOneThousand(int total, bool expected)
	{
		// Arrange
		_api.SearchUsersAsync(Arg.Any<UserSearch>(), Arg.Any<CancellationToken>())
			.Returns(Task.FromResult(Result.Ok(new UserPage(UsersOf(25), total))));

		// Act
		Result<UserListPage> result = await _sut.HandleAsync(new SearchUsersQuery(null, 1), Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Value!.ShowsCapNote.Should().Be(expected);
		result.Value.Total.Should().Be(total);
	}

	[Fact]
	public async Task HandleAsync_UsersHoldAdmin_ReturnsTheirIdsFromOneListRoleMembersCallForAdmin()
	{
		// Arrange
		UserSummary[] users = UsersOf(25);
		_api.SearchUsersAsync(Arg.Any<UserSearch>(), Arg.Any<CancellationToken>())
			.Returns(Task.FromResult(Result.Ok(new UserPage(users, 25))));
		_api.ListRolesAsync(Arg.Any<CancellationToken>()).Returns(Task.FromResult(Result.Ok<IReadOnlyList<RoleSummary>>(
		[
			new RoleSummary("role-editor", "Editor", null),
			new RoleSummary("role-admin", "Admin", "Runs the Tenant"),
		])));
		_api.ListRoleMembersAsync("role-admin", Arg.Any<CancellationToken>())
			.Returns(Task.FromResult(Result.Ok(new RoleMembers([users[1], users[7]], false))));

		// Act
		Result<UserListPage> result = await _sut.HandleAsync(new SearchUsersQuery(null, 1), Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Success.Should().BeTrue();
		result.Value!.AdminIds.Should().BeEquivalentTo(users[1].Id, users[7].Id);
		await _api.Received(1).ListRolesAsync(Arg.Any<CancellationToken>());
		await _api.Received(1).ListRoleMembersAsync(Arg.Any<string>(), Arg.Any<CancellationToken>());
		await _api.Received(1).ListRoleMembersAsync("role-admin", Arg.Any<CancellationToken>());
	}

	[Fact]
	public async Task HandleAsync_ManyUsers_NeverMakesAPerUserRequest()
	{
		// Arrange
		_api.SearchUsersAsync(Arg.Any<UserSearch>(), Arg.Any<CancellationToken>())
			.Returns(Task.FromResult(Result.Ok(new UserPage(UsersOf(25), 25))));

		// Act
		await _sut.HandleAsync(new SearchUsersQuery(null, 1), Xunit.TestContext.Current.CancellationToken);

		// Assert
		await _api.DidNotReceiveWithAnyArgs().GetUserAsync(default!, Arg.Any<CancellationToken>());
		await _api.DidNotReceiveWithAnyArgs().UserHoldsRoleAsync(default!, default!, Arg.Any<CancellationToken>());
		await _api.DidNotReceiveWithAnyArgs().CountRoleMembersAsync(default!, default, Arg.Any<CancellationToken>());
	}

	[Fact]
	public async Task HandleAsync_TenantHasNoAdminRole_HasNoAdminIdsAndListsNoRoleMembers()
	{
		// Arrange
		_api.ListRolesAsync(Arg.Any<CancellationToken>()).Returns(Task.FromResult(
			Result.Ok<IReadOnlyList<RoleSummary>>([new RoleSummary("role-editor", "Editor", null)])));

		// Act
		Result<UserListPage> result = await _sut.HandleAsync(new SearchUsersQuery(null, 1), Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Success.Should().BeTrue();
		result.Value!.AdminIds.Should().BeEmpty();
		await _api.DidNotReceiveWithAnyArgs().ListRoleMembersAsync(default!, Arg.Any<CancellationToken>());
	}

	[Theory]
	[InlineData("User.SearchTooBroad", ResultErrorCode.Validation)]
	[InlineData("User.SearchInvalid", ResultErrorCode.Validation)]
	[InlineData("ManagementApi.RateLimited", ResultErrorCode.RateLimited)]
	public async Task HandleAsync_SearchFails_ReturnsTheSameErrorCodeCategoryAndMessage(string code, ResultErrorCode category)
	{
		// Arrange
		_api.SearchUsersAsync(Arg.Any<UserSearch>(), Arg.Any<CancellationToken>())
			.Returns(Task.FromResult(Result.Fail<UserPage>("Auth0 said no.", category, code)));

		// Act
		Result<UserListPage> result = await _sut.HandleAsync(new SearchUsersQuery("jane", 1), Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Failure.Should().BeTrue();
		result.ErrorCode.Should().Be(category);
		result.Details.Should().Be(code);
		result.Error.Should().Be("Auth0 said no.");
	}

	[Fact]
	public async Task HandleAsync_RoleListFails_ReturnsItsErrorAndListsNoRoleMembers()
	{
		// Arrange
		_api.ListRolesAsync(Arg.Any<CancellationToken>()).Returns(Task.FromResult(
			Result.Fail<IReadOnlyList<RoleSummary>>("Try again in 3 seconds.", ResultErrorCode.RateLimited, "ManagementApi.RateLimited")));

		// Act
		Result<UserListPage> result = await _sut.HandleAsync(new SearchUsersQuery(null, 1), Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Failure.Should().BeTrue();
		result.ErrorCode.Should().Be(ResultErrorCode.RateLimited);
		result.Details.Should().Be("ManagementApi.RateLimited");
		result.Error.Should().Be("Try again in 3 seconds.");
		await _api.DidNotReceiveWithAnyArgs().ListRoleMembersAsync(default!, Arg.Any<CancellationToken>());
	}

	[Fact]
	public async Task HandleAsync_AdminMembersFail_ReturnsTheirError()
	{
		// Arrange
		_api.ListRoleMembersAsync("role-admin", Arg.Any<CancellationToken>()).Returns(Task.FromResult(
			Result.Fail<RoleMembers>("Try again in 3 seconds.", ResultErrorCode.RateLimited, "ManagementApi.RateLimited")));

		// Act
		Result<UserListPage> result = await _sut.HandleAsync(new SearchUsersQuery(null, 1), Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Failure.Should().BeTrue();
		result.ErrorCode.Should().Be(ResultErrorCode.RateLimited);
		result.Details.Should().Be("ManagementApi.RateLimited");
	}

	[Fact]
	public async Task HandleAsync_LastReachablePageFailsAfterAnOvershoot_ReturnsItsErrorAndLooksUpNoRoles()
	{
		// Arrange
		_api.SearchUsersAsync(Arg.Is<UserSearch>(search => search.Page == 7), Arg.Any<CancellationToken>())
			.Returns(Task.FromResult(Result.Ok(new UserPage([], 60))));
		_api.SearchUsersAsync(Arg.Is<UserSearch>(search => search.Page == 3), Arg.Any<CancellationToken>())
			.Returns(Task.FromResult(Result.Fail<UserPage>("Try again in 3 seconds.", ResultErrorCode.RateLimited, "ManagementApi.RateLimited")));

		// Act
		Result<UserListPage> result = await _sut.HandleAsync(new SearchUsersQuery("jane", 7), Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Failure.Should().BeTrue();
		result.Details.Should().Be("ManagementApi.RateLimited");
		await _api.DidNotReceive().ListRolesAsync(Arg.Any<CancellationToken>());
	}

	private static UserSummary[] UsersOf(int count) =>
		[.. Enumerable.Range(1, count).Select(index => new UserSummary($"auth0|user-{index}", $"User {index}", $"user{index}@example.com", null, "Username-Password-Authentication"))];
}
