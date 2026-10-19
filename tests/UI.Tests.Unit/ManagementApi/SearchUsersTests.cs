// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     SearchUsersTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI.Tests.Unit
// =============================================

using Domain.Abstractions;

using UI.ManagementApi;

namespace UI.Tests.Unit.ManagementApi;

public class SearchUsersTests
{
	[Theory]
	[InlineData(1, "0")]
	[InlineData(3, "2")]
	public async Task SearchUsersAsync_Query_SendsZeroBasedPageAndTheFixedSearchParameters(int page, string expectedPage)
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		harness.Handler.Respond(_ => Auth0Responses.Json(Auth0Responses.UsersPage(1234, "auth0|1", "auth0|2")));

		// Act
		Result<UserPage> result = await harness.Api.SearchUsersAsync(
			new UserSearch("email:ja* OR name:ja*", page, 25), Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Success.Should().BeTrue();
		RecordedRequest request = harness.Handler.ManagementRequests.Should().ContainSingle().Subject;
		request.Method.Should().Be(HttpMethod.Get);
		request.Path.Should().Be("/api/v2/users");
		request.Query["page"].Should().Be(expectedPage);
		request.Query["per_page"].Should().Be("25");
		request.Query["include_totals"].Should().Be("true");
		request.Query["search_engine"].Should().Be("v3");
		request.Query["sort"].Should().Be("name:1");
		request.Query["q"].Should().Be("email:ja* OR name:ja*");
	}

	[Theory]
	[InlineData(41, 25)]
	[InlineData(11, 100)]
	[InlineData(1, 101)]
	[InlineData(1, 0)]
	public async Task SearchUsersAsync_PagePastAuth0sWindowOrPerPageOutOfRange_ThrowsWithoutCallingAuth0(int page, int perPage)
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		harness.Handler.Respond(_ => Auth0Responses.Json(Auth0Responses.UsersPage(0)));

		// Act
		Func<Task> act = () => harness.Api.SearchUsersAsync(
			new UserSearch("name:ja*", page, perPage), Xunit.TestContext.Current.CancellationToken);

		// Assert
		await act.Should().ThrowAsync<ArgumentOutOfRangeException>();
		harness.Handler.Requests.Should().BeEmpty("Auth0 would answer a 400 that reads as invalid search text");
	}

	[Theory]
	[InlineData(40, 25)]
	[InlineData(10, 100)]
	public async Task SearchUsersAsync_LastPageInAuth0sWindow_Searches(int page, int perPage)
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		harness.Handler.Respond(_ => Auth0Responses.Json(Auth0Responses.UsersPage(5000, "auth0|1")));

		// Act
		Result<UserPage> result = await harness.Api.SearchUsersAsync(
			new UserSearch("name:ja*", page, perPage), Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Success.Should().BeTrue();
		harness.Handler.ManagementRequests.Should().ContainSingle();
	}

	[Fact]
	public async Task SearchUsersAsync_NullQuery_SendsNoQ()
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		harness.Handler.Respond(_ => Auth0Responses.Json(Auth0Responses.UsersPage(0)));

		// Act
		Result<UserPage> result = await harness.Api.SearchUsersAsync(
			new UserSearch(null, 1, 25), Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Success.Should().BeTrue();
		RecordedRequest request = harness.Handler.ManagementRequests.Should().ContainSingle().Subject;
		request.Query.AllKeys.Should().NotContain("q");
	}

	[Fact]
	public async Task SearchUsersAsync_TotalOverOneThousand_ReturnsAuth0sRealTotalAndOurRecords()
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		harness.Handler.Respond(_ => Auth0Responses.Json(Auth0Responses.UsersPage(1234, "auth0|1", "auth0|2")));

		// Act
		Result<UserPage> result = await harness.Api.SearchUsersAsync(
			new UserSearch(null, 1, 25), Xunit.TestContext.Current.CancellationToken);

		// Assert
		UserPage page = ApiCalls.ValueOf(result);
		page.Total.Should().Be(1234);
		page.Users.Should().HaveCount(2);
		UserSummary first = page.Users[0];
		first.Id.Should().Be("auth0|1");
		first.Name.Should().Be("Name auth0|1");
		first.Email.Should().Be("auth0-1@example.test");
		first.Picture.Should().Be("https://example.test/p.png");
		first.Connection.Should().Be("Username-Password-Authentication");
	}

	[Fact]
	public async Task SearchUsersAsync_NoMatches_ReturnsAnEmptyPageWithTotalZero()
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		harness.Handler.Respond(_ => Auth0Responses.Json(Auth0Responses.UsersPage(0)));

		// Act
		Result<UserPage> result = await harness.Api.SearchUsersAsync(
			new UserSearch("name:zz*", 1, 25), Xunit.TestContext.Current.CancellationToken);

		// Assert
		UserPage page = ApiCalls.ValueOf(result);
		page.Users.Should().BeEmpty();
		page.Total.Should().Be(0);
	}
}
